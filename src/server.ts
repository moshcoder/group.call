/**
 * The group.call web server: pages, the JSON API, Sign in with CoinPay (the only
 * way in), the Telnyx webhook that runs the phone line, and CoinPay's webhook
 * for room passes.
 *
 * group.call lives at https://group.call.pit.world. (.call is a real ICANN
 * ending, so it cannot be a Moshpit name; pit.world is ours, so this host is.)
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { createTransport } from 'nodemailer'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { authorizeUrl, exchangeCode, pkce } from '@profullstack/coinpay-onboard/oauth'
import { CoinPay, PAID_EVENTS, verifyWebhook, type WebhookEvent } from '@profullstack/coinpay-onboard'
import { sameSecret } from '@profullstack/group-call'
import { helpPage, homePage, installScript, invitedPage, invitesPage, mePage, messagePage, passPage, roomPage, roomsPage, SITE, type Ctx } from './html.js'
import { Sealer, Store, type Recording, type Room, type User } from './db.js'
import { startPitFooterRefresh } from './pit-footer.js'
import { RING_PLACEHOLDER, ringBar, startRingRefresh } from './ring.js'
import { ringDescriptor, startRingFooterRefresh } from './ring-footer.js'
import { loadRoutes } from './routing.js'
import { webhooksApi } from '@profullstack/webhooks'
import { toolHandler } from '@profullstack/voice-agent'
import { AGENTS, CODE_LENGTH, formatNumber, GroupCallService, hostLabel, newApiKey, telLink, UserError, type Config, type InvitationEmail, type LiveEvent } from './service.js'
import { VERSION } from './version.js'

export { VERSION }

const SELF = 'group.call.pit.world'
const SESSION = 'gc_session'
const CAMPAIGN = 'gc_campaign'
const CAMPAIGN_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid']
const SCOPES = ['openid', 'profile', 'email']

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' https://crawlproof.com; img-src 'self' data: https://built.indie.pit.world https://pwamart.com; connect-src 'self' https://crawlproof.com; media-src 'self'; manifest-src 'self'; worker-src 'self'; frame-src https://crawlproof.com; form-action 'self' https://coinpayportal.com https://pit.world; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'interest-cohort=(), browsing-topics=(), camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
}

export type Deps = { store: Store; config: Config; origin?: string; secureCookies?: boolean }

type Env = { Bindings: { ip?: string } }

/** A small fixed-window limit per key, in memory: enough to stop a loop, not a fortress. */
class Limiter {
  private hits = new Map<string, { n: number; reset: number }>()
  private readonly max: number
  private readonly windowMs: number
  constructor(max: number, windowMs: number) {
    this.max = max
    this.windowMs = windowMs
  }
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    if (!h || h.reset < now) {
      if (this.hits.size > 50_000) this.hits.clear()
      this.hits.set(key, { n: 1, reset: now + this.windowMs })
      return true
    }
    h.n += 1
    return h.n <= this.max
  }
}

export function createApp(deps: Deps) {
  const { store, config } = deps
  const ORIGIN = deps.origin ?? SITE
  const svc = new GroupCallService(store, { origin: ORIGIN, ...config })
  const app = new Hono<Env>()
  const writeLimit = new Limiter(60, 10 * 60_000)
  const sayLimit = new Limiter(30, 60_000)
  const authLimit = new Limiter(30, 10 * 60_000)
  /** Ringing phones costs money and can annoy people: 10 an hour each. */
  const dialLimit = new Limiter(10, 60 * 60_000)

  const ip = (c: Context<Env>) => c.env?.ip ?? 'local'
  const sessionId = (c: Context) => getCookie(c, SESSION)
  const csrfFor = (sid: string | undefined) => (sid ? createHmac('sha256', config.key).update(`csrf:${sid}`).digest('hex').slice(0, 32) : '')
  const userOf = (c: Context) => store.session(sessionId(c))
  const ctxOf = (c: Context): Ctx => {
    const user = userOf(c)
    return { user, csrf: csrfFor(sessionId(c)), dialIn: config.dialIn, agents: svc.mayInviteAgents(user), callPhones: svc.mayCallPhones(user), passUntil: user ? store.passUntil(user.sub) : null }
  }
  const csrfOk = (c: Context, given: unknown) => {
    const expected = csrfFor(sessionId(c))
    const g = Buffer.from(String(given ?? ''))
    const e = Buffer.from(expected)
    return expected !== '' && g.length === e.length && timingSafeEqual(g, e)
  }
  const page = (c: Context, html: string, status = 200) => c.html(html.replace(RING_PLACEHOLDER, ringBar(SELF, false)), status as 200)
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
  const statusOf = (e: unknown) => (e instanceof UserError ? e.status : 502)
  const codeParam = (c: Context) => String(c.req.param('code') ?? '').replace(/\D/g, '').slice(0, CODE_LENGTH)
  // Keep ad attribution through sign-in without forwarding arbitrary query parameters.
  const campaignQuery = (c: Context) => {
    const params = new URLSearchParams()
    for (const key of CAMPAIGN_KEYS) {
      const value = c.req.query(key)?.trim().slice(0, 120)
      if (value && !/[\u0000-\u001f\u007f]/.test(value)) params.set(key, value)
    }
    return params.toString()
  }
  const campaignOptions = { httpOnly: true, secure: deps.secureCookies ?? true, sameSite: 'Lax' as const, path: '/', maxAge: 30 * 60 }

  app.use('*', async (c, next) => {
    await next()
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v)
  })

  app.get('/health', (c) => c.json({ ok: true, version: VERSION, phone: Boolean(svc.line?.armed) }))

  const TYPES: Record<string, string> = {
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    crt: 'application/x-x509-ca-cert',
    webmanifest: 'application/manifest+json',
  }
  app.get('/:file{(style\\.css|app\\.js|sw\\.js|favicon\\.svg|icon-192\\.png|icon-512\\.png|manifest\\.webmanifest|moshpit-root-ca\\.crt)}', async (c) => {
    const name = c.req.param('file')
    const file = Bun.file(new URL(`../public/${name}`, import.meta.url))
    // The service worker must be re-read on every visit, or an old one serves forever.
    const cache = name === 'sw.js' ? 'no-cache' : 'public, max-age=86400'
    return c.body(await file.arrayBuffer(), 200, { 'content-type': TYPES[name.split('.').pop()!]!, 'cache-control': cache })
  })
  app.get('/install.sh', (c) => c.body(installScript(), 200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'public, max-age=3600' }))
  const plain = (c: Context, text: string) => c.body(text, 200, { 'content-type': 'text/plain; charset=utf-8' })
  app.get('/.well-known/openwebring.json', (c) => c.json(ringDescriptor(), 200, { 'access-control-allow-origin': '*' }))
  app.get('/robots.txt', (c) => plain(c, 'User-agent: *\nDisallow: /api/\nDisallow: /auth/\nDisallow: /r/\nSitemap: ' + ORIGIN + '/sitemap.xml\n'))
  app.get('/sitemap.xml', (c) =>
    c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/help'].map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`).join('')}</urlset>`, 200, { 'content-type': 'application/xml' }),
  )
  app.get('/llms.txt', (c) =>
    plain(
      c,
      `# group.call\n\n> A party line for people and AI agents. Make a room, get a ${CODE_LENGTH}-digit code; everyone dials ${formatNumber(config.dialIn)} and keys it. Agents phone in too. Sign in with CoinPay.\n\n- Help, API and agents: ${ORIGIN}/help\n- CLI: bunx @profullstack/groupcall\n- MCP: claude mcp add groupcall -e GROUPCALL_KEY=gc_… -- bunx @profullstack/groupcall mcp\n- Engine: https://github.com/profullstack/group-call\n`,
    ),
  )

  app.get('/', (c) => page(c, homePage(ctxOf(c), campaignQuery(c))))
  app.get('/help', (c) => page(c, helpPage(ctxOf(c))))

  // ---- Sign in with CoinPay -----------------------------------------------------

  // ---- invites and affiliate links ------------------------------------------------

  const INVITE = 'gc_invite'
  const REF = 'gc_ref'
  /** Anyone arriving with ?ref=<affiliate code> is remembered for when they sign in (first touch). */
  app.use('*', async (c, next) => {
    const ref = c.req.query('ref')
    if (ref && /^[A-Za-z0-9-]{4,40}$/.test(ref) && !getCookie(c, REF)) setCookie(c, REF, ref, { httpOnly: true, secure: deps.secureCookies ?? true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 })
    await next()
  })

  app.get('/i/:code', (c) => {
    const code = c.req.param('code')
    if (!/^[A-Za-z0-9-]{6,40}$/.test(code)) return page(c, messagePage(ctxOf(c), { title: 'Not an invite', message: 'That invite link is not right.' }), 404)
    setCookie(c, INVITE, code, { httpOnly: true, secure: deps.secureCookies ?? true, sameSite: 'Lax', path: '/', maxAge: 7 * 86400 })
    return page(c, invitedPage(ctxOf(c)))
  })

  app.get('/invites', async (c) => {
    const user = need(c, 'invites')
    if (user instanceof Response) return user
    return page(c, invitesPage(ctxOf(c), { quota: await svc.affiliates.quota(user.sub), invites: await svc.affiliates.invites(user.sub), affiliate: `${ORIGIN}/?ref=${await svc.affiliates.affiliateCode(user.sub)}` }))
  })

  app.post('/invites', async (c) => {
    const user = need(c, 'invites')
    if (user instanceof Response) return user
    const form = await formOf(c)
    const view = async (extra: { link?: string; error?: string }, status = 200) =>
      page(c, invitesPage(ctxOf(c), { quota: await svc.affiliates.quota(user.sub), invites: await svc.affiliates.invites(user.sub), affiliate: `${ORIGIN}/?ref=${await svc.affiliates.affiliateCode(user.sub)}`, ...extra }), status)
    if (!csrfOk(c, form.csrf)) return view({ error: 'That form went stale. Try again.' }, 400)
    try {
      const invite = await svc.affiliates.createInvite(user.sub, String(form.note ?? '').slice(0, 80))
      return view({ link: `${ORIGIN}/i/${invite.code}` })
    } catch (e) {
      return view({ error: message(e) === 'no invites left' ? 'You have used all your invites.' : message(e) }, 400)
    }
  })

  app.get('/auth/start', (c) => {
    if (!authLimit.allow(`auth:${ip(c)}`)) return page(c, messagePage(ctxOf(c), { title: 'Slow down', message: 'Too many sign-in attempts. Try again in a few minutes.' }), 429)
    // Where to land after sign-in rides in the state CoinPay echoes back: "<random>.<path>".
    const next = c.req.query('next') ?? ''
    const target = next === '/start' ? 'start' : /^\/(rooms|me|r\/\d{4})$/.test(next) ? next.slice(1).replace('/', '~') : 'rooms'
    const state = `${randomBytes(16).toString('base64url')}.${target}`
    const { verifier, challenge } = pkce()
    const redirectUri = `${ORIGIN}/auth/callback`
    store.saveState(state, verifier, redirectUri)
    setCookie(c, CAMPAIGN, campaignQuery(c), campaignOptions)
    return c.redirect(authorizeUrl({ clientId: config.clientId, redirectUri, state, challenge, scopes: SCOPES, base: config.coinpayBase }))
  })

  app.get('/auth/callback', async (c) => {
    const ctx = ctxOf(c)
    const error = c.req.query('error')
    if (error) return page(c, messagePage(ctx, { title: 'Not signed in', message: c.req.query('error_description') ?? 'CoinPay did not sign you in.' }), 400)
    const state = c.req.query('state') ?? ''
    const saved = state ? store.takeState(state) : null
    const code = c.req.query('code')
    if (!saved || !code) return page(c, messagePage(ctx, { title: 'Sign-in expired', message: 'That sign-in link is old. Start again.' }), 400)
    try {
      const tokens = await exchangeCode({ code, verifier: saved.verifier, clientId: config.clientId, ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}), redirectUri: saved.redirectUri, base: config.coinpayBase, ...(config.fetch ? { fetch: config.fetch } : {}) })
      const me = await new CoinPay({ base: config.coinpayBase, token: tokens.accessToken, ...(config.fetch ? { fetch: config.fetch } : {}) }).userinfo()
      const isNew = !store.user(me.sub)
      const user = store.upsertUser(me.sub, me.name ?? '', (me.email ?? '').toLowerCase(), tokens)
      const sid = store.newSession(user.sub)
      // Signed in through an invite or an affiliate link: credit whoever brought them.
      const invite = getCookie(c, INVITE)
      if (invite && isNew) await svc.acceptInvite(invite, user).catch(() => null)
      if (invite) deleteCookie(c, INVITE, { path: '/' })
      const ref = getCookie(c, REF)
      if (ref && isNew) await svc.affiliates.attribute(ref, user.sub).catch(() => null)
      setCookie(c, SESSION, sid, { httpOnly: true, secure: deps.secureCookies ?? true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 })
      const target = state.split('.')[1] ?? 'rooms'
      const campaign = new URLSearchParams(getCookie(c, CAMPAIGN) ?? '').toString()
      deleteCookie(c, CAMPAIGN, { path: '/' })
      const query = campaign ? `?${campaign}` : ''
      if (target === 'start') {
        try {
          const room = svc.createRoom(user, { name: 'Quick call' })
          return c.redirect(`/r/${room.code}?made=1${campaign ? `&${campaign}` : ''}`)
        } catch {
          return c.redirect(`/rooms${query}`)
        }
      }
      return c.redirect(`/${target.replace('~', '/')}${query}`)
    } catch (e) {
      return page(c, messagePage(ctx, { title: 'Sign-in failed', message: e instanceof Error ? e.message : 'CoinPay did not answer.' }), 502)
    }
  })

  app.post('/auth/logout', async (c) => {
    const form = await c.req.parseBody()
    if (csrfOk(c, form.csrf)) store.endSession(sessionId(c))
    deleteCookie(c, SESSION, { path: '/' })
    return c.redirect('/')
  })

  const need = (c: Context, next = 'rooms'): User | Response => userOf(c) ?? c.redirect(`/auth/start?next=/${next}`)
  const formOf = async (c: Context) => (await c.req.parseBody()) as Record<string, string>

  // ---- rooms -------------------------------------------------------------------

  const liveCounts = (rooms: Room[]) => Object.fromEntries(rooms.map((r) => [r.code, svc.line?.callersIn(r.code) ?? 0]))
  const rooms = (c: Context, user: User, extra: { flash?: string; error?: string; values?: Record<string, string> } = {}, status = 200) => {
    const list = store.rooms(user.sub)
    return page(c, roomsPage(ctxOf(c), { rooms: list, live: liveCounts(list), limit: svc.roomLimit(user), passes: store.passes(user.sub), ...extra }), status)
  }

  app.get('/rooms', (c) => {
    const user = need(c)
    return user instanceof Response ? user : rooms(c, user)
  })

  app.post('/rooms', async (c) => {
    const user = need(c)
    if (user instanceof Response) return user
    const form = await formOf(c)
    if (!csrfOk(c, form.csrf)) return rooms(c, user, { error: 'That form went stale. Try again.', values: form }, 400)
    if (!writeLimit.allow(`w:${user.sub}`)) return rooms(c, user, { error: 'Too many changes. Wait a few minutes.', values: form }, 429)
    try {
      const room = svc.createRoom(user, { name: form.name ?? '', ...(form.code ? { code: form.code } : {}) })
      return c.redirect(`/r/${room.code}?made=1`, 303)
    } catch (e) {
      return rooms(c, user, { error: message(e), values: form }, statusOf(e))
    }
  })

  // One tap for signed-in visitors; a visitor who needs CoinPay sign-in returns
  // here through the OAuth callback, which creates the room they asked for.
  app.post('/start', async (c) => {
    const campaign = campaignQuery(c)
    const user = userOf(c)
    if (!user) return c.redirect(`/auth/start?next=/start${campaign ? `&${campaign}` : ''}`)
    const form = await formOf(c)
    if (!csrfOk(c, form.csrf)) return rooms(c, user, { error: 'That form went stale. Try again.' }, 400)
    if (!writeLimit.allow(`w:${user.sub}`)) return rooms(c, user, { error: 'Too many changes. Wait a few minutes.' }, 429)
    try {
      const room = svc.createRoom(user, { name: 'Quick call' })
      return c.redirect(`/r/${room.code}?made=1${campaign ? `&${campaign}` : ''}`, 303)
    } catch (e) {
      return rooms(c, user, { error: message(e) }, statusOf(e))
    }
  })

  const roomView = (c: Context, user: User, room: Room, extra: { flash?: string; error?: string } = {}, status = 200) =>
    page(c, roomPage(ctxOf(c), { room, owner: room.sub === user.sub, live: svc.live(room.code), events: svc.events(room.code), invites: store.invites(room.code), transcript: store.transcript(room.code, { limit: 200 }), contacts: svc.book(user), recordings: store.recordings(room.code), canRecord: svc.canRecord, ...extra }), status)

  app.get('/r/:code', (c) => {
    const user = need(c, `r/${codeParam(c)}`)
    if (user instanceof Response) return user
    const room = store.room(codeParam(c))
    // A room page is its owner's. Codes are short, so nobody browses other people's rooms.
    if (!room || room.sub !== user.sub) return page(c, messagePage(ctxOf(c), { title: 'No such room', message: 'That room does not exist, or it is not yours.' }), 404)
    return roomView(c, user, room, c.req.query('made') ? { flash: `Your room is ready. Give people the number and the code ${room.code}.` } : {})
  })

  /** Who is on the line, live, for the room page (server-sent events). */
  app.get('/r/:code/live', (c) => {
    const user = userOf(c)
    const room = store.room(codeParam(c))
    if (!user || !room || room.sub !== user.sub) return c.json({ error: 'not found' }, 404)
    return streamSSE(c, async (stream) => {
      const send = (e: LiveEvent | { type: 'hello' }) => stream.writeSSE({ event: 'room', data: JSON.stringify({ ...e, live: svc.live(room.code) }) })
      const off = svc.subscribe(room.code, (e) => void send(e))
      await send({ type: 'hello' })
      let open = true
      stream.onAbort(() => {
        open = false
        off()
      })
      // A comment every 25 s keeps proxies from closing a quiet stream.
      while (open) {
        await stream.sleep(25_000)
        if (open) await stream.write(': ping\n\n')
      }
    })
  })

  /** The whole transcript as plain text, for saving or pasting. */
  app.get('/r/:code/transcript.txt', (c) => {
    const user = userOf(c)
    if (!user) return c.redirect(`/auth/start?next=/r/${codeParam(c)}`)
    try {
      const room = svc.ownRoom(user, codeParam(c))
      const lines = svc.transcript(user, room.code, { limit: 5000 })
      const text = lines.map((l) => `[${new Date(l.at).toISOString().slice(0, 19).replace('T', ' ')}] ${l.who}${l.kind === 'typed' ? ' (typed)' : ''}: ${l.text}`).join('\n')
      return c.body(`${room.name} (${room.code}), group.call transcript\n\n${text || '(nothing said yet)'}\n`, 200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `inline; filename="groupcall-${room.code}-transcript.txt"`,
      })
    } catch {
      return c.json({ error: 'not found' }, 404)
    }
  })

  /** A recording file, streamed with ranges so a player can seek. */
  const mp3 = (rec: Recording) =>
    new Response(Bun.file(rec.path), {
      headers: { 'content-type': 'audio/mpeg', 'content-disposition': `inline; filename="groupcall-${rec.code}-${rec.id}.mp3"`, 'cache-control': 'private, max-age=3600' },
    })
  app.get('/r/:code/rec/:file{rec_[A-Za-z0-9_-]+\\.mp3}', (c) => {
    const user = userOf(c)
    const rec = user ? svc.ownRecording(user, String(c.req.param('file')).replace(/\.mp3$/, '')) : null
    return rec && rec.code === codeParam(c) ? mp3(rec) : c.json({ error: 'not found' }, 404)
  })

  app.post('/r/:code/:action{(say|invite|call|rename|delete|record|greeter|text)}', async (c) => {
    const user = need(c, `r/${codeParam(c)}`)
    if (user instanceof Response) return user
    const code = codeParam(c)
    const room = store.room(code)
    if (!room || room.sub !== user.sub) return page(c, messagePage(ctxOf(c), { title: 'No such room', message: 'That room does not exist, or it is not yours.' }), 404)
    const form = await formOf(c)
    if (!csrfOk(c, form.csrf)) return roomView(c, user, room, { error: 'That form went stale. Try again.' }, 400)
    const action = c.req.param('action')
    const limiter = action === 'say' ? sayLimit : action === 'call' || action === 'invite' ? dialLimit : writeLimit
    if (!limiter.allow(`${action}:${user.sub}`)) return roomView(c, user, room, { error: 'Too many at once. Wait a moment.' }, 429)
    try {
      if (action === 'say') {
        const r = await svc.say(user, code, form.text ?? '')
        return roomView(c, user, room, r.said ? { flash: `Said to ${r.callers} on the line.` } : { error: 'Nobody is on the line to hear it.' })
      }
      if (action === 'invite' && form.names) {
        const r = await svc.inviteNames(user, code, form.names)
        return roomView(c, user, room, r.results.some((x) => x.status === 'invited' || x.status === 'calling') ? { flash: r.said } : { error: r.said })
      }
      if (action === 'invite') {
        const invite = svc.inviteAgent(user, code, form.agent ?? '')
        return roomView(c, user, room, { flash: `${invite.agent} will dial in shortly.` })
      }
      if (action === 'call') {
        const r = await svc.callPhone(user, code, form.phone ?? '', form.name ?? '')
        return roomView(c, user, room, { flash: `Ringing ${r.to}. Pick up and press 1 to join.` })
      }
      if (action === 'text') {
        const r = await svc.textRoom(code, form.text ?? '', { name: user.name || 'The host' })
        return roomView(c, user, room, r.sent ? { flash: `Texted ${r.sent} on the line.${r.failed ? ` ${r.failed} did not go: ${r.error}.` : ''}` } : { error: r.error ? `Not sent: ${r.error}.` : 'Nobody on the line has a number that can get a text.' })
      }
      if (action === 'greeter') {
        const g = svc.setGreeter(user, code, form.greeter ?? '', form.host ?? '')
        return roomView(c, user, store.room(code)!, { flash: g.greeter ? `${g.greeter} will greet anyone who arrives before ${hostLabel(store.room(code)!)}.` : 'No greeter.' })
      }
      if (action === 'record') {
        const r = await svc.setRecord(user, code, form.on === '1')
        return roomView(c, user, store.room(code)!, { flash: r.record ? (r.recording ? 'Recording now.' : 'This room records every call from now on.') : 'Recording is off.' })
      }
      if (action === 'rename') {
        const renamed = svc.renameRoom(user, code, form.name ?? '')
        return roomView(c, user, renamed, { flash: 'Renamed.' })
      }
      await svc.deleteRoom(user, code)
      return rooms(c, user, { flash: `Room ${code} is deleted.` })
    } catch (e) {
      return roomView(c, user, room, { error: message(e) }, statusOf(e))
    }
  })

  // ---- room passes -------------------------------------------------------------

  app.post('/pass', async (c) => {
    const user = need(c)
    if (user instanceof Response) return user
    const form = await formOf(c)
    if (!csrfOk(c, form.csrf)) return rooms(c, user, { error: 'That form went stale. Try again.' }, 400)
    if (!writeLimit.allow(`w:${user.sub}`)) return rooms(c, user, { error: 'Too many changes. Wait a few minutes.' }, 429)
    try {
      const pass = await svc.buyPass(user)
      return c.redirect(pass.checkoutUrl, 303)
    } catch (e) {
      return rooms(c, user, { error: message(e) }, statusOf(e))
    }
  })

  app.get('/pass/:id{[^/]+\\.json}', async (c) => {
    const user = userOf(c)
    const id = c.req.param('id').replace(/\.json$/, '')
    const pass = await svc.followPass(id)
    if (!user || !pass || pass.sub !== user.sub) return c.json({ error: 'not found' }, 404)
    return c.json({ status: pass.status, until: store.passUntil(user.sub) })
  })

  app.get('/pass/:id', async (c) => {
    const user = need(c)
    if (user instanceof Response) return user
    const pass = await svc.followPass(c.req.param('id'))
    if (!pass || pass.sub !== user.sub) return page(c, messagePage(ctxOf(c), { title: 'Not found', message: 'No such checkout.' }), 404)
    return page(c, passPage(ctxOf(c), pass))
  })

  /** CoinPay's webhook: a paid checkout session turns on the pass it was for. */
  app.post('/api/coinpay/webhook', async (c) => {
    const raw = await c.req.text()
    if (!config.coinpayWebhookSecret || !verifyWebhook(raw, c.req.header('x-coinpay-signature'), config.coinpayWebhookSecret)) return c.json({ error: 'bad signature' }, 401)
    let event: WebhookEvent
    try {
      event = JSON.parse(raw) as WebhookEvent
    } catch {
      return c.json({ error: 'bad json' }, 400)
    }
    const session = String(event.data?.checkout_session_id ?? '')
    if (PAID_EVENTS.has(event.type) && session) svc.passPaid(session)
    return c.json({ ok: true })
  })

  // ---- the phone line ----------------------------------------------------------

  // Texts to the room number (its messaging profile's webhook): STOP/START, and passing a link to the call.
  app.post('/api/telnyx/sms', async (c) => {
    const raw = await c.req.text()
    const ok = await svc.inboundSms(raw, c.req.header('telnyx-signature-ed25519'), c.req.header('telnyx-timestamp'))
    return ok ? c.json({ ok: true }) : c.json({ error: 'unsigned' }, 401)
  })

  app.post('/api/telnyx/voice', async (c) => {
    const raw = await c.req.text()
    const ok = await svc.telnyx(raw, c.req.header('telnyx-signature-ed25519'), c.req.header('telnyx-timestamp'))
    return ok ? c.json({ ok: true }) : c.json({ error: 'unsigned' }, 401)
  })

  // ---- account -----------------------------------------------------------------

  app.get('/me', async (c) => {
    const user = need(c, 'me')
    return user instanceof Response ? user : page(c, mePage(ctxOf(c), { minutes: await svc.minutes(user), webhooks: await svc.hooks.listEndpoints(user.sub), smshub: svc.smshubStatus(user), contacts: svc.book(user) }))
  })

  // This is a form action; opening it directly should take people to the form.
  app.get('/me/contacts/add', (c) => c.redirect('/me#contacts', 303))

  // The contacts book from the account page: add one, or remove one.
  app.post('/me/contacts/:action{(add|delete)}', async (c) => {
    const user = need(c, 'me')
    if (user instanceof Response) return user
    const form = await formOf(c)
    const show = async (flash: string, status = 200) => page(c, mePage(ctxOf(c), { flash, minutes: await svc.minutes(user), webhooks: await svc.hooks.listEndpoints(user.sub), smshub: svc.smshubStatus(user), contacts: svc.book(user) }), status as 200)
    if (!csrfOk(c, form.csrf)) return show('That form went stale. Try again.', 400)
    if (!writeLimit.allow(`contacts:${user.sub}`)) return show('Too many changes. Wait a few minutes.', 429)
    try {
      if (c.req.param('action') === 'delete') {
        svc.removeContact(user, form.id ?? '')
        return show('Contact removed.')
      }
      const saved = svc.saveContact(user, { name: form.name, kind: form.kind, phone: form.phone, sip: form.sip, agent: form.agent, email: form.email, aliases: form.aliases ?? '', note: form.note ?? '', trusted: form.trusted === '1' })
      return show(`${saved.name} is in your contacts. Say "invite ${saved.name}" on a call.`)
    } catch (e) {
      return show(message(e), statusOf(e))
    }
  })

  // smshub.dev from the account page: link (key, number, relay) or unlink.
  app.post('/me/smshub/:action{(link|unlink)}', async (c) => {
    const user = need(c, 'me')
    if (user instanceof Response) return user
    const form = await formOf(c)
    const show = async (flash: string, status = 200) => page(c, mePage(ctxOf(c), { flash, minutes: await svc.minutes(user), webhooks: await svc.hooks.listEndpoints(user.sub), smshub: svc.smshubStatus(user) }), status as 200)
    if (!csrfOk(c, form.csrf)) return show('That form went stale. Try again.', 400)
    if (!writeLimit.allow(`smshub:${user.sub}`)) return show('Too many changes. Wait a few minutes.', 429)
    try {
      if (c.req.param('action') === 'unlink') {
        svc.unlinkSmshub(user)
        return show('smshub unlinked: group texts go from the room number again.')
      }
      const r = await svc.linkSmshub(user, { key: form.key ?? '', from: form.from ?? '', relay: form.relay === '1' })
      return show(`smshub linked: your rooms' group texts now go out as smshub groups${r.from ? ` from ${r.from}` : ''}.`)
    } catch (e) {
      return show(message(e), statusOf(e))
    }
  })

  // Webhooks from the account page: add, test, rotate, delete. The API below does the same with a key.
  app.post('/me/webhooks/:action{(add|test|rotate|delete)}', async (c) => {
    const user = need(c, 'me')
    if (user instanceof Response) return user
    const form = await formOf(c)
    const show = async (data: { flash?: string; webhookSecret?: string }, status = 200) => page(c, mePage(ctxOf(c), { ...data, minutes: await svc.minutes(user), webhooks: await svc.hooks.listEndpoints(user.sub) }), status as 200)
    if (!csrfOk(c, form.csrf)) return show({ flash: 'That form went stale. Try again.' }, 400)
    if (!writeLimit.allow(`wh:${user.sub}`)) return show({ flash: 'Too many changes. Wait a few minutes.' }, 429)
    try {
      const action = c.req.param('action')
      if (action === 'add') {
        const r = await svc.hooks.createEndpoint(user.sub, { url: form.url ?? '', events: form.events || undefined, description: form.description ?? '' })
        return show({ flash: `Webhook added. Its signing secret is below, and stays available under "Show secret".`, webhookSecret: r.secret })
      }
      const id = form.id ?? ''
      if (action === 'test') {
        const r = await svc.hooks.test(user.sub, id)
        return show({ flash: r.ok ? `Test delivered (HTTP ${r.status}).` : `Test failed: ${r.error}` })
      }
      if (action === 'rotate') return show({ flash: 'New signing secret below; the old one has stopped working.', webhookSecret: (await svc.hooks.rotateSecret(user.sub, id)).secret })
      await svc.hooks.deleteEndpoint(user.sub, id)
      return show({ flash: 'Webhook removed.' })
    } catch (e) {
      return show({ flash: message(e) }, statusOf(e))
    }
  })

  app.post('/me/redeem', async (c) => {
    const user = need(c, 'me')
    if (user instanceof Response) return user
    const form = await formOf(c)
    if (!csrfOk(c, form.csrf)) return page(c, mePage(ctxOf(c), { flash: 'That form went stale. Try again.', minutes: await svc.minutes(user) }), 400)
    if (!writeLimit.allow(`redeem:${user.sub}`)) return page(c, mePage(ctxOf(c), { flash: 'Too many tries. Wait a few minutes.', minutes: await svc.minutes(user) }), 429)
    try {
      const flash = await svc.redeem(user, form.code ?? '')
      return page(c, mePage(ctxOf(c), { flash, minutes: await svc.minutes(user) }))
    } catch (e) {
      return page(c, mePage(ctxOf(c), { flash: message(e), minutes: await svc.minutes(user) }), statusOf(e))
    }
  })

  app.post('/me/:action{(key|delete)}', async (c) => {
    const user = need(c, 'me')
    if (user instanceof Response) return user
    const form = await formOf(c)
    if (!csrfOk(c, form.csrf)) return page(c, mePage(ctxOf(c), { flash: 'That form went stale. Try again.', minutes: await svc.minutes(user) }), 400)
    if (c.req.param('action') === 'key') {
      const key = newApiKey()
      store.setApiKey(user.sub, key)
      return page(c, mePage({ ...ctxOf(c), user: store.user(user.sub) }, { apiKey: key, minutes: await svc.minutes(user) }))
    }
    for (const r of store.rooms(user.sub)) await svc.deleteRoom(user, r.code).catch(() => {})
    store.deleteUser(user.sub)
    deleteCookie(c, SESSION, { path: '/' })
    return c.redirect('/')
  })

  // ---- the API -----------------------------------------------------------------

  const param = (c: Context, name: string) => c.req.param(name) ?? ''
  const apiUser = (c: Context): User | null => {
    const key = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    return key.startsWith('gc_') ? store.byApiKey(key) : null
  }
  const api = (handler: (c: Context, user: User) => Promise<Response> | Response) => async (c: Context<Env>) => {
    const user = apiUser(c)
    if (!user) return c.json({ error: `send your API key: authorization: Bearer gc_… (make one at ${ORIGIN}/me)` }, 401)
    if (c.req.method !== 'GET' && !writeLimit.allow(`w:${user.sub}`)) return c.json({ error: 'too many changes; wait a few minutes' }, 429)
    try {
      return await handler(c, user)
    } catch (e) {
      return c.json({ error: message(e) }, statusOf(e) as 400)
    }
  }
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>

  // SMSHub's Settings > Connect group.call flow sends a fresh CoinPay access
  // token server-to-server. CoinPay userinfo verifies it; the token is never
  // exposed to the browser or saved here.
  const coinpayUser = async (c: Context) => {
    const authorization = c.req.header('authorization') ?? ''
    const token = /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1]
    if (!token) return null
    try {
      return await new CoinPay({ base: config.coinpayBase, token, ...(config.fetch ? { fetch: config.fetch } : {}) }).userinfo()
    } catch {
      return null
    }
  }
  app.post('/api/integrations/smshub', async (c) => {
    const identity = await coinpayUser(c)
    if (!identity?.sub) return c.json({ error: 'CoinPay authorization is missing or expired' }, 401)
    if (!writeLimit.allow(`smshub-oauth:${identity.sub}`)) return c.json({ error: 'too many changes; wait a few minutes' }, 429)
    try {
      const b = await body(c)
      return c.json(await svc.linkSmshub({ sub: identity.sub }, {
        key: String(b.key ?? ''),
        from: b.from ? String(b.from) : '',
        relay: b.relay === true,
        coinpaySub: identity.sub,
      }))
    } catch (e) {
      return c.json({ error: message(e) }, statusOf(e) as 400)
    }
  })
  app.delete('/api/integrations/smshub', async (c) => {
    const identity = await coinpayUser(c)
    if (!identity?.sub) return c.json({ error: 'CoinPay authorization is missing or expired' }, 401)
    if (!writeLimit.allow(`smshub-oauth:${identity.sub}`)) return c.json({ error: 'too many changes; wait a few minutes' }, 429)
    return c.json(svc.unlinkSmshub({ sub: identity.sub }))
  })

  // Customer webhooks: the @profullstack/webhooks API, scoped to the key's account.
  const hookOwner = new WeakMap<Request, string>()
  const hooksApi = webhooksApi(svc.hooks, { basePath: '/api/v1/webhooks', owner: (req) => hookOwner.get(req) })
  const webhooksRoute = api(async (c, u) => {
    hookOwner.set(c.req.raw, u.sub)
    return (await hooksApi(c.req.raw)) ?? c.json({ error: 'not found' }, 404)
  })
  app.get('/api/v1/me/smshub', api((c, u) => c.json(svc.smshubStatus(u))))
  app.post('/api/v1/me/smshub', api(async (c, u) => {
    const b = await body(c)
    return c.json(await svc.linkSmshub(u, { key: String(b.key ?? ''), from: b.from ? String(b.from) : '', relay: b.relay === true }))
  }))
  app.delete('/api/v1/me/smshub', api((c, u) => c.json(svc.unlinkSmshub(u))))
  app.all('/api/v1/webhooks', webhooksRoute)
  app.all('/api/v1/webhooks/*', webhooksRoute)
  app.post(
    '/api/v1/rooms/:code/text',
    api(async (c, u) => {
      if (!sayLimit.allow(`text:${u.sub}`)) return c.json({ error: 'too many texts; wait a minute' }, 429)
      const room = store.room(param(c, 'code'))
      if (!room || room.sub !== u.sub) return c.json({ error: 'no such room' }, 404)
      return c.json(await svc.textRoom(room.code, String((await body(c)).text ?? ''), { name: u.name || 'The host' }))
    }),
  )
  const roomJson = (r: Room, full = false) => ({
    code: r.code,
    name: r.name,
    dial_in: config.dialIn,
    tel: telLink(config.dialIn, r.code),
    on_the_line: svc.line?.callersIn(r.code) ?? 0,
    created_at: new Date(r.createdAt).toISOString(),
    last_used_at: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
    page: `${ORIGIN}/r/${r.code}`,
    record: r.record,
    greeter: r.greeter,
    host: r.greeter ? hostLabel(r) : null,
    recording: svc.line?.recording(r.code) ?? false,
    ...(full ? { quality: store.quality(r.code, 10).map((q) => ({ who: q.who, mos_in: q.mosIn, mos_out: q.mosOut, jitter_ms: q.jitterMs, loss_pct: q.lossPct, at: new Date(q.at).toISOString() })), live: svc.live(r.code), activity: svc.events(r.code).slice(0, 20).map((e) => ({ kind: e.kind, who: e.who, text: e.text || undefined, at: new Date(e.at).toISOString() })) } : {}),
  })

  app.post(
    '/api/v1/redeem',
    api(async (c, u) => {
      const message = await svc.redeem(u, String((await body(c)).code ?? ''))
      const m = await svc.minutes(u)
      return c.json({ ok: true, message, minutes_left: m.unlimited ? null : m.left })
    }),
  )
  app.get(
    '/api/v1/invites',
    api(async (c, u) => c.json({ quota: await svc.affiliates.quota(u.sub), invites: await svc.affiliates.invites(u.sub), affiliate_link: `${ORIGIN}/?ref=${await svc.affiliates.affiliateCode(u.sub)}` })),
  )
  app.post(
    '/api/v1/invites',
    api(async (c, u) => {
      try {
        const invite = await svc.affiliates.createInvite(u.sub, String((await body(c)).note ?? '').slice(0, 80))
        return c.json({ link: `${ORIGIN}/i/${invite.code}`, code: invite.code, expires_at: invite.expiresAt ? new Date(invite.expiresAt).toISOString() : null, left: (await svc.affiliates.quota(u.sub)).left }, 201)
      } catch (e) {
        return c.json({ error: message(e) === 'no invites left' ? 'You have used all your invites.' : message(e) }, 400)
      }
    }),
  )
  app.get(
    '/api/v1/me',
    api(async (c, u) => {
      const until = store.passUntil(u.sub)
      const m = await svc.minutes(u)
      return c.json({ name: u.name, email: u.email, dial_in: config.dialIn, minutes: { used: m.used, free: m.free, credits: m.credits, left: m.unlimited ? null : m.left, unlimited: m.unlimited }, pass_until: until ? new Date(until).toISOString() : null, room_limit: svc.roomLimit(u), can_invite_agents: svc.mayInviteAgents(u), can_call_phones: svc.mayCallPhones(u), agents: Object.keys(AGENTS), rooms: store.rooms(u.sub).map((r) => roomJson(r)) })
    }),
  )
  app.get('/api/v1/rooms', api((c, u) => c.json({ rooms: store.rooms(u.sub).map((r) => roomJson(r)) })))
  app.post(
    '/api/v1/rooms',
    api(async (c, u) => {
      const b = await body(c)
      return c.json(roomJson(svc.createRoom(u, { name: String(b.name ?? ''), ...(b.code ? { code: String(b.code) } : {}) }), true), 201)
    }),
  )
  app.get('/api/v1/rooms/:code', api((c, u) => c.json(roomJson(svc.ownRoom(u, param(c, 'code')), true))))
  app.patch(
    '/api/v1/rooms/:code',
    api(async (c, u) => c.json(roomJson(svc.renameRoom(u, param(c, 'code'), String((await body(c)).name ?? '')), true))),
  )
  app.delete(
    '/api/v1/rooms/:code',
    api(async (c, u) => {
      await svc.deleteRoom(u, param(c, 'code'))
      return c.json({ ok: true })
    }),
  )
  app.get(
    '/api/v1/rooms/:code/transcript',
    api((c, u) => {
      const after = c.req.query('after')
      const limit = Number(c.req.query('limit') ?? 200)
      const lines = svc.transcript(u, param(c, 'code'), { ...(after ? { after: Number(after) } : {}), limit })
      return c.json({ lines: lines.map((l) => ({ id: l.id, who: l.who, kind: l.kind, text: l.text, at: new Date(l.at).toISOString() })) })
    }),
  )
  app.post(
    '/api/v1/rooms/:code/say',
    api(async (c, u) => {
      if (!sayLimit.allow(`say:${u.sub}`)) return c.json({ error: 'too many lines; wait a moment' }, 429)
      const b = await body(c)
      return c.json(await svc.say(u, param(c, 'code'), String(b.text ?? ''), b.as ? String(b.as) : undefined))
    }),
  )
  app.post(
    '/api/v1/rooms/:code/expect',
    api(async (c, u) => {
      const b = await body(c)
      svc.expect(u, param(c, 'code'), String(b.name ?? ''), String(b.from ?? ''))
      return c.json({ ok: true, dial_in: config.dialIn, code: param(c, 'code'), within_seconds: 120 })
    }),
  )
  // What ringing a number in would cost: the routes that carry it, cheapest first (least-cost routing).
  app.get(
    '/api/v1/rates',
    api((c) => {
      const q = svc.quote(c.req.query('phone') ?? '')
      return c.json({ to: q.to, max_rate: svc.router.maxRate, daily_cap_usd: svc.dailyCap, spent_today_usd: svc.spentToday(), routes: q.choices.map((r) => ({ provider: r.provider, prefix: `+${r.prefix}`, usd_per_minute: r.rate })) })
    }),
  )
  app.post(
    '/api/v1/rooms/:code/call',
    api(async (c, u) => {
      if (!dialLimit.allow(`call:${u.sub}`)) return c.json({ error: 'too many calls; 10 an hour' }, 429)
      const b = await body(c)
      if (b.sip) {
        const headers = b.headers && typeof b.headers === 'object' ? Object.fromEntries(Object.entries(b.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {}
        return c.json(await svc.callSip(u, param(c, 'code'), String(b.sip), String(b.name ?? ''), headers), 202)
      }
      return c.json(await svc.callPhone(u, param(c, 'code'), String(b.phone ?? b.to ?? ''), b.name ? String(b.name) : ''), 202)
    }),
  )
  app.post(
    '/api/v1/rooms/:code/greeter',
    api(async (c, u) => {
      const b = await body(c)
      return c.json(svc.setGreeter(u, param(c, 'code'), b.agent === null || b.agent === false ? null : String(b.agent ?? ''), b.host ? String(b.host) : ''))
    }),
  )
  app.post(
    '/api/v1/rooms/:code/record',
    api(async (c, u) => c.json(await svc.setRecord(u, param(c, 'code'), (await body(c)).on !== false))),
  )
  const recordingJson = (r: Recording) => ({
    id: r.id,
    status: r.status,
    duration_secs: r.durationSecs,
    bytes: r.bytes,
    started_at: new Date(r.startedAt).toISOString(),
    ended_at: r.endedAt ? new Date(r.endedAt).toISOString() : null,
    mp3: r.status === 'ready' ? `${ORIGIN}/api/v1/recordings/${r.id}.mp3` : null,
    ...(r.note ? { note: r.note } : {}),
  })
  app.get('/api/v1/rooms/:code/recordings', api((c, u) => c.json({ recordings: svc.recordings(u, param(c, 'code')).map(recordingJson) })))
  app.get(
    '/api/v1/recordings/:file{rec_[A-Za-z0-9_-]+\\.mp3}',
    api((c, u) => {
      const rec = svc.ownRecording(u, param(c, 'file').replace(/\.mp3$/, ''))
      if (!rec) return c.json({ error: 'not found' }, 404)
      return mp3(rec)
    }),
  )
  // The contacts book: people and agents to invite by name. Our own agents are listed for operators (builtin).
  app.get('/api/v1/contacts', api((c, u) => c.json({ contacts: svc.book(u) })))
  app.post('/api/v1/contacts', api(async (c, u) => c.json(svc.saveContact(u, await body(c)), 201)))
  app.patch('/api/v1/contacts/:id', api(async (c, u) => c.json(svc.saveContact(u, await body(c), param(c, 'id')))))
  app.delete(
    '/api/v1/contacts/:id',
    api((c, u) => {
      svc.removeContact(u, param(c, 'id'))
      return c.json({ ok: true })
    }),
  )
  // "invite riotcoder, Kim": each name found in the book and dialled the way it is reached.
  app.post(
    '/api/v1/rooms/:code/invite',
    api(async (c, u) => {
      if (!dialLimit.allow(`call:${u.sub}`)) return c.json({ error: 'too many calls; 10 an hour' }, 429)
      const b = await body(c)
      const names = Array.isArray(b.names) ? b.names.map(String) : String(b.names ?? b.name ?? '')
      return c.json(await svc.inviteNames(u, param(c, 'code'), names), 202)
    }),
  )
  app.post(
    '/api/v1/rooms/:code/agents',
    api(async (c, u) => {
      const invite = svc.inviteAgent(u, param(c, 'code'), String((await body(c)).agent ?? ''))
      return c.json({ id: invite.id, agent: invite.agent, status: invite.status }, 202)
    }),
  )

  // ---- the agent worker --------------------------------------------------------
  // The box our agents run on cannot take webhooks, so it asks here for work.

  const workerOk = (c: Context) => {
    const key = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    return Boolean(config.agentWorkerKey) && sameSecret(key, config.agentWorkerKey!)
  }
  app.post('/api/v1/agent-queue/next', (c) => {
    if (!workerOk(c)) return c.json({ error: 'worker key required' }, 401)
    const invite = svc.nextInvite()
    return invite ? c.json(invite) : c.body(null, 204)
  })
  // Work our voice agents took on during calls: the worker hands each to the agent's task runner.
  app.post('/api/v1/agent-queue/tasks/next', (c) => {
    if (!workerOk(c)) return c.json({ error: 'worker key required' }, 401)
    const task = svc.nextTask()
    return task ? c.json({ id: task.id, agent: task.agent, code: task.code, room_name: task.roomName, brief: task.brief, ack: task.ack, said: task.said, at: new Date(task.createdAt).toISOString() }) : c.body(null, 204)
  })

  // The tools our ElevenLabs voice agents call during a call (src/agents.ts).
  const agentTools = toolHandler({ basePath: '/api/agent-tools', secret: config.agentToolSecret ?? '', tools: svc.agentTools(), log: (m) => console.log(m) })
  // Tools without parameters arrive as GET (ElevenLabs will not POST without a body schema).
  app.on(['GET', 'POST'], '/api/agent-tools/:tool', async (c) => (await agentTools(c.req.raw)) ?? c.json({ error: 'not found' }, 404))
  /** For an agent on a call: is anybody (a person) still in the room? */
  app.post('/api/v1/agent-queue/rooms/:code/text', async (c) => {
    if (!workerOk(c)) return c.json({ error: 'worker key required' }, 401)
    const b = await body(c)
    try {
      return c.json(await svc.textRoom(codeParam(c), String(b.text ?? ''), { name: String(b.agent ?? 'an agent').slice(0, 40) }))
    } catch (e) {
      return c.json({ error: message(e) }, statusOf(e) as 400)
    }
  })
  app.get('/api/v1/agent-queue/rooms/:code', (c) => {
    if (!workerOk(c)) return c.json({ error: 'worker key required' }, 401)
    return c.json(svc.roomStatus(codeParam(c)))
  })
  /**
   * For an agent on a call: the room's lines after `after`, as group.call heard them (one
   * transcription per leg, so each line has its speaker; agent echo already dropped). Waits up
   * to `wait` seconds for the next one, so an agent hears a line as soon as it lands.
   */
  app.get('/api/v1/agent-queue/rooms/:code/lines', async (c) => {
    if (!workerOk(c)) return c.json({ error: 'worker key required' }, 401)
    const code = codeParam(c)
    const after = Number(c.req.query('after') ?? 0)
    const waitMs = Math.min(25, Math.max(0, Number(c.req.query('wait') ?? 20))) * 1000
    const shape = (lines: ReturnType<typeof store.transcript>) => ({ lines: lines.map((l) => ({ id: l.id, who: l.who, kind: l.kind, text: l.text, at: l.at, trusted: svc.trusted(l.who, l.kind) })) })
    const now = store.transcript(code, { after, limit: 200 })
    if (now.length || waitMs === 0) return c.json(shape(now))
    const lines = await new Promise<ReturnType<typeof store.transcript>>((resolve) => {
      const timer = setTimeout(() => {
        off()
        resolve([])
      }, waitMs)
      const off = svc.subscribe(code, (e) => {
        if (e.type !== 'line') return
        clearTimeout(timer)
        off()
        resolve(store.transcript(code, { after, limit: 200 }))
      })
    })
    return c.json(shape(lines))
  })
  app.post('/api/v1/agent-queue/:id', async (c) => {
    if (!workerOk(c)) return c.json({ error: 'worker key required' }, 401)
    const b = await body(c)
    const done = svc.finishInvite(param(c, 'id'), b.ok === true, String(b.note ?? ''))
    return done ? c.json(done) : c.json({ error: 'not found' }, 404)
  })

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : page(c, messagePage(ctxOf(c), { title: 'Not found', message: 'That page does not exist.' }), 404)))
  app.onError((error, c) => {
    console.error(error instanceof Error ? error.message : error)
    return c.req.path.startsWith('/api/') ? c.json({ error: 'Something went wrong.' }, 500) : page(c, messagePage(ctxOf(c), { title: 'Something went wrong', message: 'Try again in a moment.' }), 500)
  })
  return { app, svc }
}

export function serve(options: { port?: number; hostname?: string } = {}) {
  const env = process.env
  const key = env.GROUPCALL_KEY ?? ''
  const smtpPassword = env.GROUPCALL_SMTP_PASS ?? env.MAIL_WORK_PASSWORD ?? ''
  const smtpUser = env.GROUPCALL_SMTP_USER ?? env.MAIL_WORK_USER ?? 'anthony@profullstack.com'
  const emailFrom = env.GROUPCALL_EMAIL_FROM ?? 'Anthony <anthony@profullstack.com>'
  const smtp = smtpPassword
    ? createTransport({
        host: env.GROUPCALL_SMTP_HOST ?? 'smtp.forwardemail.net',
        port: Number(env.GROUPCALL_SMTP_PORT ?? 465),
        secure: (env.GROUPCALL_SMTP_SECURE ?? 'true').toLowerCase() !== 'false',
        auth: { user: smtpUser, pass: smtpPassword },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      })
    : null
  const sendInvitationEmail = smtp
    ? async (message: InvitationEmail) => {
        const result = await smtp.sendMail({ from: emailFrom, to: message.to, subject: message.subject, text: message.text })
        const accepted = (result.accepted ?? []) as Array<string | { address: string }>
        if (!accepted.some((address) => (typeof address === 'string' ? address : address.address).toLowerCase() === message.to.toLowerCase())) {
          throw new Error('SMTP did not accept the recipient')
        }
      }
    : undefined
  const broadcastStreamKey = env.GROUPCALL_BROADCAST_STREAM_KEY ?? ''
  const broadcastStreamUrl = new URL(
    env.GROUPCALL_BROADCAST_STREAM_URL
      ?? `${(env.GROUPCALL_ORIGIN ?? SITE).replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')}/api/v1/broadcast/stream`,
  )
  if (broadcastStreamKey) broadcastStreamUrl.searchParams.set('key', broadcastStreamKey)
  const store = new Store(env.GROUPCALL_DB ?? `${env.HOME}/.local/share/group-call/group-call.db`, new Sealer(key))
  for (const name of ['GROUPCALL_COINPAY_CLIENT_ID', 'GROUPCALL_DIAL_IN']) {
    if (!env[name]) throw new Error(`${name} must be set`)
  }
  const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  // Operators are CoinPay subs. Emails are ignored (CoinPay emails are unverified).
  const operatorList = (v: string | undefined) => {
    const all = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const emails = all.filter((s) => s.includes('@'))
    if (emails.length) console.warn(`GROUPCALL_AGENT_OPERATORS: ignoring ${emails.length} email entr${emails.length === 1 ? 'y' : 'ies'}; list CoinPay subs instead`)
    return all.filter((s) => !s.includes('@'))
  }
  // Least-cost routing: several ways out, each with a rate deck. Unset, TELNYX_CONNECTION_ID calls the US and Canada.
  const routesFile = env.GROUPCALL_ROUTES ? loadRoutes(env.GROUPCALL_ROUTES) : null
  const { app, svc } = createApp({
    store,
    ...(env.GROUPCALL_ORIGIN ? { origin: env.GROUPCALL_ORIGIN } : {}),
    config: {
      key,
      coinpayBase: env.COINPAY_BASE ?? 'https://coinpayportal.com',
      clientId: env.GROUPCALL_COINPAY_CLIENT_ID!,
      ...(env.GROUPCALL_COINPAY_CLIENT_SECRET ? { clientSecret: env.GROUPCALL_COINPAY_CLIENT_SECRET } : {}),
      ...(env.COINPAY_API_KEY ? { coinpayApiKey: env.COINPAY_API_KEY } : {}),
      ...(env.COINPAY_WEBHOOK_SECRET ? { coinpayWebhookSecret: env.COINPAY_WEBHOOK_SECRET } : {}),
      ...(env.TELNYX_API_KEY ? { telnyxApiKey: env.TELNYX_API_KEY } : {}),
      ...(env.TELNYX_PUBLIC_KEY ? { telnyxPublicKey: env.TELNYX_PUBLIC_KEY } : {}),
      dialIn: env.GROUPCALL_DIAL_IN!,
      ...(env.TELNYX_CONNECTION_ID ? { telnyxConnectionId: env.TELNYX_CONNECTION_ID } : {}),
      ...(routesFile ? { routes: routesFile.routes } : {}),
      ...(env.GROUPCALL_DAILY_SPEND_USD ? { dailySpendUsd: Number(env.GROUPCALL_DAILY_SPEND_USD) } : {}),
      ...(env.GROUPCALL_MAX_RATE ? { maxRate: Number(env.GROUPCALL_MAX_RATE) } : routesFile?.maxRate !== undefined ? { maxRate: routesFile.maxRate } : {}),
      ...(env.GROUPCALL_VOICE ? { voice: env.GROUPCALL_VOICE } : {}),
      ...(env.GROUPCALL_VOICE_KEY_REF ? { telnyxVoiceKeyRef: env.GROUPCALL_VOICE_KEY_REF } : {}),
      agentOperators: operatorList(env.GROUPCALL_AGENT_OPERATORS),
      ...(env.GROUPCALL_AGENT_WORKER_KEY ? { agentWorkerKey: env.GROUPCALL_AGENT_WORKER_KEY } : {}),
      ...(sendInvitationEmail ? { sendInvitationEmail } : {}),
      knownCallers: Object.fromEntries(
        (env.GROUPCALL_KNOWN_CALLERS ?? '')
          .split(',')
          .map((pair) => pair.split('=').map((x) => x.trim()))
          .filter((kv): kv is [string, string] => kv.length === 2 && Boolean(kv[0]) && Boolean(kv[1])),
      ),
      // riotcoder=sip:+1415...@sip.rtc.elevenlabs.io;transport=tcp,cha0spunk=...: split on the first = only.
      agentSip: Object.fromEntries(
        (env.GROUPCALL_AGENT_SIP ?? '')
          .split(',')
          .map((pair) => [pair.slice(0, pair.indexOf('=')).trim(), pair.slice(pair.indexOf('=') + 1).trim()] as [string, string])
          .filter(([k, v]) => k && v.startsWith('sip')),
      ),
      ...(env.GROUPCALL_AGENT_TOOL_SECRET ? { agentToolSecret: env.GROUPCALL_AGENT_TOOL_SECRET } : {}),
      agentCallerIds: Object.fromEntries(
        (env.GROUPCALL_AGENT_CALLER_IDS ?? '')
          .split(',')
          .map((pair) => pair.split('=').map((x) => x.trim()))
          .filter((kv): kv is [string, string] => kv.length === 2 && Boolean(kv[0]) && Boolean(kv[1])),
      ),
      transcribe: (env.GROUPCALL_TRANSCRIBE ?? '1') !== '0',
      freeMinutes: Number(env.GROUPCALL_FREE_MINUTES ?? 300),
      recordingsDir: env.GROUPCALL_RECORDINGS ?? `${env.HOME}/.local/share/group-call/recordings`,
      ...(env.GROUPCALL_SIP_HOSTS ? { sipHosts: list(env.GROUPCALL_SIP_HOSTS) } : {}),
      ...(env.GROUPCALL_MESSAGING_PROFILE_ID ? { messagingProfileId: env.GROUPCALL_MESSAGING_PROFILE_ID } : {}),
      ...(env.GROUPCALL_SMSHUB_URL ? { smshubUrl: env.GROUPCALL_SMSHUB_URL } : {}),
      ...(broadcastStreamKey && env.GROUPCALL_BROADCAST_NIXAMP_URL && (env.GROUPCALL_BROADCAST_NIXAMP_KEY || env.GROUPCALL_BROADCAST_NIXAMP_TOKEN)
        ? { broadcast: {
            streamUrl: broadcastStreamUrl.toString(),
            nixampUrl: env.GROUPCALL_BROADCAST_NIXAMP_URL,
            ...(env.GROUPCALL_BROADCAST_NIXAMP_KEY ? { nixampKey: env.GROUPCALL_BROADCAST_NIXAMP_KEY } : {}),
            ...(env.GROUPCALL_BROADCAST_NIXAMP_TOKEN ? { nixampToken: env.GROUPCALL_BROADCAST_NIXAMP_TOKEN } : {}),
            name: env.GROUPCALL_BROADCAST_NAME ?? 'TUI Weekly live',
          } }
        : {}),
    },
  })
  const trustProxy = (env.GROUPCALL_TRUST_PROXY ?? '1') === '1'
  // Rooms that were live when the last process stopped come back before the first webhook is served.
  void svc
    .restore()
    .then((r) => r.rooms && console.log(`group.call: restored ${r.rooms} room(s), ${r.legs} on the line`))
    .catch((e) => console.error('group.call: restore failed:', e))
  // Customer webhooks: deliveries waiting from before the restart go out now, then every 5 s.
  svc.hooks.start()
  startRingRefresh()
  startPitFooterRefresh(SELF)
  startRingFooterRefresh()
  let server: ReturnType<typeof Bun.serve>
  server = Bun.serve({
    port: options.port ?? Number(env.PORT ?? 8810),
    hostname: options.hostname ?? env.HOST ?? '127.0.0.1',
    // Server-sent events stay open; Bun's idle timeout tops out at 255 s and the ping is every 25.
    idleTimeout: 255,
    fetch(request, srv) {
      if (new URL(request.url).pathname === '/api/v1/broadcast/stream' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (!svc.broadcastRelay || !broadcastStreamKey) return new Response('live broadcast is not configured', { status: 404 })
        if (!sameSecret(broadcastStreamKey, new URL(request.url).searchParams.get('key') ?? '')) return new Response('unauthorized', { status: 401 })
        if (server.upgrade(request, { data: {} })) return undefined
        return new Response('websocket upgrade failed', { status: 400 })
      }
      const peer = srv.requestIP(request)?.address ?? ''
      const forwarded = trustProxy && (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') ? request.headers.get('x-real-ip') : null
      return app.fetch(request, { ip: forwarded || peer })
    },
    websocket: {
      open: (socket) => svc.broadcastRelay?.accept(socket),
      message: (socket, message) => void svc.broadcastRelay?.message(message as string | Buffer),
      close: () => svc.broadcastRelay?.close(),
    },
  })
  return server
}

if (import.meta.main) {
  const server = serve()
  console.log(`group.call listening on http://${server.hostname}:${server.port}`)
}
