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
import { Credits, sqliteStore } from '@profullstack/redeem-credits'
import { Affiliates, sqliteStore as affiliateStore } from '@profullstack/affiliates'
import { mkdirSync, unlinkSync } from 'node:fs'
import { GroupCall, newRoomCode, normalNumber, type Participant, type Recording as SavedRecording, type TelnyxEvent } from '@profullstack/group-call'
import { defaultDeck, learnedPrefix, Router, type Route, type RouteChoice } from './routing.js'
import type { AgentInvite, Line, Pass, Recording, Room, RoomEvent, Store, User } from './db.js'

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
  /** The number people dial, E.164. Also the caller id when the room rings someone. */
  dialIn: string
  /** Telnyx call-control app id ("connection_id") that rings phones into rooms; without it, no dial-out. */
  telnyxConnectionId?: string
  /**
   * Ways out to the phone network, each with its rate deck: phones are rung on the
   * cheapest one that will carry the number (least-cost routing, see routing.ts).
   * Unset, it is telnyxConnectionId with a US/Canada deck.
   */
  routes?: Route[]
  /** Dearest a minute a phone call-in may cost, USD. */
  maxRate?: number
  /**
   * What every call this instance places may cost in a day, USD (UTC days, as Telnyx counts).
   * At the cap no new call goes out and the ones running are hung up.
   */
  dailySpendUsd?: number
  /** Main prompt voice; an ElevenLabs voice needs telnyxVoiceKeyRef. */
  voice?: string
  telnyxVoiceKeyRef?: string
  /**
   * Who may ask our agents to dial in: CoinPay account ids (`sub`). Never emails:
   * CoinPay does not verify the email it hands back, so anyone could register a
   * CoinPay account under an operator's address.
   */
  agentOperators?: string[]
  /** The worker that dials agents authenticates with this. */
  agentWorkerKey?: string
  /**
   * The number each of our agents calls from. One number per agent, so a room
   * can never put one agent's name on another's line.
   */
  agentCallerIds?: Record<string, string>
  /**
   * Numbers this instance knows by name ("+14086562473" -> "Anthony"). Their lines
   * carry that name, and agents may take work only from them.
   */
  knownCallers?: Record<string, string>
  /** Free call minutes a month per room owner (operators are unlimited). */
  freeMinutes?: number
  /** Transcribe every leg (Telnyx, per minute per leg). On by default. */
  transcribe?: boolean
  /** Where finished recordings are kept as mp3; without it, rooms cannot record. */
  recordingsDir?: string
  /** SIP hosts an operator may dial a voice agent in from (ElevenLabs by default). */
  sipHosts?: string[]
  origin?: string
  fetch?: typeof fetch
}

/** The agents that can be asked into a room, with the voice each speaks in. */
export const AGENTS: Record<string, { about: string; voice: string }> = {
  riotcoder: { about: 'Builds and ships things for Anthony. Voice: Chris.', voice: 'ElevenLabs Chris' },
  cha0spunk: { about: 'Works the inbound queue: email, support, follow-ups. Voice: Jessica.', voice: 'ElevenLabs Jessica' },
}

export const FREE_ROOMS = 3
/** Invite links each person can hand out. Scarce on purpose: an invite should mean something. */
export const INVITES_PER_PERSON = 3
/** Minutes both people get when an invite is used. */
export const INVITE_BONUS_MINUTES = 60
export const PASS_ROOMS = 50
export const PASS_USD = 5
export const PASS_DAYS = 30
export const CODE_LENGTH = 4
export const MAX_NAME = 60
/** Phones a room may ring from the keypad (* number #) in an hour; the web and API have their own limit. */
export const LINE_DIALS_PER_HOUR = 10
/** What calls out may cost a day, all rooms together, unless configured. */
export const DAILY_SPEND_USD = 5
/** A SIP agent's minute, until call.cost says (Telnyx charges SIP termination too). */
const SIP_RATE = 0.01
/** Telnyx ends any call at four hours; a leg whose hangup we missed is counted no longer. */
const MAX_CALL_MS = 4 * 60 * 60_000
const utcDayStart = (now: number) => now - (now % 86_400_000)

/** A room's code shown for reading and dialling: "4821". */
export const formatNumber = (e164: string) => {
  const d = e164.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : e164
}

/** One tap from a phone: dial, wait for the prompt, key the code. */
export const telLink = (dialIn: string, code: string) => `tel:${dialIn},,,${code}%23`

export type LiveEvent = { type: 'join' | 'leave' | 'say' | 'invite' | 'line'; code: string; who: string; text?: string; callers: number; at: number; line?: Line }

/** A participant as a page or the API may see them: a name, or a masked number. */
/** Who a room's greeter waits for, in words. */
export const hostLabel = (room: Room): string => (room.host ? (room.host.startsWith('+') ? `the person calling from ${formatNumber(room.host)}` : room.host) : 'the next person to join')

export function shownParticipant(p: Participant, agentNumbers: Record<string, string> = {}, known: Record<string, string> = {}, calledIn: Map<string, string> = new Map()): { name: string; kind: 'agent' | 'person'; since: number; trusted?: boolean } {
  const knownName = Object.entries(known).find(([n]) => normalNumber(n) === normalNumber(p.from))?.[1]
  if (knownName && !p.name) return { name: knownName, kind: 'person', since: p.joinedAt, trusted: true }
  // A person the room rang, by the name its owner gave: a person, and not one agents take work from.
  const calledName = p.from ? calledIn.get(normalNumber(p.from)) : undefined
  if (calledName && !p.name) return { name: calledName, kind: 'person', since: p.joinedAt }
  // Each agent has its own number, so the number names it even when nothing else did.
  const agentByNumber = Object.entries(agentNumbers).find(([, n]) => normalNumber(n) === normalNumber(p.from))?.[0]
  if (agentByNumber) return { name: p.name || agentByNumber, kind: 'agent', since: p.joinedAt }
  const agent = Boolean(p.name)
  const masked = p.from ? `caller ending ${p.from.replace(/\D/g, '').slice(-2)}` : 'a caller'
  return { name: p.name || (agent ? 'an agent' : masked), kind: agent ? 'agent' : 'person', since: p.joinedAt }
}

export class GroupCallService {
  readonly line: GroupCall | null
  /** Redeemable credit codes (@profullstack/redeem-credits): extra call minutes, one-off or monthly. */
  readonly credits: Credits
  /** Scarce invite codes and affiliate links (@profullstack/affiliates). */
  readonly affiliates: Affiliates
  private readonly listeners = new Map<string, Set<(e: LiveEvent) => void>>()
  private readonly store: Store
  readonly config: Config
  private readonly agentNumbers: Record<string, string>
  /** Phones a room rang, by number, with the name the owner gave them. */
  private readonly calledIn = new Map<string, string>()
  /** When each room last rang phones from the keypad, for its hourly cap. */
  private readonly lineDials = new Map<string, number[]>()
  readonly router: Router

  constructor(store: Store, config: Config) {
    this.store = store
    this.config = config
    const routes = config.routes?.length ? config.routes : config.telnyxConnectionId ? [{ provider: 'telnyx', connectionId: config.telnyxConnectionId, rates: defaultDeck() }] : []
    this.router = new Router(routes, config.maxRate)
    this.agentNumbers = config.agentCallerIds ?? {}
    this.credits = new Credits(sqliteStore(store.db as never))
    this.affiliates = new Affiliates(affiliateStore(store.db as never), { defaultQuota: INVITES_PER_PERSON })
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
            onCode: async (code) => {
              const room = store.room(code)
              if (!room) return { reject: 'That is not a room.' }
              const owner = store.user(room.sub)
              if (owner && (await this.minutes(owner)).left <= 0) return { reject: 'This room has used its call minutes for the month.' }
              store.touchRoom(code)
              return { welcome: `Welcome to ${room.name}. ${owner && this.mayCallPhones(owner) ? 'Press star to call someone in. ' : ''}` }
            },
            onInvite: (code, who, digits) => this.callInFromLine(code, who, digits),
            onJoin: (code, who, info) => {
              if (info.conferenceId) store.saveLeg(code, info.conferenceId, info.startedAt, who)
              if (info.conferenceId && store.room(code)?.record) void this.startRecording(code, info.conferenceId)
              this.record(code, 'join', who, info.callers)
              this.maybeGreet(code, who)
              // One leg per agent per room: a newer one replaces an older, so a restart or a
              // process that died without hanging up can never leave a silent twin behind.
              const shown = shownParticipant(who, this.agentNumbers, this.config.knownCallers, this.calledIn)
              if (shown.kind === 'agent' && shown.name !== 'an agent') {
                for (const p of this.line?.participants(code) ?? []) {
                  if (p.leg !== who.leg && shownParticipant(p, this.agentNumbers, this.config.knownCallers, this.calledIn).name === shown.name) void this.line?.kick(code, p.leg)
                }
              }
            },
            onLeave: (code, who, info) => {
              store.dropLeg(code, who.leg, info.callers === 0)
              this.record(code, 'leave', who, info.callers)
              void this.charge(code, who.joinedAt).catch((e) => console.error('group.call: minutes:', e))
            },
            ...(config.transcribe === false ? {} : { transcribe: { engine: 'Deepgram', language: 'en' } }),
            onTranscript: (code, who, text) => {
              const shown = shownParticipant(who, this.agentNumbers, this.config.knownCallers, this.calledIn)
              // An agent's voice coming back through a person's speakerphone is the agent, not them.
              if (shown.kind === 'person' && this.isEcho(code, text)) return
              this.addLine(code, shown.name, shown.kind, text)
            },
            onRecording: (r) => void this.saveRecording(r).catch((e) => console.error('group call: recording:', e)),
            onEvent: (line) => console.log(line),
          })
        : null
    if (config.recordingsDir) mkdirSync(config.recordingsDir, { recursive: true })
    // The day's spend is checked before every call, and again here while calls run.
    if (this.line) setInterval(() => void this.enforceBudget().catch((e) => console.error('group.call: budget:', e)), 15_000).unref()
  }

  // ---- what calls out cost -------------------------------------------------

  get dailyCap(): number {
    return this.config.dailySpendUsd ?? DAILY_SPEND_USD
  }

  /**
   * What calls placed today (UTC) have cost: Telnyx's own figure for every call it
   * has priced, and minutes so far at the route's rate for the rest, rounded up
   * to whole minutes the way calls are billed.
   */
  spentToday(now = Date.now()): number {
    let usd = 0
    for (const d of this.store.dialledSince(utcDayStart(now))) {
      if (d.cost !== null) usd += d.cost
      else usd += Math.ceil(Math.min((d.endedAt ?? now) - d.placedAt, MAX_CALL_MS) / 60_000) * d.rate
    }
    return Math.round(usd * 10_000) / 10_000
  }

  /** Over the day's cap: hang up every call this instance placed that is still going. */
  async enforceBudget(now = Date.now()): Promise<number> {
    if (this.spentToday(now) < this.dailyCap) return 0
    const live = this.store.dialledSince(utcDayStart(now) - MAX_CALL_MS).filter((d) => d.endedAt === null && now - d.placedAt < MAX_CALL_MS)
    for (const d of live) {
      console.warn(`group.call: daily call budget ($${this.dailyCap}) reached, hanging up ${d.provider} call ${d.leg}`)
      await this.hangupLeg(d.leg)
      this.store.endDialled(d.leg, now)
    }
    return live.length
  }

  /** Hang a leg up whether or not it has reached the room yet (still ringing, or at the press-1 question). */
  private async hangupLeg(leg: string): Promise<void> {
    try {
      await (this.config.fetch ?? fetch)(`https://api.telnyx.com/v2/calls/${encodeURIComponent(leg)}/actions/hangup`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.telnyxApiKey}`, 'content-type': 'application/json' },
        body: '{}',
      })
    } catch (e) {
      console.error('group.call: hangup failed:', e)
    }
  }

  /** Refuse a call the day's budget cannot pay a first minute of. */
  private budgetFor(rate: number, field: string): void {
    if (this.dailyCap - this.spentToday() < rate) throw new UserError('group.call has used its calling budget for today. Try again after midnight UTC.', field, 429)
  }

  /** Telnyx's word on a leg we placed: its hangup, and later what it cost and so what a minute there really costs. */
  private costEvent(event: TelnyxEvent): void {
    const p = (event.payload ?? {}) as Record<string, any>
    const leg = String(p.call_control_id ?? '')
    const d = leg ? this.store.dialled(leg) : null
    if (!d) return
    if (event.event_type === 'call.hangup') this.store.endDialled(leg, Date.now())
    if (event.event_type !== 'call.cost' || p.status === 'error' || p.total_cost == null) return
    this.store.costDialled(leg, Number(p.total_cost), Date.now())
    // Every part (termination, call control, ...) is billed by the minute; together they are the rate.
    const rate = ((p.cost_parts ?? []) as { rate?: string }[]).reduce((sum, part) => sum + (Number(part.rate) || 0), 0)
    if (rate > 0 && d.provider !== 'sip') this.store.learnRate(d.provider, learnedPrefix(d.to), rate)
  }

  // ---- recordings ----------------------------------------------------------

  /** Whether this instance can record at all. */
  get canRecord(): boolean {
    return Boolean(this.line && this.config.recordingsDir)
  }

  /** Start recording a room's running conference, once per conference. */
  private async startRecording(code: string, conferenceId: string): Promise<void> {
    if (!this.canRecord || this.line!.recording(code)) return
    if (!(await this.line!.record(code))) return
    if (!this.store.openRecording(conferenceId)) this.store.addRecording(code, conferenceId)
    this.store.addEvent({ code, kind: 'say', who: 'group.call', text: 'recording started' })
  }

  /** Turn a room's recording on or off; on with people on the line starts now. */
  async setRecord(user: User, code: string, on: boolean): Promise<{ record: boolean; recording: boolean }> {
    const room = this.ownRoom(user, code)
    if (on && !this.canRecord) throw new UserError('Recording is not set up on this instance.', undefined, 503)
    this.store.setRecord(room.code, on)
    const conf = this.store.liveSnapshot().find((r) => r.code === room.code)?.conferenceId
    if (on && conf && (this.line?.callersIn(room.code) ?? 0) > 0) await this.startRecording(room.code, conf)
    if (!on) await this.line?.stopRecording(room.code)
    return { record: on, recording: this.line?.recording(room.code) ?? false }
  }

  recordings(user: User, code: string): Recording[] {
    return this.store.recordings(this.ownRoom(user, code).code)
  }

  /** A recording file its room's owner may download, or null. */
  ownRecording(user: User, id: string): Recording | null {
    const rec = this.store.recording(id)
    if (!rec || rec.status !== 'ready') return null
    const room = this.store.room(rec.code)
    return room && room.sub === user.sub ? rec : null
  }

  /**
   * Telnyx saved a room's recording: download the mp3 now, while its signed link
   * still works, and asking Telnyx for a fresh one when it does not.
   */
  async saveRecording(r: SavedRecording): Promise<Recording | null> {
    const open = this.store.openRecording(r.conferenceId)
    const code = open?.code ?? r.code
    if (!code || !this.config.recordingsDir) {
      console.log(`  a recording was saved for a conference no room claims (${r.recordingId}).`)
      return null
    }
    const rec = open ?? this.store.addRecording(code, r.conferenceId)
    const started = r.startedAt ? Date.parse(r.startedAt) : NaN
    const ended = r.endedAt ? Date.parse(r.endedAt) : NaN
    this.store.updateRecording(rec.id, {
      recordingId: r.recordingId,
      status: 'saving',
      endedAt: Number.isFinite(ended) ? ended : Date.now(),
      durationSecs: Number.isFinite(started) && Number.isFinite(ended) ? Math.round((ended - started) / 1000) : null,
    })
    const path = `${this.config.recordingsDir.replace(/\/+$/, '')}/${rec.id}.mp3`
    const doFetch = this.config.fetch ?? fetch
    for (let attempt = 0; attempt < 4; attempt++) {
      const url = attempt === 0 ? r.mp3 : (await this.line?.recordingLinks(r.recordingId))?.mp3
      if (url) {
        try {
          const res = await doFetch(url)
          if (res.ok) {
            const bytes = await Bun.write(path, await res.arrayBuffer())
            this.store.updateRecording(rec.id, { status: 'ready', path, bytes })
            this.store.addEvent({ code, kind: 'say', who: 'group.call', text: `recording saved (${Math.round(bytes / 1024)} KB)` })
            return this.store.recording(rec.id)
          }
        } catch {}
      }
      await new Promise((ok) => setTimeout(ok, attempt === 0 ? 2000 : 10_000))
    }
    this.store.updateRecording(rec.id, { status: 'failed', note: 'the file could not be downloaded from Telnyx' })
    return this.store.recording(rec.id)
  }

  /**
   * Dial a voice agent into a room over SIP: no press 1, no greeting, named, with
   * X- headers that tell it which call this is. Operators only, and only to SIP
   * hosts this instance trusts, since it is a paid call to a machine.
   */
  async callSip(user: User, code: string, uri: string, name: string, headers: Record<string, string> = {}): Promise<{ ringing: true; to: string }> {
    const room = this.ownRoom(user, code)
    if (!this.mayInviteAgents(user)) throw new UserError('Dialling a SIP agent in is for the operators of this instance.', undefined, 403)
    const connectionId = this.config.telnyxConnectionId ?? this.router.routes[0]?.connectionId
    if (!this.line || !connectionId) throw new UserError('Calling out is not set up on this instance.', undefined, 503)
    const m = /^sips?:[^\s@]+@([^\s;:@]+)/i.exec(uri.trim())
    const hosts = this.config.sipHosts ?? ['sip.rtc.elevenlabs.io']
    if (!m || !hosts.includes(m[1]!.toLowerCase())) throw new UserError(`Only SIP agents at ${hosts.join(', ')}.`, 'sip')
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40) || 'agent'
    this.budgetFor(SIP_RATE, 'sip')
    const placed = await this.line.dial(room.code, uri.trim(), { from: this.config.dialIn, connectionId, name: clean, direct: true, headers })
    if (!placed) throw new UserError('The call could not be placed. Try again in a minute.', 'sip', 502)
    this.store.addDialled({ leg: placed.leg, code: room.code, to: uri.trim(), provider: 'sip', rate: SIP_RATE, placedAt: Date.now() })
    this.store.addEvent({ code: room.code, kind: 'invite', who: clean, text: 'is being called in' })
    this.emit({ type: 'invite', code: room.code, who: clean, text: 'is being called in', callers: this.line.callersIn(room.code), at: Date.now() })
    return { ringing: true, to: m[1]! }
  }

  private record(code: string, kind: 'join' | 'leave', who: Participant, callers: number): void {
    const shown = shownParticipant(who, this.agentNumbers, this.config.knownCallers, this.calledIn)
    this.store.addEvent({ code, kind, who: shown.name, text: '' })
    this.emit({ type: kind, code, who: shown.name, callers, at: Date.now() })
  }

  /** Whether a person's line mostly repeats what an agent said in the last 15 seconds. */
  private isEcho(code: string, text: string): boolean {
    const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1)
    const heard = words(text)
    if (heard.length === 0) return false
    const since = Date.now() - 15_000
    return this.store
      .transcript(code, { limit: 6 })
      .filter((l) => l.kind === 'agent' && l.at >= since)
      .some((l) => {
        const said = new Set(words(l.text))
        return heard.filter((w) => said.has(w)).length / heard.length >= 0.6
      })
  }

  /** "2026-10": the calendar month (UTC) minutes are counted in. */
  static month(at = Date.now()): string {
    return new Date(at).toISOString().slice(0, 7)
  }

  /**
   * A person's call minutes this month: the free allowance, plus credits they redeemed
   * (one-off or monthly), less what their rooms used. Operators have no limit.
   */
  async minutes(user: User): Promise<{ used: number; free: number; credits: number; left: number; unlimited: boolean }> {
    const used = this.store.minutesUsed(user.sub, GroupCallService.month())
    const free = this.config.freeMinutes ?? 300
    const credits = await this.credits.balance(user.sub, 'minutes')
    if (this.mayInviteAgents(user)) return { used, free, credits, left: Number.POSITIVE_INFINITY, unlimited: true }
    return { used, free, credits, left: Math.max(0, free - used) + credits, unlimited: false }
  }

  /** A leg left: its minutes go to the room owner, and what is over the free allowance comes out of credits. */
  private async charge(code: string, joinedAt: number): Promise<void> {
    const room = this.store.room(code)
    if (!room || !joinedAt) return
    const minutes = Math.max(1, Math.ceil((Date.now() - joinedAt) / 60_000))
    const free = this.config.freeMinutes ?? 300
    const before = this.store.minutesUsed(room.sub, GroupCallService.month())
    const after = this.store.addMinutes(room.sub, GroupCallService.month(), minutes)
    const over = Math.min(minutes, Math.max(0, after - Math.max(before, free)))
    if (over > 0) await this.credits.spend(room.sub, 'minutes', Math.min(over, await this.credits.balance(room.sub, 'minutes')), `room ${code}`)
  }

  /**
   * A new person signed in through an invite: the invite is spent, and both they and the
   * person who invited them get bonus minutes. False if the invite did not work.
   */
  async acceptInvite(code: string, user: User): Promise<{ ok: boolean; reason?: string; inviterId?: string }> {
    const r = await this.affiliates.redeemInvite(code, user.sub)
    if (!r.ok) return { ok: false, reason: r.reason }
    const bonus = { unit: 'minutes', amount: INVITE_BONUS_MINUTES } as const
    await this.credits.grant(user.sub, bonus, `invited by ${r.inviterId}`)
    await this.credits.grant(r.inviterId, bonus, `invited ${user.sub}`)
    return { ok: true, inviterId: r.inviterId }
  }

  /** Redeem a credit code for the signed-in person. */
  async redeem(user: User, code: string): Promise<string> {
    const r = await this.credits.redeem(code, user.sub)
    if (!r.ok) {
      const why: Record<string, string> = { invalid: 'That code is not valid.', expired: 'That code has expired.', used_up: 'That code has been used.', already_redeemed: 'You already redeemed that code.', revoked: 'That code was withdrawn.' }
      throw new UserError(why[r.reason] ?? 'That code did not work.', 'code')
    }
    const g = r.grant
    return g.every === 'month' ? `Added ${g.amount} ${g.unit} every month${g.months ? ` for ${g.months} months` : ''}.` : `Added ${g.amount} ${g.unit}.`
  }

  /** A line into the transcript, and out to every open room page. */
  private addLine(code: string, who: string, kind: Line['kind'], text: string): Line | null {
    // Speech recognition sometimes finalizes the same phrase twice ("Tokyo," then "Tokyo."): keep one.
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim()
    const since = Date.now() - 5000
    if (this.store.transcript(code, { limit: 4 }).some((l) => l.who === who && l.at >= since && norm(l.text) === norm(text))) return null
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
    this.recordQuality(event)
    this.costEvent(event)
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

  /** Whether a line's speaker is someone this instance knows (an agent may take work from them). */
  trusted(who: string, kind: string): boolean {
    return kind === 'person' && Object.values(this.config.knownCallers ?? {}).includes(who)
  }

  /** For an agent on the line: how many people (not agents) are still in the room. */
  roomStatus(code: string) {
    const live = this.live(code)
    const room = this.store.room(code)
    const trusted = new Set(Object.values(this.config.knownCallers ?? {}))
    // The last few lines with who said them, so an agent can tell whether a request came from someone it works for.
    const recent = this.store.transcript(code, { limit: 8 }).map((l) => ({ who: l.who, kind: l.kind, text: l.text, at: l.at, trusted: l.kind === 'person' && trusted.has(l.who) }))
    // The room's record is the agents' memory: a rejoining agent reads it and does not start over (SPEC-0001).
    const history = this.store.transcript(code, { limit: 80 }).map((l) => ({ who: l.who, kind: l.kind, text: l.text, at: l.at }))
    return { people: live.filter((p) => p.kind === 'person').length, agents: live.filter((p) => p.kind === 'agent').length, live, recent, history, agentSeen: this.store.agentSeen(code), greeter: room?.greeter ?? null, host: room ? hostLabel(room) : null, host_here: this.hostHere(code) }
  }

  /**
   * Telnyx's call_quality_stats on a leg's hangup: kept per leg, and a poor one is flagged in the
   * room's activity, so a breaking-up line is visible and blamed on the right leg.
   */
  private recordQuality(event: TelnyxEvent): void {
    if (event.event_type !== 'call.hangup' || !this.line) return
    const p = event.payload ?? {}
    const leg = typeof p['call_control_id'] === 'string' ? p['call_control_id'] : ''
    const stats = p['call_quality_stats'] as Record<string, Record<string, unknown>> | undefined
    if (!leg || !stats) return
    const num = (v: unknown) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
    for (const r of this.line.list()) {
      const who = this.line.participants(r.code).find((x) => x.leg === leg)
      if (!who) continue
      const shown = shownParticipant(who, this.agentNumbers, this.config.knownCallers, this.calledIn)
      const q = {
        code: r.code,
        leg,
        who: shown.name,
        mosIn: num(stats['inbound']?.['mos']),
        mosOut: num(stats['outbound']?.['mos']),
        jitterMs: num(stats['inbound']?.['jitter_max_variance'] ?? stats['inbound']?.['jitter']),
        lossPct: num(stats['inbound']?.['packet_loss'] ?? stats['inbound']?.['packet_loss_percent']),
      }
      this.store.addQuality(q)
      const poor = (q.mosIn !== null && q.mosIn < 3.6) || (q.mosOut !== null && q.mosOut < 3.6) || (q.lossPct !== null && q.lossPct > 1)
      if (poor) this.store.addEvent({ code: r.code, kind: 'quality', who: shown.name, text: `poor audio: MOS in ${q.mosIn ?? '?'} out ${q.mosOut ?? '?'}, loss ${q.lossPct ?? '?'}%` })
    }
  }

  live(code: string) {
    const people = this.line?.participants(code) ?? []
    return people.map((p) => shownParticipant(p, this.agentNumbers, this.config.knownCallers, this.calledIn))
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
    for (const rec of this.store.recordings(room.code, 10_000)) {
      try {
        if (rec.path) unlinkSync(rec.path)
      } catch {}
    }
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

  // ---- ringing a phone in --------------------------------------------------

  /** Who may have a room call a phone: operators and room-pass holders (it is a paid outbound call). */
  mayCallPhones(user: User | null): boolean {
    return Boolean(user && this.line && this.router.routes.length) && (this.mayInviteAgents(user) || Boolean(this.store.passUntil(user!.sub)))
  }

  /**
   * Ring a phone and bring whoever answers into the room, so a person does not
   * have to dial in. The call comes from the room's dial-in number, and the
   * answer presses 1 to join, so voicemail never lands in the room.
   */
  async callPhone(user: User, code: string, phone: string, name = ''): Promise<{ ringing: true; to: string; via: string; rate: number }> {
    const room = this.ownRoom(user, code)
    const canDial = Boolean(this.line && this.router.routes.length)
    if (!this.mayCallPhones(user)) throw new UserError(canDial ? `Calling a phone into a room comes with a room pass ($${PASS_USD} for ${PASS_DAYS} days).` : 'Calling phones is not set up on this instance.', 'phone', canDial ? 402 : 503)
    return this.ringIn(room, phone, user.name ?? '', name)
  }

  /**
   * Somebody on the line in a room keyed * number #: ring that number in. Anyone in
   * the room may, person or agent, because they keyed the room's code to get there;
   * the owner's pass pays for it, so the owner's pass is what is checked, and the
   * room has its own hourly cap since nobody on the phone has an account to limit.
   * What this returns is said to whoever keyed it.
   */
  async callInFromLine(code: string, who: Participant, digits: string): Promise<string> {
    const room = this.store.room(code)
    const owner = room ? this.store.user(room.sub) : null
    if (!room || !owner) return 'This room cannot call anyone in.'
    if (!this.mayCallPhones(owner)) return `Calling someone in from the phone comes with a room pass. The room's owner can get one on the website.`
    if ((await this.minutes(owner)).left <= 0) return 'This room has used its call minutes for the month.'
    const now = Date.now()
    const recent = (this.lineDials.get(room.code) ?? []).filter((t) => now - t < 60 * 60_000)
    if (recent.length >= LINE_DIALS_PER_HOUR) return `This room has called ${LINE_DIALS_PER_HOUR} people in this hour. Try again later.`
    const by = shownParticipant(who, this.agentNumbers, this.config.knownCallers, this.calledIn)
    try {
      const r = await this.ringIn(room, digits, by.name.startsWith('caller ending') || by.name === 'a caller' ? '' : by.name, '', by.name)
      recent.push(now)
      this.lineDials.set(room.code, recent)
      return `Calling ${r.to.replace(/\D/g, '').split('').join(' ')}. They join when they pick up and press 1.`
    } catch (e) {
      if (e instanceof UserError) return e.message.replace(/, like [^.]+/, '')
      throw e
    }
  }

  /**
   * Ring a phone and bring whoever answers into the room, so a person does not
   * have to dial in. The call comes from the room's dial-in number, and the
   * answer presses 1 to join, so voicemail never lands in the room.
   */
  private async ringIn(room: Room, phone: string, byName: string, name: string, askedBy = ''): Promise<{ ringing: true; to: string; via: string; rate: number }> {
    const { to, choices } = this.quote(phone)
    if (to === normalNumber(this.config.dialIn) || Object.values(this.agentNumbers).some((n) => normalNumber(n) === to)) throw new UserError('That is one of our own lines.', 'phone')
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40)
    this.budgetFor(choices[0]!.rate, 'phone')
    // Cheapest route first; a route that will not place the call hands over to the next.
    let placed: RouteChoice | null = null
    for (const route of choices) {
      const leg = await this.line!.dial(room.code, to, {
        from: route.from ?? this.config.dialIn,
        connectionId: route.connectionId,
        prompt: `This is group call. ${byName ? `${byName} is` : 'Someone is'} calling you into ${room.name}.`,
        welcome: `Welcome to ${room.name}. `,
      })
      if (leg) {
        placed = route
        this.store.addDialled({ leg: leg.leg, code: room.code, to, provider: route.provider, rate: route.rate, placedAt: Date.now() })
        break
      }
      console.warn(`group.call: ${route.provider} would not place a call to +${route.prefix}…, trying the next route`)
    }
    if (!placed) throw new UserError('The call could not be placed. Try again in a minute.', 'phone', 502)
    if (clean) this.calledIn.set(to, clean)
    const shown = clean || `phone ending ${to.slice(-2)}`
    const text = askedBy ? `is being called in by ${askedBy}` : 'is being called in'
    this.store.addEvent({ code: room.code, kind: 'invite', who: shown, text })
    this.emit({ type: 'invite', code: room.code, who: shown, text, callers: this.line?.callersIn(room.code) ?? 0, at: Date.now() })
    return { ringing: true, to: formatNumber(to), via: placed.provider, rate: placed.rate }
  }

  /**
   * Where a call to `phone` would go and what a minute costs on each route,
   * cheapest first. Throws when no route will carry it within the cap.
   */
  quote(phone: string): { to: string; choices: RouteChoice[] } {
    const to = normalNumber(phone)
    const nanp = /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(to)
    const usOnly = this.router.northAmericaOnly
    const ask = usOnly ? 'Give a US or Canadian phone number, like 408-555-0101.' : 'Give the number with its country code, like +44 20 7946 0000.'
    if (to.startsWith('+1') ? !nanp : !/^\+[2-9]\d{6,14}$/.test(to)) throw new UserError(ask, 'phone')
    const choices = this.router.choices(to, this.store.learnedRates())
    if (!choices.length) throw new UserError(usOnly ? ask : 'group.call will not call that number: it is blocked, or dearer a minute than this instance pays.', 'phone')
    return { to, choices }
  }

  // ---- our agents ----------------------------------------------------------

  mayInviteAgents(user: User | null): boolean {
    if (!user) return false
    // By CoinPay sub only. The email CoinPay returns is unverified (email_verified
    // is always false), so an email in this list must never grant anything.
    return (this.config.agentOperators ?? []).includes(user.sub)
  }

  inviteAgent(user: User, code: string, agent: string): AgentInvite {
    const room = this.ownRoom(user, code)
    if (!this.mayInviteAgents(user)) throw new UserError('Inviting our agents is for the operators of this instance for now. Your own agents can dial in themselves: see /help#agents.', undefined, 403)
    if (!AGENTS[agent]) throw new UserError(`No agent called ${agent}. Try ${Object.keys(AGENTS).join(' or ')}.`, 'agent', 404)
    const open = this.store.openInvite(room.code, agent)
    // A "dialling" invite whose agent never showed up (its process died) must not block a new one.
    const onLine = this.live(room.code).some((p) => p.name === agent)
    if (open && (open.status === 'queued' || onLine || Date.now() - open.updatedAt < 2 * 60_000)) return open
    if (open) this.store.finishInvite(open.id, 'failed', 'the agent never arrived')
    const invite = this.store.addInvite({ code: room.code, agent, sub: user.sub })
    this.store.addEvent({ code: room.code, kind: 'invite', who: agent, text: 'asked to dial in' })
    this.emit({ type: 'invite', code: room.code, who: agent, text: 'asked to dial in', callers: this.line?.callersIn(room.code) ?? 0, at: Date.now() })
    return invite
  }

  // ---- the greeter ---------------------------------------------------------

  /**
   * Give a room a greeter: one of our agents dials in when somebody arrives before the
   * host, keeps them company, and leaves when the host joins. `host` is who ends its
   * shift: a phone number, or a name on the line (a SIP agent like "riotcoder (host)");
   * none means whoever joins next. Operators only, like inviting an agent.
   */
  setGreeter(user: User, code: string, agent: string | null, host = ''): { greeter: string | null; host: string | null } {
    const room = this.ownRoom(user, code)
    if (!this.mayInviteAgents(user)) throw new UserError('A greeter is one of our agents, which is for the operators of this instance for now.', undefined, 403)
    const greeter = agent && agent !== 'off' ? agent : null
    if (greeter && !AGENTS[greeter]) throw new UserError(`No agent called ${greeter}. Try ${Object.keys(AGENTS).join(' or ')}.`, 'greeter', 404)
    const raw = host.replace(/\s+/g, ' ').trim().slice(0, 40)
    const asNumber = raw.replace(/\D/g, '').length >= 10 && /^[\d\s()+.-]+$/.test(raw) ? normalNumber(raw) : ''
    const who = greeter ? asNumber || raw || null : null
    this.store.setGreeter(room.code, greeter, who)
    return { greeter, host: who }
  }

  /** Whether whoever a greeter waits for is on the line: the room's host, or a second person when none is set. */
  hostHere(code: string): boolean {
    const room = this.store.room(code)
    if (!room) return false
    const legs = this.line?.participants(code) ?? []
    const shown = legs.map((p) => ({ p, s: shownParticipant(p, this.agentNumbers, this.config.knownCallers, this.calledIn) }))
    if (!room.host) return shown.filter((x) => x.s.kind === 'person').length >= 2
    const host = room.host
    if (host.startsWith('+')) return legs.some((p) => p.from && normalNumber(p.from) === host)
    const want = host.toLowerCase()
    return shown.some((x) => x.s.name !== room.greeter && x.s.name.toLowerCase().includes(want))
  }

  /** A person walked into a room with a greeter and nobody to meet them: send the greeter. */
  private maybeGreet(code: string, who: Participant): void {
    const room = this.store.room(code)
    if (!room?.greeter || !AGENTS[room.greeter]) return
    if (shownParticipant(who, this.agentNumbers, this.config.knownCallers, this.calledIn).kind !== 'person') return
    if (this.hostHere(code)) return
    if (this.live(code).some((p) => p.name === room.greeter)) return
    const open = this.store.openInvite(code, room.greeter)
    if (open && Date.now() - open.updatedAt < 2 * 60_000) return
    if (open) this.store.finishInvite(open.id, 'failed', 'the agent never arrived')
    this.store.addInvite({ code, agent: room.greeter, sub: room.sub, role: 'greeter' })
    this.store.addEvent({ code, kind: 'invite', who: room.greeter, text: 'is coming to greet' })
    this.emit({ type: 'invite', code, who: room.greeter, text: 'is coming to greet', callers: this.line?.callersIn(code) ?? 0, at: Date.now() })
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
      brief:
        invite.role === 'greeter'
          ? `You are the receptionist for the group call "${room.name}". ${people.length ? `Waiting on the line: ${people.join(', ')}.` : 'Somebody just dialled in.'} The host (${hostLabel(room)}) is not here yet. Greet them warmly, tell them the host is on the way, and keep them company: answer whatever they say and chat with them until the host arrives. You will be told when the host joins; then hand over in one sentence and leave.`
          : `You were asked to join the group call "${room.name}". ${people.length ? `On the line now: ${people.join(', ')}.` : 'Nobody is on the line yet.'}`,
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
