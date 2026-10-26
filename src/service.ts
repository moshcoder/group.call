/**
 * group.call's rules, between the web/API and the phone line.
 *
 * The phone half is @profullstack/group-call (nixamp's party line, shared): it
 * answers the number, asks for a four-digit code and puts the caller in a Telnyx
 * conference. This file decides what a code means (a room somebody made here,
 * or nothing), names what it can, logs comings and goings, tells open pages
 * about them, and queues our agents when somebody asks one to dial in.
 */
import { CoinPay } from '@profullstack/coinpay-onboard'
import { GroupCall, newRoomCode, normalNumber, type Participant, type TelnyxEvent } from '@profullstack/group-call'
import type { AgentInvite, Line, Pass, Room, RoomEvent, Store, User } from './db.js'

export class UserError extends Error {
  constructor(
    message: string,
    readonly field?: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

export type Config = {
  /** Seals CoinPay tokens and signs CSRF; 32 random bytes, hex. */
  key: string
  clientId: string
  clientSecret?: string
  coinpayBase: string
  /** CoinPay business API key + webhook secret, for room passes. */
  coinpayApiKey?: string
  coinpayWebhookSecret?: string
  telnyxApiKey?: string
  telnyxPublicKey?: string
  /** The number people dial, E.164. */
  dialIn: string
  /** Main prompt voice; an ElevenLabs voice needs telnyxVoiceKeyRef. */
  voice?: string
  telnyxVoiceKeyRef?: string
  /** Who may ask our agents to dial in: CoinPay emails or subs. */
  agentOperators?: string[]
  /** The worker that dials agents authenticates with this. */
  agentWorkerKey?: string
  /**
   * The number each of our agents calls from. One number per agent, so a room
   * can never put one agent's name on another's line.
   */
  agentCallerIds?: Record<string, string>
  /** Transcribe every leg (Telnyx, per minute per leg). On by default. */
  transcribe?: boolean
  origin?: string
  fetch?: typeof fetch
}

/** The agents that can be asked into a room, with the voice each speaks in. */
export const AGENTS: Record<string, { about: string; voice: string }> = {
  riotcoder: { about: 'Builds and ships things for Anthony. Voice: Chris.', voice: 'ElevenLabs Chris' },
  cha0spunk: { about: 'Works the inbound queue: email, support, follow-ups. Voice: Jessica.', voice: 'ElevenLabs Jessica' },
}

export const FREE_ROOMS = 3
export const PASS_ROOMS = 50
export const PASS_USD = 5
export const PASS_DAYS = 30
export const CODE_LENGTH = 4
export const MAX_NAME = 60

/** A room's code shown for reading and dialling: "4821". */
export const formatNumber = (e164: string) => {
  const d = e164.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : e164
}

/** One tap from a phone: dial, wait for the prompt, key the code. */
export const telLink = (dialIn: string, code: string) => `tel:${dialIn},,,${code}%23`

export type LiveEvent = { type: 'join' | 'leave' | 'say' | 'invite' | 'line'; code: string; who: string; text?: string; callers: number; at: number; line?: Line }

/** A participant as a page or the API may see them: a name, or a masked number. */
export function shownParticipant(p: Participant, agentNumbers: string[] = []): { name: string; kind: 'agent' | 'person'; since: number } {
  const agent = Boolean(p.name) || agentNumbers.some((n) => normalNumber(n) === normalNumber(p.from))
  const masked = p.from ? `caller ending ${p.from.replace(/\D/g, '').slice(-2)}` : 'a caller'
  return { name: p.name || (agent ? 'an agent' : masked), kind: agent ? 'agent' : 'person', since: p.joinedAt }
}

export class GroupCallService {
  readonly line: GroupCall | null
  private readonly listeners = new Map<string, Set<(e: LiveEvent) => void>>()
  private readonly store: Store
  readonly config: Config
  private readonly agentNumbers: string[]

  constructor(store: Store, config: Config) {
    this.store = store
    this.config = config
    this.agentNumbers = Object.values(config.agentCallerIds ?? {})
    this.line =
      config.telnyxApiKey && config.telnyxPublicKey
        ? new GroupCall({
            apiKey: config.telnyxApiKey,
            publicKey: config.telnyxPublicKey,
            codeLength: CODE_LENGTH,
            conferencePrefix: 'groupcall',
            greeting: 'Welcome to group call. Enter your four digit room code.',
            ...(config.voice ? { voice: config.voice } : {}),
            ...(config.telnyxVoiceKeyRef ? { voiceSettings: { api_key_ref: config.telnyxVoiceKeyRef } } : {}),
            maxParticipants: 20,
            ...(config.fetch ? { fetch: config.fetch } : {}),
            onCode: (code) => {
              const room = store.room(code)
              if (!room) return { reject: 'That is not a room.' }
              store.touchRoom(code)
              return { welcome: `Welcome to ${room.name}. ` }
            },
            onJoin: (code, who, info) => {
              if (info.conferenceId) store.saveLeg(code, info.conferenceId, info.startedAt, who)
              this.record(code, 'join', who, info.callers)
            },
            onLeave: (code, who, info) => {
              store.dropLeg(code, who.leg, info.callers === 0)
              this.record(code, 'leave', who, info.callers)
            },
            ...(config.transcribe === false ? {} : { transcribe: { engine: 'Deepgram', language: 'en' } }),
            onTranscript: (code, who, text) => {
              const shown = shownParticipant(who, this.agentNumbers)
              this.addLine(code, shown.name, shown.kind, text)
            },
            onEvent: (line) => console.log(line),
          })
        : null
  }

  private record(code: string, kind: 'join' | 'leave', who: Participant, callers: number): void {
    const shown = shownParticipant(who, this.agentNumbers)
    this.store.addEvent({ code, kind, who: shown.name, text: '' })
    this.emit({ type: kind, code, who: shown.name, callers, at: Date.now() })
  }

  /** A line into the transcript, and out to every open room page. */
  private addLine(code: string, who: string, kind: Line['kind'], text: string): Line {
    const line = this.store.addLine({ code, who, kind, text })
    this.emit({ type: 'line', code, who, text, callers: this.line?.callersIn(code) ?? 0, at: line.at, line })
    return line
  }

  transcript(user: User, code: string, opts: { after?: number; limit?: number } = {}): Line[] {
    return this.store.transcript(this.ownRoom(user, code).code, opts)
  }

  // ---- live updates --------------------------------------------------------

  /** Follow a room's comings and goings; returns the unsubscribe. */
  subscribe(code: string, fn: (e: LiveEvent) => void): () => void {
    const set = this.listeners.get(code) ?? new Set()
    set.add(fn)
    this.listeners.set(code, set)
    return () => {
      set.delete(fn)
      if (set.size === 0) this.listeners.delete(code)
    }
  }

  private emit(e: LiveEvent): void {
    for (const fn of this.listeners.get(e.code) ?? []) {
      try {
        fn(e)
      } catch {}
    }
  }

  // ---- the phone line ------------------------------------------------------

  /** A Telnyx webhook, verified against the raw body. False when it is not Telnyx's. */
  async telnyx(rawBody: string, signature: string | undefined, timestamp: string | undefined): Promise<boolean> {
    if (!this.line || !this.line.verify(rawBody, signature, timestamp)) return false
    let event: TelnyxEvent
    try {
      event = (JSON.parse(rawBody) as { data?: TelnyxEvent }).data ?? {}
    } catch {
      return false
    }
    // Answered asynchronously: Telnyx wants a quick 200, and the commands go back on their own.
    void this.line.handle(event).catch((e) => console.error('group call:', e))
    return true
  }

  /**
   * At boot: put back every room that was live when the last process stopped, so
   * a deploy neither splits a room nor forgets who is in it.
   */
  async restore(): Promise<{ rooms: number; legs: number }> {
    if (!this.line) return { rooms: 0, legs: 0 }
    const saved = this.store.liveSnapshot()
    if (saved.length === 0) return { rooms: 0, legs: 0 }
    const result = await this.line.restore(saved)
    const keep = new Map<string, Set<string>>()
    for (const r of saved) if (this.line.callersIn(r.code) > 0) keep.set(r.code, new Set(this.line.participants(r.code).map((p) => p.leg)))
    this.store.pruneLive(keep)
    // Legs Telnyx had that the save missed are worth keeping too.
    for (const [code, legs] of keep) {
      const conf = saved.find((r) => r.code === code)!
      for (const p of this.line.participants(code)) if (legs.has(p.leg)) this.store.saveLeg(code, conf.conferenceId, conf.startedAt, p)
    }
    return result
  }

  /** For an agent on the line: how many people (not agents) are still in the room. */
  roomStatus(code: string): { people: number; agents: number; live: ReturnType<GroupCallService['live']> } {
    const live = this.live(code)
    return { people: live.filter((p) => p.kind === 'person').length, agents: live.filter((p) => p.kind === 'agent').length, live }
  }

  live(code: string) {
    const people = this.line?.participants(code) ?? []
    return people.map((p) => shownParticipant(p, this.agentNumbers))
  }

  // ---- rooms ---------------------------------------------------------------

  roomLimit(user: User): number {
    return this.store.passUntil(user.sub) ? PASS_ROOMS : FREE_ROOMS
  }

  createRoom(user: User, input: { name?: string; code?: string }): Room {
    const name = (input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || `${user.name || 'My'}'s room`.slice(0, MAX_NAME)
    const limit = this.roomLimit(user)
    if (this.store.rooms(user.sub).length >= limit)
      throw new UserError(limit === FREE_ROOMS ? `Free accounts have ${FREE_ROOMS} rooms. A room pass ($${PASS_USD} for ${PASS_DAYS} days) gives you ${PASS_ROOMS} and lets you pick codes.` : `You have ${PASS_ROOMS} rooms already.`, 'name', 402)
    let code: string
    if (input.code) {
      if (!this.store.passUntil(user.sub)) throw new UserError(`Picking your own code comes with a room pass ($${PASS_USD} for ${PASS_DAYS} days).`, 'code', 402)
      code = String(input.code).replace(/\D/g, '')
      if (code.length !== CODE_LENGTH) throw new UserError(`A code is ${CODE_LENGTH} digits.`, 'code')
      if (this.store.codeTaken(code)) throw new UserError('That code is taken.', 'code', 409)
    } else {
      code = newRoomCode(CODE_LENGTH, (c) => this.store.codeTaken(c))
    }
    return this.store.addRoom({ code, sub: user.sub, name })
  }

  ownRoom(user: User, code: string): Room {
    const room = this.store.room(String(code).replace(/\D/g, ''))
    if (!room || room.sub !== user.sub) throw new UserError('No such room.', undefined, 404)
    return room
  }

  renameRoom(user: User, code: string, name: string): Room {
    const room = this.ownRoom(user, code)
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
    if (!clean) throw new UserError('Give it a name.', 'name')
    this.store.renameRoom(room.code, clean)
    return this.store.room(room.code)!
  }

  async deleteRoom(user: User, code: string): Promise<void> {
    const room = this.ownRoom(user, code)
    // Whoever is on the line is let go first, so a deleted code holds nobody.
    for (const p of this.line?.participants(room.code) ?? []) await this.line?.kick(room.code, p.leg)
    this.store.removeRoom(room.code)
  }

  /** Say something into a room, read aloud to everyone on the phone. */
  async say(user: User, code: string, text: string, as?: string): Promise<{ said: boolean; callers: number }> {
    const room = this.ownRoom(user, code)
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 500)
    if (!clean) throw new UserError('Say something.', 'text')
    const who = (as ?? user.name ?? '').trim().slice(0, 40)
    const said = (await this.line?.say(room.code, who ? `${who} says: ${clean}` : clean)) ?? false
    if (said) {
      // Read into the conference, not a caller's leg, so no transcription hears it: write it down here.
      this.addLine(room.code, who || 'someone', 'typed', clean)
      this.store.addEvent({ code: room.code, kind: 'say', who: who || 'someone', text: clean })
      this.emit({ type: 'say', code: room.code, who: who || 'someone', text: clean, callers: this.line?.callersIn(room.code) ?? 0, at: Date.now() })
    }
    return { said, callers: this.line?.callersIn(room.code) ?? 0 }
  }

  /**
   * Tell the room who is about to dial in from `from`, so it can name them.
   * For your own agents on your own phone line: they key the code like anyone.
   */
  expect(user: User, code: string, name: string, from: string): void {
    const room = this.ownRoom(user, code)
    const clean = name.trim().slice(0, 40)
    if (!clean) throw new UserError('Give the agent a name.', 'name')
    if (!normalNumber(from)) throw new UserError('Which number will it call from?', 'from')
    this.line?.expect(room.code, from, clean)
  }

  // ---- our agents ----------------------------------------------------------

  mayInviteAgents(user: User | null): boolean {
    if (!user) return false
    const ops = this.config.agentOperators ?? []
    return ops.includes(user.sub) || (user.email !== '' && ops.includes(user.email.toLowerCase()))
  }

  inviteAgent(user: User, code: string, agent: string): AgentInvite {
    const room = this.ownRoom(user, code)
    if (!this.mayInviteAgents(user)) throw new UserError('Inviting our agents is for the operators of this instance for now. Your own agents can dial in themselves: see /help#agents.', undefined, 403)
    if (!AGENTS[agent]) throw new UserError(`No agent called ${agent}. Try ${Object.keys(AGENTS).join(' or ')}.`, 'agent', 404)
    const open = this.store.openInvite(room.code, agent)
    if (open) return open
    const invite = this.store.addInvite({ code: room.code, agent, sub: user.sub })
    this.store.addEvent({ code: room.code, kind: 'invite', who: agent, text: 'asked to dial in' })
    this.emit({ type: 'invite', code: room.code, who: agent, text: 'asked to dial in', callers: this.line?.callersIn(room.code) ?? 0, at: Date.now() })
    return invite
  }

  /** For the agent worker: the next agent to dial, with what it needs to get in. */
  nextInvite(): (AgentInvite & { dial_in: string; from: string; room_name: string; brief: string }) | null {
    const invite = this.store.claimInvite()
    if (!invite) return null
    const room = this.store.room(invite.code)
    if (!room) {
      this.store.finishInvite(invite.id, 'failed', 'the room was deleted')
      return this.nextInvite()
    }
    // Named before it dials, so the room says "riotcoder" when it arrives.
    const from = this.config.agentCallerIds?.[invite.agent]
    if (from) this.line?.expect(room.code, from, invite.agent, 3 * 60_000)
    const people = this.live(room.code).map((p) => p.name)
    return {
      ...invite,
      dial_in: this.config.dialIn,
      from: from ?? '',
      room_name: room.name,
      brief: `You were asked to join the group call "${room.name}". ${people.length ? `On the line now: ${people.join(', ')}.` : 'Nobody is on the line yet.'}`,
    }
  }

  finishInvite(id: string, ok: boolean, note = ''): AgentInvite | null {
    const invite = this.store.invite(id)
    if (!invite) return null
    this.store.finishInvite(id, ok ? 'done' : 'failed', note)
    return this.store.invite(id)
  }

  // ---- room passes (CoinPay) -----------------------------------------------

  private coinpay(): CoinPay {
    if (!this.config.coinpayApiKey) throw new UserError('Payments are not set up on this instance yet.', undefined, 503)
    return new CoinPay({ base: this.config.coinpayBase, token: this.config.coinpayApiKey, ...(this.config.fetch ? { fetch: this.config.fetch } : {}) })
  }

  async buyPass(user: User): Promise<Pass> {
    if (!user.email) throw new UserError('Your CoinPay account has no email; add one at coinpayportal.com first.')
    if (this.store.pendingPasses(user.sub).length >= 3) throw new UserError('You have three unpaid checkouts open. Pay one or wait for them to expire.')
    const origin = (this.config.origin ?? 'https://group.call.pit.world').replace(/\/+$/, '')
    const session = await this.coinpay()
      .createCheckoutSession({
        amount: PASS_USD,
        description: `group.call room pass, ${PASS_DAYS} days`,
        customerEmail: user.email,
        accountId: user.sub,
        property: new URL(origin).hostname,
        metadata: { kind: 'room_pass', sub: user.sub, days: PASS_DAYS },
        successUrl: `${origin}/pass/{CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/rooms`,
      })
      .catch((e: unknown) => {
        throw new UserError(e instanceof Error ? e.message : 'CoinPay did not answer. Try again in a minute.', undefined, 502)
      })
    // Only ever send people to CoinPay's own page.
    if (!session.url || new URL(session.url).origin !== new URL(this.config.coinpayBase).origin) throw new UserError('CoinPay answered oddly. Try again in a minute.', undefined, 502)
    return this.store.addPass({ id: session.id, sub: user.sub, amountCents: PASS_USD * 100, checkoutUrl: session.url, days: PASS_DAYS })
  }

  /** A pass's state, asking CoinPay while it is open. */
  async followPass(id: string): Promise<Pass | null> {
    const pass = this.store.pass(id)
    if (!pass || pass.status !== 'pending' || !this.config.coinpayApiKey) return pass
    try {
      const session = await this.coinpay().checkoutSession(id)
      if (['paid', 'complete', 'completed', 'confirmed'].includes(session.status)) this.store.markPassPaid(id)
      else if (['expired', 'cancelled', 'canceled', 'failed'].includes(session.status)) this.store.setPassStatus(id, session.status)
    } catch {}
    return this.store.pass(id)
  }

  /** A paid CoinPay webhook: the session id names the pass. */
  passPaid(checkoutSessionId: string): boolean {
    return this.store.pass(checkoutSessionId) ? this.store.markPassPaid(checkoutSessionId) : false
  }

  events(code: string): RoomEvent[] {
    return this.store.events(code)
  }
}

export function newApiKey(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return `gc_${Buffer.from(bytes).toString('base64url')}`
}
