import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync, sign as signMessage } from 'node:crypto'
import { signWebhook } from '@profullstack/coinpay-onboard'
import { createApp } from '../src/server.ts'
import { Sealer, Store } from '../src/db.ts'
import { FREE_ROOMS, telLink } from '../src/service.ts'

/** An ed25519 pair standing in for the Telnyx account's, so a test can sign webhooks. */
function telnyxKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') }
}

/** A fetch that records what Telnyx was asked; a conference creation answers with an id. */
function telnyxRecorder() {
  const calls: { path: string; body: any }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://api.telnyx.com/v2', '')
    calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) })
    const json = path === '/conferences' ? { data: { id: 'conf-1' } } : {}
    return new Response(JSON.stringify(json), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

const DIAL_IN = '+15106169327'
const AGENT_CALLER = '+19492847328'

function setup() {
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
      agentOperators: ['op@example.com'],
      agentWorkerKey: 'worker-secret',
      agentCallerIds: { riotcoder: AGENT_CALLER, cha0spunk: '+15107667447' },
      fetch: telnyx.fetch,
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
  const event = async (event_type: string, payload: Record<string, unknown>) => {
    const raw = JSON.stringify({ data: { event_type, payload } })
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = signMessage(null, Buffer.from(`${ts}|${raw}`), keys.privateKey).toString('base64')
    const r = await app.request('/api/telnyx/voice', { method: 'POST', body: raw, headers: { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts } })
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
  test('the home page says how to call, carries the PWA manifest, and is safe to frame-bust', async () => {
    const { app } = setup()
    const r = await app.request('/')
    const html = await r.text()
    expect(r.status).toBe(200)
    expect(html).toContain('510-616-9327')
    expect(html).toContain('rel="manifest"')
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect((await app.request('/manifest.webmanifest')).headers.get('content-type')).toContain('manifest+json')
    expect((await app.request('/sw.js')).headers.get('cache-control')).toBe('no-cache')
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
    const config = { key: 'k'.repeat(32), clientId: 'cp', coinpayBase: 'https://coinpayportal.com', telnyxApiKey: 'KEY', telnyxPublicKey: keys.publicKey, dialIn: DIAL_IN, agentCallerIds: { riotcoder: AGENT_CALLER, cha0spunk: '+15107667447' }, agentOperators: ['op@example.com'], agentWorkerKey: 'w', fetch }
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
