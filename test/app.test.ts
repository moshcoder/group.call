import { describe, expect, test } from 'bun:test'
import { createHmac, generateKeyPairSync, sign as signMessage } from 'node:crypto'
import { signWebhook } from '@profullstack/coinpay-onboard'
import { createApp } from '../src/server.ts'
import { Sealer, Store } from '../src/db.ts'
import { FREE_ROOMS, telLink } from '../src/service.ts'

/** An ed25519 pair standing in for the Telnyx account's, so a test can sign webhooks. */
function telnyxKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') }
}

/** How Telnyx answers a text: sent, or 40010 (no 10DLC campaign). */
let smsReply: 'ok' | '40010' = 'ok'
/** How the fake smshub.dev answers: fine, down, or refusing the key. */
let smshubMode: 'ok' | 'down' | 'badkey' = 'ok'

/** A fetch that records what Telnyx was asked; a conference creation answers with an id. */
function telnyxRecorder() {
  const calls: { path: string; body: any }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('https://files.test/')) return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200 })
    if (String(url).startsWith('https://smshub.test/')) {
      const path = String(url).replace('https://smshub.test', '')
      calls.push({ path: `smshub:${init?.method ?? 'GET'} ${path}`, body: init?.body ? JSON.parse(String(init.body)) : {} })
      if (smshubMode === 'badkey') return new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 401 })
      if (smshubMode === 'down') return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 })
      if (path.endsWith('/send')) return new Response(JSON.stringify({ sent: 2, failed: 0, skipped: 0, from: '+14155550100' }), { status: 200 })
      return new Response(JSON.stringify(init?.method === 'POST' ? { id: 'g1' } : { groups: [] }), { status: init?.method === 'POST' ? 201 : 200 })
    }
    const path = String(url).replace('https://api.telnyx.com/v2', '')
    calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) })
    if (path === '/messages' && smsReply === '40010') return new Response(JSON.stringify({ errors: [{ code: '40010', title: 'Not 10DLC registered' }] }), { status: 400 })
    const json = path === '/conferences' ? { data: { id: 'conf-1' } } : path === '/calls' ? { data: { call_control_id: 'out-1' } } : {}
    return new Response(JSON.stringify(json), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

const DIAL_IN = '+15106169327'
const AGENT_CALLER = '+19492847328'

function setup(extra: Record<string, unknown> = {}) {
  const keys = telnyxKeys()
  const telnyx = telnyxRecorder()
  const store = new Store(':memory:', new Sealer('k'.repeat(32)))
  const { app, svc } = createApp({
    store,
    origin: 'https://group.call.test',
    secureCookies: false,
    config: {
      key: 'k'.repeat(32),
      clientId: 'cp_test',
      coinpayBase: 'https://coinpayportal.com',
      coinpayWebhookSecret: 'whsec',
      telnyxApiKey: 'KEY_test',
      telnyxPublicKey: keys.publicKey,
      dialIn: DIAL_IN,
      telnyxConnectionId: 'conn-gc',
      agentOperators: ['sub-op'],
      agentWorkerKey: 'worker-secret',
      agentCallerIds: { riotcoder: AGENT_CALLER, cha0spunk: '+15107667447' },
      fetch: telnyx.fetch,
      ...extra,
    },
  })
  const tokens = { accessToken: 'a', refreshToken: null, expiresAt: 0 }
  const op = store.upsertUser('sub-op', 'Anthony', 'op@example.com', tokens)
  const guest = store.upsertUser('sub-guest', 'Guest', 'guest@example.com', tokens)
  store.setApiKey(op.sub, 'gc_op')
  store.setApiKey(guest.sub, 'gc_guest')

  const call = (key: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })

  /** A Telnyx event, signed the way Telnyx signs it. */
  const event = async (event_type: string, payload: Record<string, unknown>, route = '/api/telnyx/voice') => {
    const raw = JSON.stringify({ data: { event_type, payload } })
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = signMessage(null, Buffer.from(`${ts}|${raw}`), keys.privateKey).toString('base64')
    const r = await app.request(route, { method: 'POST', body: raw, headers: { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    return r
  }
  return { app, svc, store, telnyx, call, event, op, guest }
}

describe('rooms', () => {
  test('a room gets a four-digit code and a tel: link that dials and keys it', async () => {
    const { call } = setup()
    const r = await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Standup' })
    expect(r.status).toBe(201)
    const room = (await r.json()) as any
    expect(room.code).toMatch(/^[1-9]\d{3}$/)
    expect(room.dial_in).toBe(DIAL_IN)
    expect(room.tel).toBe(telLink(DIAL_IN, room.code))
    expect(room.tel).toContain(`,,,${room.code}%23`)
  })

  test(`a free account has ${FREE_ROOMS} rooms, and picking a code needs a pass`, async () => {
    const { call } = setup()
    for (let i = 0; i < FREE_ROOMS; i++) expect((await call('gc_guest', 'POST', '/api/v1/rooms', { name: `r${i}` })).status).toBe(201)
    const over = await call('gc_guest', 'POST', '/api/v1/rooms', { name: 'one more' })
    expect(over.status).toBe(402)
    const picked = await call('gc_op', 'POST', '/api/v1/rooms', { name: 'mine', code: '4821' })
    expect(picked.status).toBe(402)
  })

  test('a paid pass lifts the limit and lets you pick the code', async () => {
    const { call, store, op } = setup()
    store.addPass({ id: 'cs_1', sub: op.sub, amountCents: 500, checkoutUrl: 'https://coinpayportal.com/c/cs_1', days: 30 })
    store.markPassPaid('cs_1')
    const r = await call('gc_op', 'POST', '/api/v1/rooms', { name: 'mine', code: '4821' })
    expect(r.status).toBe(201)
    expect(((await r.json()) as any).code).toBe('4821')
    expect((await call('gc_op', 'POST', '/api/v1/rooms', { name: 'again', code: '4821' })).status).toBe(409)
  })

  test("somebody else's room is not yours to see or change", async () => {
    const { call } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'private' })).json()) as any
    expect((await call('gc_guest', 'GET', `/api/v1/rooms/${room.code}`)).status).toBe(404)
    expect((await call('gc_guest', 'DELETE', `/api/v1/rooms/${room.code}`)).status).toBe(404)
  })

  test('no key, no API', async () => {
    const { app } = setup()
    expect((await app.request('/api/v1/rooms')).status).toBe(401)
  })
})

describe('the phone line', () => {
  test('an unsigned webhook is refused', async () => {
    const { app } = setup()
    const r = await app.request('/api/telnyx/voice', { method: 'POST', body: '{"data":{}}' })
    expect(r.status).toBe(401)
  })

  test('a caller is asked for four digits, refused a code that is no room, and let into one that is', async () => {
    const { call, event, telnyx, svc } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Standup' })).json()) as any
    await event('call.initiated', { call_control_id: 'leg-1', direction: 'incoming', from: '+15550001111' })
    await event('call.answered', { call_control_id: 'leg-1' })
    const ask = telnyx.calls.find((c) => c.path.endsWith('/gather_using_speak'))
    expect(ask?.body.maximum_digits).toBe(4)
    expect(ask?.body.payload).toContain('four digit room code')

    const wrong = room.code === '9999' ? '8888' : '9999'
    await event('call.gather.ended', { call_control_id: 'leg-1', digits: wrong })
    expect(telnyx.calls.some((c) => c.path === '/conferences')).toBe(false)
    expect(telnyx.calls.at(-1)?.body.payload).toStartWith('That is not a room.')

    await event('call.gather.ended', { call_control_id: 'leg-1', digits: room.code })
    expect(telnyx.calls.some((c) => c.path === '/conferences')).toBe(true)
    expect(telnyx.calls.at(-1)?.body.payload).toContain('Welcome to Standup.')
    expect(svc.live(room.code)).toEqual([{ name: 'caller ending 11', kind: 'person', since: expect.any(Number) }])
  })

  test('the room page streams who joins', async () => {
    const { call, event, svc } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Live' })).json()) as any
    const seen: string[] = []
    svc.subscribe(room.code, (e) => seen.push(`${e.type}:${e.who}:${e.callers}`))
    await event('call.initiated', { call_control_id: 'leg-1', direction: 'incoming', from: '+15550001111' })
    await event('call.gather.ended', { call_control_id: 'leg-1', digits: room.code })
    await event('call.hangup', { call_control_id: 'leg-1' })
    expect(seen).toEqual(['join:caller ending 11:1', 'leave:caller ending 11:0'])
  })

  test('say reads a line into the room only when somebody is there', async () => {
    const { call, event, telnyx } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Talk' })).json()) as any
    const empty = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/say`, { text: 'hello' })).json()) as any
    expect(empty.said).toBe(false)
    await event('call.initiated', { call_control_id: 'leg-1', direction: 'incoming', from: '+15550001111' })
    await event('call.gather.ended', { call_control_id: 'leg-1', digits: room.code })
    const said = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/say`, { text: 'hello', as: 'bot' })).json()) as any
    expect(said).toEqual({ said: true, callers: 1 })
    expect(telnyx.calls.at(-1)?.body.payload).toBe('bot says: hello')
  })
})

describe('agents', () => {
  test('an operator is a CoinPay sub; a CoinPay account carrying an operator email gets nothing', async () => {
    const { svc, store, op } = setup({ agentOperators: ['sub-op', 'op@example.com'] })
    expect(svc.mayInviteAgents(op)).toBe(true)
    // CoinPay never verifies emails: anyone can sign up there with the operator's address.
    const thief = store.upsertUser('sub-thief', 'Mallory', 'op@example.com', { accessToken: 'a', refreshToken: null, expiresAt: 0 })
    expect(svc.mayInviteAgents(thief)).toBe(false)
    expect(svc.mayCallPhones(thief)).toBe(false)
    expect(store.user('sub-op')?.email).toBe('op@example.com')
    expect(() => svc.inviteAgent(thief, svc.createRoom(thief, { name: 'x' }).code, 'riotcoder')).toThrow()
  })

  test('only operators can ask our agents in; the worker claims it once; the agent arrives named', async () => {
    const { call, event, svc, app } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Agents' })).json()) as any
    const guestRoom = (await (await call('gc_guest', 'POST', '/api/v1/rooms', { name: 'Mine' })).json()) as any
    expect((await call('gc_guest', 'POST', `/api/v1/rooms/${guestRoom.code}/agents`, { agent: 'riotcoder' })).status).toBe(403)

    const invited = await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/agents`, { agent: 'riotcoder' })
    expect(invited.status).toBe(202)
    // Asking twice while it is on the way is the same invite.
    const again = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/agents`, { agent: 'riotcoder' })).json()) as any
    expect(again.id).toBe(((await invited.json()) as any).id)

    expect((await app.request('/api/v1/agent-queue/next', { method: 'POST' })).status).toBe(401)
    const worker = { authorization: 'Bearer worker-secret' }
    const next = (await (await app.request('/api/v1/agent-queue/next', { method: 'POST', headers: worker })).json()) as any
    expect(next).toMatchObject({ agent: 'riotcoder', code: room.code, dial_in: DIAL_IN, room_name: 'Agents', status: 'dialling' })
    expect((await app.request('/api/v1/agent-queue/next', { method: 'POST', headers: worker })).status).toBe(204)

    await event('call.initiated', { call_control_id: 'leg-a', direction: 'incoming', from: AGENT_CALLER })
    await event('call.gather.ended', { call_control_id: 'leg-a', digits: room.code })
    expect(svc.live(room.code)).toEqual([{ name: 'riotcoder', kind: 'agent', since: expect.any(Number) }])

    const done = await app.request(`/api/v1/agent-queue/${next.id}`, { method: 'POST', headers: { ...worker, 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, note: 'left after 3 min' }) })
    expect(((await done.json()) as any).status).toBe('done')
  })

  test("your own agent can be named before it dials in from its own number", async () => {
    const { call, event, svc } = setup()
    const room = (await (await call('gc_guest', 'POST', '/api/v1/rooms', { name: 'Mine' })).json()) as any
    expect((await call('gc_guest', 'POST', `/api/v1/rooms/${room.code}/expect`, { name: 'my-bot', from: '+1 (555) 222-3333' })).status).toBe(200)
    await event('call.initiated', { call_control_id: 'leg-b', direction: 'incoming', from: '+15552223333' })
    await event('call.gather.ended', { call_control_id: 'leg-b', digits: room.code })
    expect(svc.live(room.code)[0]).toMatchObject({ name: 'my-bot', kind: 'agent' })
  })
})

describe('room passes', () => {
  test("CoinPay's signed webhook turns a pass on once; an unsigned one does nothing", async () => {
    const { app, store, op } = setup()
    store.addPass({ id: 'cs_9', sub: op.sub, amountCents: 500, checkoutUrl: 'https://coinpayportal.com/c/cs_9', days: 30 })
    const raw = JSON.stringify({ id: 'evt_1', type: 'payment.confirmed', data: { payment_id: 'pay_1', status: 'confirmed', checkout_session_id: 'cs_9' } })
    expect((await app.request('/api/coinpay/webhook', { method: 'POST', body: raw })).status).toBe(401)
    expect(store.passUntil(op.sub)).toBeNull()
    const r = await app.request('/api/coinpay/webhook', { method: 'POST', body: raw, headers: { 'x-coinpay-signature': signWebhook(raw, 'whsec') } })
    expect(r.status).toBe(200)
    expect(store.passUntil(op.sub)).toBeGreaterThan(Date.now() + 29 * 86400_000)
  })
})

describe('pages', () => {
  test('the home page is a clear, trackable call landing page and carries the PWA manifest', async () => {
    const { app } = setup()
    const r = await app.request('/?utm_source=search&utm_campaign=fall&discard=not-forwarded')
    const html = await r.text()
    expect(r.status).toBe(200)
    expect(html).toContain('510-616-9327')
    expect(html).toContain('People and AI agents, on the same call.')
    expect(html).toContain('Start a call')
    expect(html).toContain('data-analytics-event="start_call"')
    expect(html).toContain('/auth/start?next=/start&amp;utm_source=search&amp;utm_campaign=fall')
    expect(html).not.toContain('discard=not-forwarded')
    expect(html).toContain('rel="manifest"')
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect((await app.request('/manifest.webmanifest')).headers.get('content-type')).toContain('manifest+json')
    expect((await app.request('/sw.js')).headers.get('cache-control')).toBe('no-cache')
  })

  test('one signed-in tap starts a room and carries UTM values into it', async () => {
    const { app, store, guest } = setup()
    const sid = store.newSession(guest.sub)
    const csrf = createHmac('sha256', 'k'.repeat(32)).update(`csrf:${sid}`).digest('hex').slice(0, 32)
    const r = await app.request('/start?utm_source=search&utm_campaign=fall', {
      method: 'POST',
      headers: { cookie: `gc_session=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString(),
    })
    expect(r.status).toBe(303)
    expect(r.headers.get('location')).toMatch(/^\/r\/\d{4}\?made=1&utm_source=search&utm_campaign=fall$/)
    expect(store.rooms(guest.sub)).toHaveLength(1)
  })

  test('CoinPay sign-in remembers the start intent and only the approved campaign fields', async () => {
    const fetch = async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname
      if (path === '/api/oauth/token') return new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }), { status: 200 })
      if (path === '/api/oauth/userinfo') return new Response(JSON.stringify({ sub: 'sub-new', name: 'New User', email: 'new@example.com' }), { status: 200 })
      return new Response('{}', { status: 404 })
    }
    const { app, store } = setup({ fetch })
    const r = await app.request('/auth/start?next=/start&utm_source=search&utm_campaign=fall&discard=no')
    const authorize = new URL(r.headers.get('location')!)
    expect(r.status).toBe(302)
    const state = authorize.searchParams.get('state')!
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.start$/)
    const cookie = r.headers.get('set-cookie')!
    expect(cookie).toContain('gc_campaign=utm_source%3Dsearch%26utm_campaign%3Dfall')
    expect(r.headers.get('set-cookie')).not.toContain('discard')

    const callback = await app.request(`/auth/callback?state=${encodeURIComponent(state)}&code=approved`, { headers: { cookie: cookie.split(';', 1)[0]! } })
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toMatch(/^\/r\/\d{4}\?made=1&utm_source=search&utm_campaign=fall$/)
    expect(store.rooms('sub-new')).toHaveLength(1)
  })

  test('a room page needs you signed in, and is only its owner\'s', async () => {
    const { app } = setup()
    const r = await app.request('/r/4821')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toContain('/auth/start?next=/r/4821')
  })
})

test('the copied invitation is plain words a text message can carry', async () => {
  const { invitation } = await import('../src/html.ts')
  expect(invitation('Test', '+15106169327', '9474')).toBe('Join "Test" on group.call: call 510-616-9327, then key 9474#')
})

test('what people and agents say is written down live, per speaker, and served back', async () => {
  const { call, event, svc, app } = setup()
  const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Talk' })).json()) as any
  const seen: string[] = []
  svc.subscribe(room.code, (e) => e.type === 'line' && seen.push(`${e.who}: ${e.text}`))
  svc.line!.expect(room.code, AGENT_CALLER, 'riotcoder')
  await event('call.initiated', { call_control_id: 'leg-a', direction: 'incoming', from: AGENT_CALLER })
  await event('call.gather.ended', { call_control_id: 'leg-a', digits: room.code })
  await event('call.initiated', { call_control_id: 'leg-p', direction: 'incoming', from: '+15550001111' })
  await event('call.gather.ended', { call_control_id: 'leg-p', digits: room.code })
  await event('call.transcription', { call_control_id: 'leg-p', transcription_data: { transcript: 'riotcoder, what is two plus two?', is_final: true } })
  await event('call.transcription', { call_control_id: 'leg-a', transcription_data: { transcript: 'Four.', is_final: true } })
  await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/say`, { text: 'ok', as: 'Anthony' })
  expect(seen).toEqual(['caller ending 11: riotcoder, what is two plus two?', 'riotcoder: Four.', 'Anthony: ok'])
  const api = (await (await call('gc_op', 'GET', `/api/v1/rooms/${room.code}/transcript`)).json()) as any
  expect(api.lines.map((l: any) => `${l.kind}/${l.who}: ${l.text}`)).toEqual(['person/caller ending 11: riotcoder, what is two plus two?', 'agent/riotcoder: Four.', 'typed/Anthony: ok'])
  const newer = (await (await call('gc_op', 'GET', `/api/v1/rooms/${room.code}/transcript?after=${api.lines[1].id}`)).json()) as any
  expect(newer.lines.map((l: any) => l.text)).toEqual(['ok'])
  expect((await call('gc_guest', 'GET', `/api/v1/rooms/${room.code}/transcript`)).status).toBe(404)
})

describe('a deploy does not touch a live room', () => {
  test('a new process restores who is on the line, with names, and keeps the same conference', async () => {
    const keys = telnyxKeys()
    const joined = new Set<string>()
    const posts: string[] = []
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace('https://api.telnyx.com/v2', '')
      const method = init?.method ?? 'GET'
      if (method === 'POST') posts.push(path)
      if (method === 'POST' && path === '/conferences') return new Response(JSON.stringify({ data: { id: 'conf-1' } }))
      if (method === 'GET' && path === '/conferences/conf-1') return new Response(JSON.stringify({ data: { id: 'conf-1', status: 'in_progress' } }))
      if (method === 'GET' && path.startsWith('/conferences/conf-1/participants')) return new Response(JSON.stringify({ data: [...joined].map((id) => ({ call_control_id: id, status: 'joined' })) }))
      return new Response('{}')
    }) as unknown as typeof globalThis.fetch
    const store = new Store(':memory:', new Sealer('k'.repeat(32)))
    const config = { key: 'k'.repeat(32), clientId: 'cp', coinpayBase: 'https://coinpayportal.com', telnyxApiKey: 'KEY', telnyxPublicKey: keys.publicKey, dialIn: DIAL_IN, agentCallerIds: { riotcoder: AGENT_CALLER, cha0spunk: '+15107667447' }, agentOperators: ['sub-op'], agentWorkerKey: 'w', fetch }
    const op = store.upsertUser('sub-op', 'Anthony', 'op@example.com', { accessToken: 'a', refreshToken: null, expiresAt: 0 })
    const signedEvent = (app: any) => async (event_type: string, payload: Record<string, unknown>) => {
      const raw = JSON.stringify({ data: { event_type, payload } })
      const ts = String(Math.floor(Date.now() / 1000))
      await app.request('/api/telnyx/voice', { method: 'POST', body: raw, headers: { 'telnyx-signature-ed25519': signMessage(null, Buffer.from(`${ts}|${raw}`), keys.privateKey).toString('base64'), 'telnyx-timestamp': ts } })
      await new Promise((r) => setTimeout(r, 5))
    }

    const first = createApp({ store, config, origin: 'https://t' })
    const room = first.svc.createRoom(op, { name: 'Standup' })
    // Both agents asked in: each is named by its own number, whatever order they arrive in.
    first.svc.inviteAgent(op, room.code, 'riotcoder')
    first.svc.inviteAgent(op, room.code, 'cha0spunk')
    expect(first.svc.nextInvite()?.from).toBe(AGENT_CALLER)
    expect(first.svc.nextInvite()?.from).toBe('+15107667447')
    const ev1 = signedEvent(first.app)
    for (const [leg, from] of [['leg-cha', '+15107667447'], ['leg-riot', AGENT_CALLER], ['leg-me', '+15550001173']] as const) {
      await ev1('call.initiated', { call_control_id: leg, direction: 'incoming', from })
      await ev1('call.gather.ended', { call_control_id: leg, digits: room.code })
      joined.add(leg)
    }
    expect(first.svc.live(room.code).map((p) => p.name)).toEqual(['cha0spunk', 'riotcoder', 'caller ending 73'])

    // The deploy: a new process on the same database.
    const second = createApp({ store, config, origin: 'https://t' })
    expect(await second.svc.restore()).toEqual({ rooms: 1, legs: 3 })
    expect(second.svc.live(room.code).map((p) => p.name).sort()).toEqual(['caller ending 73', 'cha0spunk', 'riotcoder'])
    // Lines keep their speakers, and the next caller joins the same conference.
    const ev2 = signedEvent(second.app)
    await ev2('call.transcription', { call_control_id: 'leg-riot', transcription_data: { transcript: 'still here', is_final: true } })
    expect(store.transcript(room.code).map((l) => `${l.who}: ${l.text}`)).toEqual(['riotcoder: still here'])
    await ev2('call.initiated', { call_control_id: 'leg-late', direction: 'incoming', from: '+15550002222' })
    await ev2('call.gather.ended', { call_control_id: 'leg-late', digits: room.code })
    expect(posts.filter((p) => p === '/conferences').length).toBe(1)
    expect(posts).toContain('/conferences/conf-1/actions/join')
    expect(second.svc.roomStatus(room.code)).toMatchObject({ people: 2, agents: 2 })

    // The worker can ask whether people are still there; nobody else can.
    expect((await second.app.request(`/api/v1/agent-queue/rooms/${room.code}`)).status).toBe(401)
    const status = (await (await second.app.request(`/api/v1/agent-queue/rooms/${room.code}`, { headers: { authorization: 'Bearer w' } })).json()) as any
    expect(status.people).toBe(2)
  })
})

test('an invite stuck "dialling" from an agent that never arrived does not block a new one', async () => {
  const { call, store, svc } = setup()
  const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Stuck' })).json()) as any
  const first = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/agents`, { agent: 'riotcoder' })).json()) as any
  expect(svc.nextInvite()?.id).toBe(first.id)
  // Three minutes later, riotcoder never showed up.
  store.db.query('UPDATE agent_invites SET updated_at = ? WHERE id = ?').run(Date.now() - 3 * 60_000, first.id)
  const again = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/agents`, { agent: 'riotcoder' })).json()) as any
  expect(again.id).not.toBe(first.id)
  expect(again.status).toBe('queued')
  expect(store.invite(first.id)?.status).toBe('failed')
})

test("a known caller is named, and agents can see which recent lines came from someone trusted", async () => {
  const keys = telnyxKeys()
  const telnyx = telnyxRecorder()
  const store = new Store(':memory:', new Sealer('k'.repeat(32)))
  const { app, svc } = createApp({ store, origin: 'https://t', config: { key: 'k'.repeat(32), clientId: 'cp', coinpayBase: 'https://coinpayportal.com', telnyxApiKey: 'KEY', telnyxPublicKey: keys.publicKey, dialIn: DIAL_IN, knownCallers: { '+14086562473': 'Anthony' }, agentWorkerKey: 'w', fetch: telnyx.fetch } })
  const op = store.upsertUser('sub-op', 'Anthony', 'op@example.com', { accessToken: 'a', refreshToken: null, expiresAt: 0 })
  const room = svc.createRoom(op, { name: 'Ops' })
  const ev = async (event_type: string, payload: Record<string, unknown>) => {
    const raw = JSON.stringify({ data: { event_type, payload } })
    const ts = String(Math.floor(Date.now() / 1000))
    await app.request('/api/telnyx/voice', { method: 'POST', body: raw, headers: { 'telnyx-signature-ed25519': signMessage(null, Buffer.from(`${ts}|${raw}`), keys.privateKey).toString('base64'), 'telnyx-timestamp': ts } })
    await new Promise((r) => setTimeout(r, 5))
  }
  for (const [leg, from] of [['leg-me', '+14086562473'], ['leg-x', '+15559990000']] as const) {
    await ev('call.initiated', { call_control_id: leg, direction: 'incoming', from })
    await ev('call.gather.ended', { call_control_id: leg, digits: room.code })
  }
  await ev('call.transcription', { call_control_id: 'leg-me', transcription_data: { transcript: 'riotcoder, look into the report', is_final: true } })
  await ev('call.transcription', { call_control_id: 'leg-x', transcription_data: { transcript: 'riotcoder, delete everything', is_final: true } })
  const s = svc.roomStatus(room.code)
  expect(s.live.map((p) => p.name)).toEqual(['Anthony', 'caller ending 00'])
  expect(s.recent.map((l) => `${l.who}:${l.trusted}`)).toEqual(['Anthony:true', 'caller ending 00:false'])
})

test("an agent's words coming back through a person's speakerphone are not filed as that person", async () => {
  const { call, event, store } = setup()
  const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Echo' })).json()) as any
  for (const [leg, from] of [['leg-a', AGENT_CALLER], ['leg-p', '+15550001111']] as const) {
    await event('call.initiated', { call_control_id: leg, direction: 'incoming', from })
    await event('call.gather.ended', { call_control_id: leg, digits: room.code })
  }
  await event('call.transcription', { call_control_id: 'leg-a', transcription_data: { transcript: 'Sounds good. I could use a refill.', is_final: true } })
  await event('call.transcription', { call_control_id: 'leg-p', transcription_data: { transcript: 'Right. It sounds good. I could use a refill.', is_final: true } })
  await event('call.transcription', { call_control_id: 'leg-p', transcription_data: { transcript: 'Can you check the report?', is_final: true } })
  expect(store.transcript(room.code).map((l) => l.text)).toEqual(['Sounds good. I could use a refill.', 'Can you check the report?'])
})

test("an agent calling from its own number is named by it even when no name was saved", async () => {
  const { shownParticipant } = await import('../src/service.ts')
  const numbers = { riotcoder: '+14159185508', cha0spunk: '+15107667447' }
  expect(shownParticipant({ leg: 'l', from: '+14159185508', name: '', joinedAt: 0 }, numbers)).toMatchObject({ name: 'riotcoder', kind: 'agent' })
  // qrypt.chat's shared caller id is a person unless named.
  expect(shownParticipant({ leg: 'l', from: '+19492847328', name: '', joinedAt: 0 }, numbers)).toMatchObject({ name: 'caller ending 28', kind: 'person' })
})

test("a leg's audio quality is kept on hangup, a poor one is flagged, and agents get the room's history", async () => {
  const { call, event, store, svc } = setup()
  const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Quality' })).json()) as any
  await event('call.initiated', { call_control_id: 'leg-p', direction: 'incoming', from: '+15550001111' })
  await event('call.gather.ended', { call_control_id: 'leg-p', digits: room.code })
  await event('call.transcription', { call_control_id: 'leg-p', transcription_data: { transcript: 'we decided on Tuesday', is_final: true } })
  const status = svc.roomStatus(room.code)
  expect(status.history.map((l) => l.text)).toEqual(['we decided on Tuesday'])
  await event('call.hangup', { call_control_id: 'leg-p', call_quality_stats: { inbound: { mos: '3.1', packet_loss: '2.5' }, outbound: { mos: '4.3' } } })
  expect(store.quality(room.code)[0]).toMatchObject({ who: 'caller ending 11', mosIn: 3.1, mosOut: 4.3, lossPct: 2.5 })
  expect(store.events(room.code).some((e) => e.kind === 'quality' && e.text.includes('poor audio'))).toBe(true)
})

test('an agent joining twice keeps only its newest leg', async () => {
  const { call, event, telnyx } = setup()
  const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Twins' })).json()) as any
  for (const leg of ['leg-old', 'leg-new']) {
    await event('call.initiated', { call_control_id: leg, direction: 'incoming', from: AGENT_CALLER })
    await event('call.gather.ended', { call_control_id: leg, digits: room.code })
  }
  expect(telnyx.calls.some((c) => c.path === '/calls/leg-old/actions/hangup')).toBe(true)
  expect(telnyx.calls.some((c) => c.path === '/calls/leg-new/actions/hangup')).toBe(false)
})

test('an agent can follow the room line by line, waiting for the next', async () => {
  const { call, event, app } = setup()
  const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Lines' })).json()) as any
  await event('call.initiated', { call_control_id: 'leg-p', direction: 'incoming', from: '+15550001111' })
  await event('call.gather.ended', { call_control_id: 'leg-p', digits: room.code })
  const worker = { authorization: 'Bearer worker-secret' }
  expect((await app.request(`/api/v1/agent-queue/rooms/${room.code}/lines`)).status).toBe(401)
  const waiting = app.request(`/api/v1/agent-queue/rooms/${room.code}/lines?after=0&wait=5`, { headers: worker })
  await new Promise((r) => setTimeout(r, 30))
  await event('call.transcription', { call_control_id: 'leg-p', transcription_data: { transcript: 'Chaos Punk, what is 12 plus 30?', is_final: true } })
  const got = (await (await waiting).json()) as any
  expect(got.lines.map((l: any) => `${l.who}: ${l.text}`)).toEqual(['caller ending 11: Chaos Punk, what is 12 plus 30?'])
  const none = (await (await app.request(`/api/v1/agent-queue/rooms/${room.code}/lines?after=${got.lines[0].id}&wait=0`, { headers: worker })).json()) as any
  expect(none.lines).toEqual([])
})

test('the same phrase finalized twice is one line', async () => {
  const { call, event, store } = setup()
  const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Dupes' })).json()) as any
  await event('call.initiated', { call_control_id: 'leg-a', direction: 'incoming', from: AGENT_CALLER })
  await event('call.gather.ended', { call_control_id: 'leg-a', digits: room.code })
  await event('call.transcription', { call_control_id: 'leg-a', transcription_data: { transcript: 'The capital of Japan is Tokyo,', is_final: true } })
  await event('call.transcription', { call_control_id: 'leg-a', transcription_data: { transcript: 'The capital of Japan is Tokyo.', is_final: true } })
  expect(store.transcript(room.code).length).toBe(1)
})

describe('calling someone in', () => {
  test('an operator rings a phone from the room number, and the answer presses 1 to join under its name', async () => {
    const { call, event, telnyx, svc } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Standup' })).json()) as any
    const r = await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '408-656-2473', name: 'Anthony' })
    expect(r.status).toBe(202)
    expect(((await r.json()) as any).to).toBe('408-656-2473')
    const placed = telnyx.calls.find((c) => c.path === '/calls')!
    expect(placed.body).toMatchObject({ to: '+14086562473', from: DIAL_IN, connection_id: 'conn-gc' })
    await event('call.answered', { call_control_id: 'out-1', direction: 'outgoing' })
    expect(telnyx.calls.at(-1)?.body.payload).toContain('Anthony is calling you into Standup. Press 1 to join.')
    await event('call.gather.ended', { call_control_id: 'out-1', digits: '1' })
    expect(svc.live(room.code)).toEqual([expect.objectContaining({ name: 'Anthony', kind: 'person' })])
  })

  test('a known caller the room rang in is named and trusted, though the leg carries no caller number', async () => {
    const { call, event, svc } = setup({ knownCallers: { '+14086562473': 'Anthony' } })
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Standup' })).json()) as any
    await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '408-656-2473' })
    await event('call.answered', { call_control_id: 'out-1', direction: 'outgoing' })
    await event('call.gather.ended', { call_control_id: 'out-1', digits: '1' })
    expect(svc.live(room.code)).toEqual([expect.objectContaining({ name: 'Anthony', kind: 'person', trusted: true })])
  })

  test('a free account cannot ring phones, and nobody can ring premium lines or our own', async () => {
    const { call, telnyx } = setup()
    const mine = (await (await call('gc_guest', 'POST', '/api/v1/rooms', { name: 'mine' })).json()) as any
    expect((await call('gc_guest', 'POST', `/api/v1/rooms/${mine.code}/call`, { phone: '4086562473' })).status).toBe(402)
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'ops' })).json()) as any
    expect((await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+19005551234' })).status).toBe(400)
    expect((await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: DIAL_IN })).status).toBe(400)
    expect((await call('gc_guest', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '4086562473' })).status).toBe(404)
    expect(telnyx.calls.some((c) => c.path === '/calls')).toBe(false)
  })
})

describe('least-cost routing', () => {
  /** A Telnyx that refuses to place calls on the connections named. */
  const refusing = (fetch: typeof globalThis.fetch, bad: string[]) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (String(url).endsWith('/calls') && bad.includes(body.connection_id)) {
        await fetch(url, init) // still recorded
        return new Response('{"errors":[{"title":"Destination not allowed"}]}', { status: 422 })
      }
      return fetch(url, init)
    }) as unknown as typeof globalThis.fetch

  const routes = [
    { provider: 'telnyx', connectionId: 'conn-us', rates: { '1': 0.007, '44': 0.02 } },
    { provider: 'telnyx-intl', connectionId: 'conn-intl', from: '+442071230000', rates: { '44': 0.009, '447': 0.04, '1': 0.01 } },
  ]

  test('the default deck calls every country: the US and Canada at their rate, the rest (Caribbean +1 too) at the high estimate, premium lines never', async () => {
    const { call, telnyx } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'ops' })).json()) as any
    for (const phone of ['+19005551234', '+19765551234']) {
      const r = await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone })
      expect(r.status).toBe(400)
      expect(((await r.json()) as any).error).toContain('will not call that number')
    }
    expect(telnyx.calls.some((c) => c.path === '/calls')).toBe(false)
    expect(await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+16045551234' })).json()).toMatchObject({ rate: 0.007 })
    expect(await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+18765551234' })).json()).toMatchObject({ rate: 0.25 })
    expect(await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+442079460000' })).json()).toMatchObject({ rate: 0.25 })
  })

  test('a call goes out on the cheapest route for its prefix, with that route caller id', async () => {
    const { call, telnyx } = setup({ routes })
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'ops' })).json()) as any
    const uk = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+44 20 7946 0000' })).json()) as any
    expect(uk).toMatchObject({ ringing: true, via: 'telnyx-intl', rate: 0.009 })
    expect(telnyx.calls.filter((c) => c.path === '/calls').at(-1)!.body).toMatchObject({ to: '+442079460000', from: '+442071230000', connection_id: 'conn-intl' })
    // A UK mobile is dearer on the intl route (longest prefix wins there), so the US route carries it.
    const mobile = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+447700900123' })).json()) as any
    expect(mobile).toMatchObject({ via: 'telnyx', rate: 0.02 })
    expect(telnyx.calls.filter((c) => c.path === '/calls').at(-1)!.body).toMatchObject({ from: DIAL_IN, connection_id: 'conn-us' })
  })

  test('a route that will not place the call hands over to the next cheapest', async () => {
    const telnyx = telnyxRecorder()
    const { call } = setup({ routes, fetch: refusing(telnyx.fetch, ['conn-intl']) })
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'ops' })).json()) as any
    const r = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+442079460000' })).json()) as any
    expect(r).toMatchObject({ via: 'telnyx', rate: 0.02 })
    expect(telnyx.calls.filter((c) => c.path === '/calls').map((c) => c.body.connection_id)).toEqual(['conn-intl', 'conn-us'])
  })

  test('nothing dearer than the cap is dialled, and an unrouted country is refused', async () => {
    const { call, telnyx } = setup({ routes, maxRate: 0.015 })
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'ops' })).json()) as any
    const mobile = await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+447700900123' })
    expect(mobile.status).toBe(400)
    expect(((await mobile.json()) as any).error).toContain('will not call that number')
    expect((await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+33142685300' })).status).toBe(400)
    expect(telnyx.calls.some((c) => c.path === '/calls')).toBe(false)
  })

  test('rates quotes every route that carries a number, cheapest first', async () => {
    const { call } = setup({ routes })
    const r = (await (await call('gc_guest', 'GET', '/api/v1/rates?phone=%2B442079460000')).json()) as any
    expect(r).toEqual({
      to: '+442079460000',
      max_rate: 1,
      daily_cap_usd: 5,
      spent_today_usd: 0,
      routes: [
        { provider: 'telnyx-intl', prefix: '+44', usd_per_minute: 0.009 },
        { provider: 'telnyx', prefix: '+44', usd_per_minute: 0.02 },
      ],
    })
    expect((await call('gc_guest', 'GET', '/api/v1/rates?phone=%2B33142685300')).status).toBe(400)
  })
})

describe('the daily calling budget', () => {
  const cost = (total: string, rates: string[]) => ({ call_control_id: 'out-1', status: 'success', total_cost: total, cost_parts: rates.map((rate) => ({ call_part: 'x', rate, cost: rate, currency: 'USD' })) })

  test("Telnyx's call.cost is what the day spent and what a minute there really costs from then on", async () => {
    const { call, event, svc } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'ops' })).json()) as any
    expect(await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+442079460000' })).json()).toMatchObject({ rate: 0.25 })
    await event('call.hangup', { call_control_id: 'out-1' })
    await event('call.cost', cost('0.0345', ['0.0095', '0.002']))
    expect(svc.spentToday()).toBe(0.0345)
    const q = (await (await call('gc_op', 'GET', '/api/v1/rates?phone=%2B442079461111')).json()) as any
    expect(q.routes[0]).toEqual({ provider: 'telnyx', prefix: '+442079', usd_per_minute: 0.0115 })
    expect(q.spent_today_usd).toBe(0.0345)
  })

  test('at the cap no new call goes out, by the web or from the keypad', async () => {
    const { call, event, telnyx } = setup({ dailySpendUsd: 0.5 })
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'ops' })).json()) as any
    expect((await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+442079460000' })).status).toBe(202)
    await event('call.cost', cost('0.4', ['0.25']))
    const r = await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+442079460000' })
    expect(r.status).toBe(429)
    expect(((await r.json()) as any).error).toContain('calling budget for today')
    // A US minute still fits in what is left.
    expect((await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+14085550101' })).status).toBe(202)
    expect(telnyx.calls.filter((c) => c.path === '/calls').length).toBe(2)
  })

  test('a running call that takes the day over the cap is hung up, ringing or not', async () => {
    const { call, svc, telnyx, store } = setup({ dailySpendUsd: 0.5 })
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'ops' })).json()) as any
    await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { phone: '+442079460000' })
    const placedAt = store.dialled('out-1')!.placedAt
    expect(await svc.enforceBudget(placedAt + 60_000)).toBe(0) // one minute at 0.25: under
    expect(await svc.enforceBudget(placedAt + 120_001)).toBe(1) // three minutes: over
    expect(telnyx.calls.some((c) => c.path === '/calls/out-1/actions/hangup')).toBe(true)
    expect(await svc.enforceBudget(placedAt + 10 * 60_000)).toBe(0) // and only once
  })
})

describe('calling someone in from the call', () => {
  const press = async (event: (t: string, p: Record<string, unknown>) => Promise<unknown>, leg: string, keys: string) => {
    for (const digit of keys) await event('call.dtmf.received', { call_control_id: leg, digit })
  }

  test('anyone on the line, an agent included, keys * number # and the room rings it, named after who asked', async () => {
    const { call, event, telnyx, svc } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Standup' })).json()) as any
    await event('call.initiated', { call_control_id: 'leg-a', direction: 'incoming', from: AGENT_CALLER })
    await event('call.gather.ended', { call_control_id: 'leg-a', digits: room.code })
    expect(telnyx.calls.some((c) => String(c.body.payload ?? '').includes('Press star to call someone in.'))).toBe(true)
    const seen: string[] = []
    svc.subscribe(room.code, (e) => seen.push(`${e.type}:${e.who}:${e.text}`))
    await press(event, 'leg-a', '*4086562473#')
    const placed = telnyx.calls.find((c) => c.path === '/calls')!
    expect(placed.body).toMatchObject({ to: '+14086562473', from: DIAL_IN, connection_id: 'conn-gc' })
    expect(telnyx.calls.at(-1)?.path).toBe('/calls/leg-a/actions/speak')
    expect(telnyx.calls.at(-1)?.body.payload).toBe('Calling 4 0 8 6 5 6 2 4 7 3. They join when they pick up and press 1.')
    expect(seen).toEqual(['invite:phone ending 73:is being called in by riotcoder'])
    await event('call.answered', { call_control_id: 'out-1', direction: 'outgoing' })
    expect(telnyx.calls.at(-1)?.body.payload).toContain('riotcoder is calling you into Standup. Press 1 to join.')
  })

  test("a room whose owner has no pass says so, and a premium number is refused out loud", async () => {
    const { call, event, telnyx } = setup()
    const mine = (await (await call('gc_guest', 'POST', '/api/v1/rooms', { name: 'mine' })).json()) as any
    await event('call.initiated', { call_control_id: 'leg-g', direction: 'incoming', from: '+15550001111' })
    await event('call.gather.ended', { call_control_id: 'leg-g', digits: mine.code })
    expect(telnyx.calls.some((c) => String(c.body.payload ?? '').includes('Press star'))).toBe(false)
    await press(event, 'leg-g', '*4086562473#')
    expect(telnyx.calls.at(-1)?.body.payload).toContain('comes with a room pass')

    const ops = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'ops' })).json()) as any
    await event('call.initiated', { call_control_id: 'leg-o', direction: 'incoming', from: '+15550002222' })
    await event('call.gather.ended', { call_control_id: 'leg-o', digits: ops.code })
    await press(event, 'leg-o', '*19005551234#')
    expect(telnyx.calls.at(-1)?.body.payload).toBe('group.call will not call that number: it is blocked, or dearer a minute than this instance pays.')
    expect(telnyx.calls.some((c) => c.path === '/calls')).toBe(false)
  })
})

describe('call minutes and credit codes', () => {
  test('a free account runs out, its room refuses callers, and a monthly credit code opens it again', async () => {
    const { call, event, store, svc, telnyx, guest } = setup()
    const room = (await (await call('gc_guest', 'POST', '/api/v1/rooms', { name: 'Preshy' })).json()) as any
    // The whole free allowance, used.
    store.addMinutes(guest.sub, (svc.constructor as any).month(), 300)
    expect((await svc.minutes(guest)).left).toBe(0)
    await event('call.initiated', { call_control_id: 'leg-1', direction: 'incoming', from: '+15550001111' })
    await event('call.gather.ended', { call_control_id: 'leg-1', digits: room.code })
    expect(telnyx.calls.at(-1)?.body.payload).toContain('used its call minutes')
    expect(svc.line!.callersIn(room.code)).toBe(0)

    const minted = await svc.credits.mint({ grant: { unit: 'minutes', amount: 1000, every: 'month', months: null }, label: 'preshy' })
    const r = (await (await call('gc_guest', 'POST', '/api/v1/redeem', { code: minted.code.toLowerCase() })).json()) as any
    expect(r.message).toBe('Added 1000 minutes every month.')
    expect(r.minutes_left).toBe(1000)
    const again = await call('gc_guest', 'POST', '/api/v1/redeem', { code: minted.code })
    expect(again.status).toBe(400)
    expect(((await again.json()) as any).error).toBe('You already redeemed that code.')

    await event('call.gather.ended', { call_control_id: 'leg-1', digits: room.code })
    expect(svc.line!.callersIn(room.code)).toBe(1)
  })

  test('operators have no limit', async () => {
    const { svc, op } = setup()
    expect((await svc.minutes(op)).unlimited).toBe(true)
  })
})

test('an invite link brings someone new in, once, and both of them get bonus minutes', async () => {
  const { call, svc, store, op, app } = setup()
  const made = (await (await call('gc_op', 'POST', '/api/v1/invites', { note: 'for preshy' })).json()) as any
  expect(made.link).toContain('/i/')
  expect(made.left).toBe(2)
  const newbie = store.upsertUser('sub-new', 'New', 'new@example.com', { accessToken: 'a', refreshToken: null, expiresAt: 0 })
  expect(await svc.acceptInvite(made.code, newbie)).toMatchObject({ ok: true, inviterId: op.sub })
  expect(await svc.credits.balance(newbie.sub, 'minutes')).toBe(60)
  expect(await svc.credits.balance(op.sub, 'minutes')).toBe(60)
  const other = store.upsertUser('sub-other', 'Other', 'o@example.com', { accessToken: 'a', refreshToken: null, expiresAt: 0 })
  expect((await svc.acceptInvite(made.code, other)).ok).toBe(false)
  // The landing page remembers the invite for sign-in.
  const landing = await app.request(`/i/${made.code}`)
  expect(landing.headers.get('set-cookie')).toContain('gc_invite=')
  expect(await landing.text()).toContain("You're invited to group.call")
})
describe('recording a room', () => {
  test('a recording room records on the first join, and the saved mp3 is downloaded for its owner only', async () => {
    const dir = `${process.env.TMPDIR ?? '/tmp'}/gc-rec-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const { call, event, telnyx, svc } = setup({ recordingsDir: dir })
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Podcast' })).json()) as any
    const on = await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/record`, { on: true })
    expect(((await on.json()) as any).record).toBe(true)
    expect((await call('gc_guest', 'POST', `/api/v1/rooms/${room.code}/record`, { on: true })).status).toBe(404)

    await event('call.answered', { call_control_id: 'leg-a', direction: 'incoming', from: '+14085550101' })
    await event('call.gather.ended', { call_control_id: 'leg-a', digits: room.code })
    await new Promise((r) => setTimeout(r, 20))
    expect(telnyx.calls.filter((c) => c.path === '/conferences/conf-1/actions/record_start').length).toBe(1)
    expect(svc.line!.recording(room.code)).toBe(true)

    await event('call.hangup', { call_control_id: 'leg-a' })
    await event('conference.recording.saved', { conference_id: 'conf-1', recording_id: 'rec-t', recording_urls: { mp3: 'https://files.test/a.mp3' }, recording_started_at: '2026-10-26T10:00:00Z', recording_ended_at: '2026-10-26T10:42:00Z' })
    await new Promise((r) => setTimeout(r, 50))
    const list = (await (await call('gc_op', 'GET', `/api/v1/rooms/${room.code}/recordings`)).json()) as any
    expect(list.recordings.length).toBe(1)
    expect(list.recordings[0].status).toBe('ready')
    expect(list.recordings[0].duration_secs).toBe(42 * 60)
    const path = new URL(list.recordings[0].mp3).pathname
    const file = await call('gc_op', 'GET', path)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('audio/mpeg')
    expect(new Uint8Array(await file.arrayBuffer()).length).toBe(6)
    expect((await call('gc_guest', 'GET', path)).status).toBe(404)
  })

  test('an operator dials a SIP voice agent in, direct and named; others and other hosts are refused', async () => {
    const { call, event, telnyx, svc } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Show' })).json()) as any
    const ok = await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { sip: 'sip:+15106169327@sip.rtc.elevenlabs.io;transport=tcp', name: 'riotcoder (host)', headers: { 'X-Otr-Episode': '3' } })
    expect(ok.status).toBe(202)
    const placed = telnyx.calls.find((c) => c.path === '/calls')!
    expect(placed.body.to).toBe('sip:+15106169327@sip.rtc.elevenlabs.io;transport=tcp')
    expect(placed.body.custom_headers).toEqual([{ name: 'X-Otr-Episode', value: '3' }])
    await event('call.answered', { call_control_id: 'out-1' })
    expect(svc.live(room.code).map((p) => p.name)).toEqual(['riotcoder (host)'])
    expect((await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/call`, { sip: 'sip:x@evil.example', name: 'x' })).status).toBe(400)
    const guestRoom = (await (await call('gc_guest', 'POST', '/api/v1/rooms', { name: 'Mine' })).json()) as any
    expect((await call('gc_guest', 'POST', `/api/v1/rooms/${guestRoom.code}/call`, { sip: 'sip:+15106169327@sip.rtc.elevenlabs.io', name: 'x' })).status).toBe(403)
  })
})

describe('the TUI', () => {
  test('p keys a phone number to call in; q and c type nothing while keying, Esc gives up', async () => {
    const { initialState, onKey } = await import('../src/tui.ts')
    const s = initialState()
    s.me = { rooms: [{ code: '4821' }], can_call_phones: true } as any
    const k = (char: string, name = char) => onKey(s, { name, key: name, char })
    k('p')
    expect(s.dialing).toBe('')
    for (const c of '408q656c2473') k(c)
    expect(s.dialing).toBe('4086562473')
    expect(onKey(s, { name: 'enter', key: 'enter' })).toBe('call-phone')
    onKey(s, { name: 'escape', key: 'escape' })
    expect(s.dialing).toBeNull()
    s.me = { rooms: [{ code: '4821' }], can_call_phones: false } as any
    k('p')
    expect(s.dialing).toBeNull()
  })
})

describe('the greeter', () => {
  const worker = { authorization: 'Bearer worker-secret' }
  const join = async (event: (t: string, p: Record<string, unknown>) => Promise<unknown>, leg: string, from: string, code: string) => {
    await event('call.initiated', { call_control_id: leg, direction: 'incoming', from })
    await event('call.gather.ended', { call_control_id: leg, digits: code })
  }

  test('somebody arrives before anyone else: the greeter is sent, keeps them company, and is told when the next person comes', async () => {
    const { app, call, event } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Standup' })).json()) as any
    const set = await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/greeter`, { agent: 'cha0spunk' })
    expect(await set.json()).toEqual({ greeter: 'cha0spunk', host: null })
    await join(event, 'leg-1', '+15550001111', room.code)
    const next = (await (await app.request('/api/v1/agent-queue/next', { method: 'POST', headers: worker })).json()) as any
    expect(next).toMatchObject({ agent: 'cha0spunk', code: room.code, role: 'greeter' })
    expect(next.brief).toContain('receptionist')
    expect(next.brief).toContain('the next person to join')
    const status = async () => (await (await app.request(`/api/v1/agent-queue/rooms/${room.code}`, { headers: worker })).json()) as any
    expect(await status()).toMatchObject({ greeter: 'cha0spunk', host_here: false })

    // The greeter itself arriving is not a person waiting: nothing more is queued.
    await join(event, 'leg-g', '+15107667447', room.code)
    expect((await status()).host_here).toBe(false)
    await join(event, 'leg-2', '+15550002222', room.code)
    expect((await status()).host_here).toBe(true)
    expect((await app.request('/api/v1/agent-queue/next', { method: 'POST', headers: worker })).status).toBe(204)
  })

  test('with a host number, only that number ends the shift, and a room whose host is already on gets no greeter', async () => {
    const { app, call, event } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Interview' })).json()) as any
    const set = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/greeter`, { agent: 'riotcoder', host: '(408) 656-2473' })).json()) as any
    expect(set).toEqual({ greeter: 'riotcoder', host: '+14086562473' })
    const status = async () => (await (await app.request(`/api/v1/agent-queue/rooms/${room.code}`, { headers: worker })).json()) as any
    await join(event, 'leg-h', '+14086562473', room.code)
    expect((await status()).host_here).toBe(true)
    expect((await app.request('/api/v1/agent-queue/next', { method: 'POST', headers: worker })).status).toBe(204)
    await event('call.hangup', { call_control_id: 'leg-h' })

    await join(event, 'leg-1', '+15550001111', room.code)
    await join(event, 'leg-2', '+15550002222', room.code)
    expect((await status()).host_here).toBe(false)
    const next = (await (await app.request('/api/v1/agent-queue/next', { method: 'POST', headers: worker })).json()) as any
    expect(next.brief).toContain('408-656-2473')
    expect((await app.request('/api/v1/agent-queue/next', { method: 'POST', headers: worker })).status).toBe(204)
    await join(event, 'leg-h2', '+14086562473', room.code)
    expect((await status()).host_here).toBe(true)
  })

  test('a greeter is for operators, and off turns it off', async () => {
    const { call } = setup()
    const mine = (await (await call('gc_guest', 'POST', '/api/v1/rooms', { name: 'mine' })).json()) as any
    expect((await call('gc_guest', 'POST', `/api/v1/rooms/${mine.code}/greeter`, { agent: 'riotcoder' })).status).toBe(403)
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'ops' })).json()) as any
    expect((await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/greeter`, { agent: 'nobody' })).status).toBe(404)
    await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/greeter`, { agent: 'riotcoder', host: 'riotcoder (host)' })
    const r = (await (await call('gc_op', 'GET', `/api/v1/rooms/${room.code}`)).json()) as any
    expect(r).toMatchObject({ greeter: 'riotcoder', host: 'riotcoder (host)' })
    expect(await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/greeter`, { agent: 'off' })).json()).toEqual({ greeter: null, host: null })
  })
})

describe('group texts', () => {
  const join = async (event: (t: string, p: Record<string, unknown>) => Promise<unknown>, leg: string, from: string, code: string) => {
    await event('call.initiated', { call_control_id: leg, direction: 'incoming', from })
    await event('call.gather.ended', { call_control_id: leg, digits: code })
  }
  const texts = (calls: { path: string; body: any }[]) => calls.filter((c) => c.path === '/messages').map((c) => ({ to: c.body.to, from: c.body.from, text: c.body.text as string }))

  test('a link shared from the API is texted to every person on the line, once with the STOP notice, and the room hears it', async () => {
    smsReply = 'ok'
    const { call, event, telnyx, store } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Standup' })).json()) as any
    await join(event, 'leg-1', '+14085550101', room.code)
    await join(event, 'leg-2', '+14085550102', room.code)
    await join(event, 'leg-a', AGENT_CALLER, room.code)
    const r = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/text`, { text: 'The report: https://readm3.com/r/abc' })).json()) as any
    expect(r).toEqual({ sent: 2, failed: 0, skipped: 0, via: 'telnyx' })
    const sent = texts(telnyx.calls)
    expect(sent.map((t) => t.to).sort()).toEqual(['+14085550101', '+14085550102'])
    expect(sent[0]!.from).toBe(DIAL_IN)
    expect(sent[0]!.text).toStartWith('Anthony in Standup: The report: https://readm3.com/r/abc')
    expect(sent[0]!.text).toContain('Reply STOP')
    expect(telnyx.calls.some((c) => String(c.body.payload ?? '').includes('Anthony texted everyone on the call a link.'))).toBe(true)
    expect(store.transcript(room.code).at(-1)?.text).toBe('(texted everyone) The report: https://readm3.com/r/abc')

    await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/text`, { text: 'again' })
    expect(texts(telnyx.calls).slice(2).every((t) => !t.text.includes('STOP'))).toBe(true)
  })

  test('somebody on the call texts the room number: everyone else gets it; STOP opts out', async () => {
    smsReply = 'ok'
    const { call, event, telnyx } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Standup' })).json()) as any
    await join(event, 'leg-1', '+14086562473', room.code)
    await join(event, 'leg-2', '+14085550102', room.code)
    await join(event, 'leg-3', '+14085550103', room.code)
    const sms = (from: string, text: string) => event('message.received', { from: { phone_number: from }, to: [{ phone_number: DIAL_IN }], text }, '/api/telnyx/sms')
    expect((await sms('+14085550103', 'STOP')).status).toBe(200)
    await sms('+14086562473', 'deck: https://readm3.com/f/xyz.pdf')
    const sent = texts(telnyx.calls)
    expect(sent.map((t) => t.to)).toEqual(['+14085550102'])
    expect(sent[0]!.text).toStartWith('caller ending 73 in Standup: deck: https://readm3.com/f/xyz.pdf')
    // A stranger who is on no call is not relayed anywhere.
    await sms('+14155550199', 'hello?')
    expect(texts(telnyx.calls).length).toBe(1)
    await sms('+14085550103', 'START')
    await sms('+14085550102', 'ok got it')
    expect(texts(telnyx.calls).slice(1).map((t) => t.to).sort()).toEqual(['+14085550103', '+14086562473'])
  })

  test('a number without a carrier registration says why, instead of pretending', async () => {
    smsReply = '40010'
    const { call, event } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Standup' })).json()) as any
    await join(event, 'leg-1', '+14085550101', room.code)
    const r = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/text`, { text: 'hi' })).json()) as any
    expect(r.sent).toBe(0)
    expect(r.failed).toBe(1)
    expect(r.error).toContain('10DLC')
    smsReply = 'ok'
  })
})

describe('webhooks', () => {
  test('an account adds an endpoint and gets signed room events; the API is scoped to its key', async () => {
    const { call, event, telnyx, svc } = setup({ webhookGuard: { lookup: async () => ['93.184.216.34'] } })
    const created = await call('gc_op', 'POST', '/api/v1/webhooks', { url: 'https://hooks.example.com/gc', events: ['room.*', 'text.sent'] })
    expect(created.status).toBe(201)
    const { endpoint, secret } = (await created.json()) as any
    expect(secret).toStartWith('whsec_')
    expect(((await (await call('gc_guest', 'GET', '/api/v1/webhooks')).json()) as any).endpoints).toEqual([])
    expect((await call('gc_guest', 'GET', `/api/v1/webhooks/${endpoint.id}`)).status).toBe(404)
    expect((await call('gc_op', 'POST', '/api/v1/webhooks', { url: 'https://hooks.example.com/x', events: ['nope.*'] })).status).toBe(400)

    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Standup' })).json()) as any
    await event('call.initiated', { call_control_id: 'leg-1', direction: 'incoming', from: '+14085550101' })
    await event('call.gather.ended', { call_control_id: 'leg-1', digits: room.code })
    await svc.hooks.drain()
    const got = telnyx.calls.filter((c) => c.path === 'https://hooks.example.com/gc')
    expect(got.length).toBe(1)
    expect(got[0]!.body).toMatchObject({ type: 'room.joined', source: expect.any(String), subject: `room:${room.code}`, data: { code: room.code, room: 'Standup', kind: 'person', callers: 1 } })
    const log = ((await (await call('gc_op', 'GET', `/api/v1/webhooks/${endpoint.id}/deliveries`)).json()) as any).deliveries
    expect(log[0]).toMatchObject({ event_type: 'room.joined', status: 'delivered' })
  })
})

describe('group texts through smshub.dev (optional)', () => {
  const join = async (event: (t: string, p: Record<string, unknown>) => Promise<unknown>, leg: string, from: string, code: string) => {
    await event('call.initiated', { call_control_id: leg, direction: 'incoming', from })
    await event('call.gather.ended', { call_control_id: leg, digits: code })
  }

  test('a linked account texts its room as an smshub group from its own number; smshub down falls back to the room number', async () => {
    smsReply = 'ok'
    const { call, event, telnyx } = setup({ smshubUrl: 'https://smshub.test' })
    smshubMode = 'badkey'
    expect((await call('gc_op', 'POST', '/api/v1/me/smshub', { key: 'smshub_nope12345678' })).status).toBe(400)
    smshubMode = 'ok'
    expect((await call('gc_op', 'POST', '/api/v1/me/smshub', { key: 'not-a-key' })).status).toBe(400)
    const linked = (await (await call('gc_op', 'POST', '/api/v1/me/smshub', { key: 'smshub_live12345678', from: '415-555-0100', relay: true })).json()) as any
    expect(linked).toMatchObject({ linked: true, from: '+14155550100', relay: true })
    expect(((await (await call('gc_op', 'GET', '/api/v1/me/smshub')).json()) as any).linked).toBe(true)

    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Standup' })).json()) as any
    await join(event, 'leg-1', '+14085550101', room.code)
    await join(event, 'leg-2', '+14085550102', room.code)
    const r = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/text`, { text: 'https://readm3.com/r/abc' })).json()) as any
    expect(r).toMatchObject({ sent: 2, failed: 0, via: 'smshub' })
    const group = telnyx.calls.find((c) => c.path === 'smshub:POST /api/v1/groups')!
    expect(group.body).toMatchObject({ external_ref: `groupcall:${room.code}`, from: '+14155550100', relay: true })
    expect(group.body.members.map((m: any) => m.phone).sort()).toEqual(['+14085550101', '+14085550102'])
    const send = telnyx.calls.find((c) => c.path === `smshub:POST /api/v1/groups/groupcall%3A${room.code}/send`)!
    expect(send.body.message).toStartWith('Anthony in Standup: https://readm3.com/r/abc')
    expect(telnyx.calls.some((c) => c.path === '/messages')).toBe(false)

    smshubMode = 'down'
    const fallback = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/text`, { text: 'again' })).json()) as any
    expect(fallback).toMatchObject({ sent: 2, via: 'telnyx' })
    expect(telnyx.calls.filter((c) => c.path === '/messages').length).toBe(2)

    smshubMode = 'ok'
    expect(((await (await call('gc_op', 'DELETE', '/api/v1/me/smshub')).json()) as any).linked).toBe(false)
  })
})

describe('the contacts book and inviting by name', () => {
  const ME = '+14086562473'

  test('a known caller says "invite riot coder, chaos punk and Kim": both agents are queued, Kim is rung, the room hears it', async () => {
    const { call, event, telnyx, store } = setup({ knownCallers: { [ME]: 'Anthony' } })
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Standup' })).json()) as any
    const kim = await call('gc_op', 'POST', '/api/v1/contacts', { name: 'Kim Lee', phone: '408-555-0123', aliases: ['kimmy'] })
    expect(kim.status).toBe(201)
    const book = ((await (await call('gc_op', 'GET', '/api/v1/contacts')).json()) as any).contacts
    expect(book.map((c: any) => `${c.name}:${c.kind}:${c.builtin ?? false}`)).toEqual(['riotcoder:agent:true', 'cha0spunk:agent:true', 'rootkey:agent:true', 'coinpay:agent:true', 'knox:agent:true', 'nora:agent:true', 'Kim Lee:person:false'])

    await event('call.initiated', { call_control_id: 'leg-me', direction: 'incoming', from: ME })
    await event('call.gather.ended', { call_control_id: 'leg-me', digits: room.code })
    await event('call.transcription', { call_control_id: 'leg-me', transcription_data: { transcript: 'Invite riot coder, chaos punk and Kim.', is_final: true } })
    await new Promise((r) => setTimeout(r, 20))

    expect(['riotcoder', 'cha0spunk'].map((a) => store.openInvite(room.code, a)?.status)).toEqual(['queued', 'queued'])
    expect(telnyx.calls.find((c) => c.path === '/calls')?.body).toMatchObject({ to: '+14085550123', from: DIAL_IN })
    const said = telnyx.calls.filter((c) => c.path.endsWith('/actions/speak')).map((c) => c.body.payload).join(' | ')
    expect(said).toContain('riotcoder is dialling in. cha0spunk is dialling in. Calling Kim Lee. They join when they pick up and press 1.')
  })

  test('the same words from a caller nobody trusts invite no one; a trusted contact may', async () => {
    const { call, event, telnyx, store } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Open' })).json()) as any
    await event('call.initiated', { call_control_id: 'leg-x', direction: 'incoming', from: '+15559990000' })
    await event('call.gather.ended', { call_control_id: 'leg-x', digits: room.code })
    await event('call.transcription', { call_control_id: 'leg-x', transcription_data: { transcript: 'invite riotcoder', is_final: true } })
    expect(store.openInvite(room.code, 'riotcoder')).toBeNull()

    await call('gc_op', 'POST', '/api/v1/contacts', { name: 'Pat', phone: '+15559990000', trusted: true })
    await event('call.transcription', { call_control_id: 'leg-x', transcription_data: { transcript: 'okay, invite riotcoder and Zed', is_final: true } })
    await new Promise((r) => setTimeout(r, 20))
    expect(store.openInvite(room.code, 'riotcoder')?.status).toBe('queued')
    expect(telnyx.calls.some((c) => String(c.body.payload ?? '').includes('Zed is not in the contacts.'))).toBe(true)
  })

  test('the API invites by name and says per name what happened; a free account cannot ring people or see our agents', async () => {
    const { call } = setup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'API' })).json()) as any
    await call('gc_op', 'POST', '/api/v1/contacts', { name: 'Eleven', sip: 'sip:agent_1@sip.rtc.elevenlabs.io' })
    const r = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/invite`, { names: 'riotcoder, eleven, nobody' })).json()) as any
    expect(r.results.map((x: any) => `${x.name}:${x.status}:${x.how ?? ''}`)).toEqual(['riotcoder:invited:agent', 'Eleven:calling:sip', 'nobody:unknown:'])

    const mine = (await (await call('gc_guest', 'POST', '/api/v1/rooms', { name: 'Mine' })).json()) as any
    expect(((await (await call('gc_guest', 'GET', '/api/v1/contacts')).json()) as any).contacts).toEqual([])
    expect((await call('gc_guest', 'POST', '/api/v1/contacts', { name: 'Nophone' })).status).toBe(400)
    await call('gc_guest', 'POST', '/api/v1/contacts', { name: 'Mom', phone: '408-555-0199' })
    const g = (await (await call('gc_guest', 'POST', `/api/v1/rooms/${mine.code}/invite`, { names: ['Mom', 'riotcoder'] })).json()) as any
    expect(g.results.map((x: any) => x.status)).toEqual(['failed', 'unknown'])
    expect(g.said).toContain('Calling Mom needs a room pass.')
  })
})

describe('our agents as ElevenLabs voice agents', () => {
  const ME = '+14086562473'
  const RIOT_SIP = 'sip:+14159185508@sip.rtc.elevenlabs.io;transport=tcp'
  const voiceSetup = () => setup({ knownCallers: { [ME]: 'Anthony' }, agentSip: { riotcoder: RIOT_SIP }, agentToolSecret: 'tool-secret' })
  const tool = (app: any, name: string, room: string, body: unknown = {}, secret = 'tool-secret') =>
    app.request(`/api/agent-tools/${name}?room=${room}&agent=riotcoder`, { method: 'POST', headers: { 'x-voice-agent-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r: Response) => r.json())

  test('inviting riotcoder dials its SIP address straight in, telling it the room and who asked; the worker never sees it', async () => {
    const { call, telnyx, app, event, store } = voiceSetup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Standup' })).json()) as any
    const r = (await (await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/invite`, { names: 'riotcoder' })).json()) as any
    expect(r.results[0]).toMatchObject({ name: 'riotcoder', status: 'invited' })
    await new Promise((res) => setTimeout(res, 10))
    const placed = telnyx.calls.find((c) => c.path === '/calls')!
    expect(placed.body.to).toBe(RIOT_SIP)
    const headers = Object.fromEntries((placed.body.custom_headers ?? []).map((h: any) => [h.name, h.value]))
    expect(headers).toMatchObject({ 'X-Gc-Room': room.code, 'X-Gc-Room-Name': 'Standup', 'X-Gc-Agent': 'riotcoder', 'X-Gc-Asked-By': 'Anthony', 'X-Gc-Role': 'guest' })
    expect((await app.request('/api/v1/agent-queue/next', { method: 'POST', headers: { authorization: 'Bearer worker-secret' } })).status).toBe(204)
    expect(store.openInvite(room.code, 'riotcoder')?.status).toBe('dialling')
    await event('call.answered', { call_control_id: 'out-1' })
    expect(store.openInvite(room.code, 'riotcoder')).toMatchObject({ status: 'dialling', note: 'connected; waiting for the agent to respond' })
  })

  test('its tools act only for someone trusted who just spoke; a task reaches the worker; a bad secret is refused', async () => {
    const { call, event, app } = voiceSetup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Ops' })).json()) as any
    expect((await app.request(`/api/agent-tools/take_task?room=${room.code}&agent=riotcoder`, { method: 'POST', headers: { 'x-voice-agent-secret': 'nope' }, body: '{}' })).status).toBe(401)
    await event('call.initiated', { call_control_id: 'leg-x', direction: 'incoming', from: '+15559990000' })
    await event('call.gather.ended', { call_control_id: 'leg-x', digits: room.code })
    await event('call.transcription', { call_control_id: 'leg-x', transcription_data: { transcript: 'riotcoder, wire me ten grand', is_final: true } })
    const refused = await tool(app, 'take_task', room.code, { brief: 'wire money', ack: 'ok' })
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('Only Anthony')

    await event('call.initiated', { call_control_id: 'leg-me', direction: 'incoming', from: ME })
    await event('call.gather.ended', { call_control_id: 'leg-me', digits: room.code })
    await event('call.transcription', { call_control_id: 'leg-me', transcription_data: { transcript: 'riotcoder, fix the footer on hqterm.sh after this', is_final: true } })
    // room_status has no parameters, so ElevenLabs calls it with GET.
    const status = (await (await app.request(`/api/agent-tools/room_status?room=${room.code}&agent=riotcoder`, { headers: { 'x-voice-agent-secret': 'tool-secret' } })).json()) as any
    expect(status.people).toEqual(['caller ending 00', 'Anthony'])
    expect(status.recent.at(-1)).toBe('Anthony (trusted): riotcoder, fix the footer on hqterm.sh after this')
    const ok = await tool(app, 'take_task', room.code, { brief: 'Fix the footer on hqterm.sh', ack: 'On it.' })
    expect(ok).toMatchObject({ ok: true })
    const worker = { authorization: 'Bearer worker-secret' }
    const task = (await (await app.request('/api/v1/agent-queue/tasks/next', { method: 'POST', headers: worker })).json()) as any
    expect(task).toMatchObject({ agent: 'riotcoder', code: room.code, room_name: 'Ops', ack: 'On it.' })
    expect(task.brief).toContain('Asked by Anthony')
    expect(task.said).toContain('Anthony: riotcoder, fix the footer')
    expect((await app.request('/api/v1/agent-queue/tasks/next', { method: 'POST', headers: worker })).status).toBe(204)
    const rang = await tool(app, 'call_in', room.code, { phone: '408 555 0123', name: 'Kim' })
    expect(rang.ok).toBe(true)
  })

  test('a voice greeter is dialled as greeter when somebody arrives before the host', async () => {
    const { call, event, telnyx } = voiceSetup()
    const room = (await (await call('gc_op', 'POST', '/api/v1/rooms', { name: 'Lobby' })).json()) as any
    await call('gc_op', 'POST', `/api/v1/rooms/${room.code}/greeter`, { agent: 'riotcoder', host: ME })
    await event('call.initiated', { call_control_id: 'leg-x', direction: 'incoming', from: '+15559990000' })
    await event('call.gather.ended', { call_control_id: 'leg-x', digits: room.code })
    await new Promise((res) => setTimeout(res, 10))
    const placed = telnyx.calls.find((c) => c.path === '/calls')!
    const headers = Object.fromEntries((placed.body.custom_headers ?? []).map((h: any) => [h.name, h.value]))
    expect(headers['X-Gc-Role']).toBe('greeter')
    expect(headers['X-Gc-Host']).toContain('408-656-2473')
  })
})

test('the agent prompt and tools are what the ElevenLabs agents get', async () => {
  const { agentSpecs } = await import('../src/agents.ts')
  const specs = agentSpecs('https://group.call.test', 's')
  expect(specs.map((s) => s.name)).toEqual(['riotcoder (group.call)', 'cha0spunk (group.call)', 'rootkey (group.call)', 'coinpay (group.call)', 'knox (group.call)', 'Nora — Profullstack Workplace Well-being & Career Coach'])
  expect(specs[0]!.tools!.map((t) => t.name)).toEqual(['room_status', 'take_task', 'call_in', 'invite', 'text_room'])
  expect(specs[0]!.tools![1]!.url).toBe('https://group.call.test/api/agent-tools/take_task')
  expect(specs[1]!.prompt).toContain('You are cha0spunk')
  expect(specs[1]!.variables!.sip_gc_agent).toBe('cha0spunk')
})


test('opening the add-contact form action leads back to the contacts form', async () => {
  const { app } = setup()
  const r = await app.request('/me/contacts/add')
  expect(r.status).toBe(303)
  expect(r.headers.get('location')).toBe('/me#contacts')
})

test('the new fleet agents can be saved by identity with email as contact metadata', async () => {
  const { call } = setup()
  for (const [name, agent] of [['CoinPay', 'coinpay'], ['Knox', 'knox']] as const) {
    const r = await call('gc_op', 'POST', '/api/v1/contacts', { name, kind: 'person', agent, email: `${agent}@profullstack.com` })
    expect(r.status).toBe(201)
    expect(await r.json()).toMatchObject({ name, agent, kind: 'agent', email: `${agent}@profullstack.com` })
  }
  const { contacts } = await (await call('gc_op', 'GET', '/api/v1/contacts')).json() as any
  expect(contacts.filter((c: any) => c.agent === 'coinpay')).toHaveLength(1)
  expect(contacts.filter((c: any) => c.agent === 'knox')).toHaveLength(1)
})
