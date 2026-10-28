/**
 * group.call's state: one SQLite file.
 *
 * A person is their CoinPay account (`sub`); CoinPay is the only way in. A room
 * is a four-digit code and a name that belongs to one person. Who is on the
 * phone right now lives in memory (the engine knows); what we keep is the
 * room, a short log of comings and goings and lines said into it, the agents
 * asked to join and not yet dialled, and room passes bought through CoinPay.
 * CoinPay tokens are sealed with GROUPCALL_KEY.
 */
import { Database } from 'bun:sqlite'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export type User = { sub: string; name: string; email: string; apiKeyHash: string | null; createdAt: number }

export type Room = { code: string; sub: string; name: string; createdAt: number; lastUsedAt: number | null; record: boolean; greeter: string | null; host: string | null }

/** A recording of a room's call: started, then saved by Telnyx, then downloaded here. */
export type Recording = { id: string; code: string; conferenceId: string; recordingId: string | null; status: 'recording' | 'saving' | 'ready' | 'failed'; path: string; bytes: number; durationSecs: number | null; startedAt: number; endedAt: number | null; note: string }

/** What happened in a room: somebody joined or left, or a line was said into it. */
export type RoomEvent = { id: number; code: string; kind: 'join' | 'leave' | 'say' | 'invite' | 'quality'; who: string; text: string; at: number }

/** How a leg sounded, from Telnyx's call_quality_stats on hangup. */
export type LegQuality = { code: string; leg: string; who: string; mosIn: number | null; mosOut: number | null; jitterMs: number | null; lossPct: number | null; at: number }

/** One line said in a room: transcribed from a caller's leg, or typed in and read aloud. */
export type Line = { id: number; code: string; who: string; kind: 'person' | 'agent' | 'typed'; text: string; at: number }

export type AgentInvite = { id: string; code: string; agent: string; sub: string; role: string; status: 'queued' | 'dialling' | 'done' | 'failed'; note: string; createdAt: number; updatedAt: number }

export type Pass = { id: string; sub: string; amountCents: number; status: string; checkoutUrl: string; days: number; paidAt: number | null; createdAt: number }

/** A call the room placed (a phone rung in): what it was estimated to cost a minute and, once Telnyx says, what it cost. */
export type DialledLeg = { leg: string; code: string; to: string; provider: string; rate: number; placedAt: number; endedAt: number | null; cost: number | null }

export class Sealer {
  private readonly key: Buffer
  constructor(secret: string) {
    if (!secret || secret.length < 16) throw new Error('GROUPCALL_KEY must be set (32 random bytes, hex)')
    this.key = createHash('sha256').update(secret).digest()
  }
  seal(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.')
  }
  open(sealed: string): string {
    const [iv, tag, body] = sealed.split('.').map((s) => Buffer.from(s, 'base64'))
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv!)
    decipher.setAuthTag(tag!)
    return Buffer.concat([decipher.update(body!), decipher.final()]).toString('utf8')
  }
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

export type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number }

export class Store {
  readonly db: Database
  private readonly sealer: Sealer
  constructor(path: string, sealer: Sealer) {
    this.sealer = sealer
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        sub TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        tokens TEXT,
        api_key_hash TEXT UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS rooms_sub ON rooms(sub, created_at DESC);
      CREATE TABLE IF NOT EXISTS room_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        kind TEXT NOT NULL,
        who TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS room_events_code ON room_events(code, id DESC);
      CREATE TABLE IF NOT EXISTS transcript_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        who TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transcript_lines_code ON transcript_lines(code, id);
      CREATE TABLE IF NOT EXISTS minutes_used (sub TEXT NOT NULL, month TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sub, month));
      CREATE TABLE IF NOT EXISTS leg_quality (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL, leg TEXT NOT NULL, who TEXT NOT NULL,
        mos_in REAL, mos_out REAL, jitter_ms REAL, loss_pct REAL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS leg_quality_code ON leg_quality(code, id DESC);
      CREATE TABLE IF NOT EXISTS dialled_legs (
        leg TEXT PRIMARY KEY, code TEXT NOT NULL, to_number TEXT NOT NULL, provider TEXT NOT NULL,
        rate REAL NOT NULL, placed_at INTEGER NOT NULL, ended_at INTEGER, cost REAL
      );
      CREATE INDEX IF NOT EXISTS dialled_legs_placed ON dialled_legs(placed_at);
      CREATE TABLE IF NOT EXISTS learned_rates (provider TEXT NOT NULL, prefix TEXT NOT NULL, rate REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (provider, prefix));
      CREATE TABLE IF NOT EXISTS live_rooms (code TEXT PRIMARY KEY, conference_id TEXT NOT NULL, started_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS live_legs (
        leg TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        from_number TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        joined_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_invites (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        agent TEXT NOT NULL,
        sub TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_invites_status ON agent_invites(status, created_at);
      CREATE TABLE IF NOT EXISTS passes (
        id TEXT PRIMARY KEY,
        sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        checkout_url TEXT NOT NULL DEFAULT '',
        days INTEGER NOT NULL,
        paid_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS passes_sub ON passes(sub, created_at DESC);
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        conference_id TEXT NOT NULL,
        recording_id TEXT,
        status TEXT NOT NULL DEFAULT 'recording',
        path TEXT NOT NULL DEFAULT '',
        bytes INTEGER NOT NULL DEFAULT 0,
        duration_secs INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        note TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS recordings_code ON recordings(code, started_at DESC);
      CREATE INDEX IF NOT EXISTS recordings_conference ON recordings(conference_id);
    `)
    // Added after launch: a room that records every call on it.
    try {
      this.db.exec('ALTER TABLE rooms ADD COLUMN record INTEGER NOT NULL DEFAULT 0')
    } catch {}
    // Added later: an agent that waits in the room with early callers until the host arrives.
    for (const sql of ['ALTER TABLE rooms ADD COLUMN greeter TEXT', 'ALTER TABLE rooms ADD COLUMN host TEXT', "ALTER TABLE agent_invites ADD COLUMN role TEXT NOT NULL DEFAULT ''"]) {
      try {
        this.db.exec(sql)
      } catch {}
    }
  }

  // ---- people ------------------------------------------------------------

  private toUser(row: any): User | null {
    return row ? { sub: row.sub, name: row.name, email: row.email, apiKeyHash: row.api_key_hash, createdAt: row.created_at } : null
  }

  upsertUser(sub: string, name: string, email: string, tokens: Tokens, now = Date.now()): User {
    this.db
      .query(
        `INSERT INTO users (sub, name, email, tokens, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sub) DO UPDATE SET name = excluded.name, email = excluded.email, tokens = excluded.tokens`,
      )
      .run(sub, name, email, this.sealer.seal(JSON.stringify(tokens)), now)
    return this.user(sub)!
  }

  user(sub: string): User | null {
    return this.toUser(this.db.query('SELECT * FROM users WHERE sub = ?').get(sub))
  }

  byApiKey(key: string): User | null {
    return key ? this.toUser(this.db.query('SELECT * FROM users WHERE api_key_hash = ?').get(hashKey(key))) : null
  }

  setApiKey(sub: string, key: string): void {
    this.db.query('UPDATE users SET api_key_hash = ? WHERE sub = ?').run(hashKey(key), sub)
  }

  deleteUser(sub: string): void {
    this.db.query('DELETE FROM users WHERE sub = ?').run(sub)
  }

  newSession(sub: string, now = Date.now()): string {
    const id = randomBytes(24).toString('base64url')
    this.db.query('INSERT INTO sessions (id, sub, created_at) VALUES (?, ?, ?)').run(hashKey(id), sub, now)
    return id
  }

  session(id: string | undefined, now = Date.now(), maxAgeMs = 30 * 86400_000): User | null {
    if (!id) return null
    const row: any = this.db.query('SELECT sub, created_at FROM sessions WHERE id = ?').get(hashKey(id))
    if (!row || now - row.created_at > maxAgeMs) return null
    return this.user(row.sub)
  }

  endSession(id: string | undefined): void {
    if (id) this.db.query('DELETE FROM sessions WHERE id = ?').run(hashKey(id))
  }

  saveState(state: string, verifier: string, redirectUri: string, now = Date.now()): void {
    this.db.query('DELETE FROM oauth_states WHERE created_at < ?').run(now - 15 * 60_000)
    this.db.query('INSERT INTO oauth_states (state, verifier, redirect_uri, created_at) VALUES (?, ?, ?, ?)').run(state, this.sealer.seal(verifier), redirectUri, now)
  }

  takeState(state: string, now = Date.now()): { verifier: string; redirectUri: string } | null {
    const row: any = this.db.query('DELETE FROM oauth_states WHERE state = ? RETURNING verifier, redirect_uri, created_at').get(state)
    if (!row || now - row.created_at > 15 * 60_000) return null
    return { verifier: this.sealer.open(row.verifier), redirectUri: row.redirect_uri }
  }

  // ---- rooms -------------------------------------------------------------

  private toRoom(r: any): Room | null {
    return r ? { code: r.code, sub: r.sub, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, record: r.record === 1, greeter: r.greeter ?? null, host: r.host ?? null } : null
  }

  addRoom(r: Pick<Room, 'code' | 'sub' | 'name'>, now = Date.now()): Room {
    this.db.query('INSERT INTO rooms (code, sub, name, created_at) VALUES (?, ?, ?, ?)').run(r.code, r.sub, r.name, now)
    return this.room(r.code)!
  }

  room(code: string): Room | null {
    return this.toRoom(this.db.query('SELECT * FROM rooms WHERE code = ?').get(code))
  }

  rooms(sub: string): Room[] {
    return (this.db.query('SELECT * FROM rooms WHERE sub = ? ORDER BY created_at DESC').all(sub) as any[]).map((r) => this.toRoom(r)!)
  }

  codeTaken(code: string): boolean {
    return this.db.query('SELECT 1 FROM rooms WHERE code = ?').get(code) !== null
  }

  renameRoom(code: string, name: string): void {
    this.db.query('UPDATE rooms SET name = ? WHERE code = ?').run(name, code)
  }

  setGreeter(code: string, greeter: string | null, host: string | null): void {
    this.db.query('UPDATE rooms SET greeter = ?, host = ? WHERE code = ?').run(greeter, host, code)
  }

  setRecord(code: string, on: boolean): void {
    this.db.query('UPDATE rooms SET record = ? WHERE code = ?').run(on ? 1 : 0, code)
  }

  // ---- recordings ----------------------------------------------------------

  private toRecording(r: any): Recording | null {
    return r ? { id: r.id, code: r.code, conferenceId: r.conference_id, recordingId: r.recording_id, status: r.status, path: r.path, bytes: r.bytes, durationSecs: r.duration_secs, startedAt: r.started_at, endedAt: r.ended_at, note: r.note } : null
  }

  addRecording(code: string, conferenceId: string, now = Date.now()): Recording {
    const id = `rec_${randomBytes(9).toString('base64url')}`
    this.db.query('INSERT INTO recordings (id, code, conference_id, started_at) VALUES (?, ?, ?, ?)').run(id, code, conferenceId, now)
    return this.recording(id)!
  }

  recording(id: string): Recording | null {
    return this.toRecording(this.db.query('SELECT * FROM recordings WHERE id = ?').get(id))
  }

  /** The recording still running on a conference: what a saved webhook belongs to. */
  openRecording(conferenceId: string): Recording | null {
    return this.toRecording(this.db.query("SELECT * FROM recordings WHERE conference_id = ? AND status = 'recording' ORDER BY started_at DESC LIMIT 1").get(conferenceId))
  }

  recordings(code: string, limit = 50): Recording[] {
    return (this.db.query('SELECT * FROM recordings WHERE code = ? ORDER BY started_at DESC LIMIT ?').all(code, limit) as any[]).map((r) => this.toRecording(r)!)
  }

  updateRecording(id: string, patch: Partial<Pick<Recording, 'recordingId' | 'status' | 'path' | 'bytes' | 'durationSecs' | 'endedAt' | 'note'>>): void {
    const cols: Record<string, string> = { recordingId: 'recording_id', status: 'status', path: 'path', bytes: 'bytes', durationSecs: 'duration_secs', endedAt: 'ended_at', note: 'note' }
    const sets = Object.keys(patch).filter((k) => k in cols)
    if (sets.length === 0) return
    this.db.query(`UPDATE recordings SET ${sets.map((k) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`).run(...sets.map((k) => (patch as any)[k] ?? null), id)
  }

  touchRoom(code: string, now = Date.now()): void {
    this.db.query('UPDATE rooms SET last_used_at = ? WHERE code = ?').run(now, code)
  }

  removeRoom(code: string): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM rooms WHERE code = ?').run(code)
      this.db.query('DELETE FROM room_events WHERE code = ?').run(code)
      this.db.query('DELETE FROM transcript_lines WHERE code = ?').run(code)
      this.db.query('DELETE FROM recordings WHERE code = ?').run(code)
    })()
  }

  /** Append to a room's log, keeping the newest 500. */
  addEvent(e: Omit<RoomEvent, 'id' | 'at'>, now = Date.now()): RoomEvent {
    const row: any = this.db
      .query('INSERT INTO room_events (code, kind, who, text, at) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .get(e.code, e.kind, e.who.slice(0, 80), e.text.slice(0, 500), now)
    this.db.query('DELETE FROM room_events WHERE code = ? AND id <= (SELECT id FROM room_events WHERE code = ? ORDER BY id DESC LIMIT 1 OFFSET 500)').run(e.code, e.code)
    return { id: row.id, ...e, at: now }
  }

  events(code: string, limit = 50): RoomEvent[] {
    return (this.db.query('SELECT * FROM room_events WHERE code = ? ORDER BY id DESC LIMIT ?').all(code, limit) as any[]).map((r) => ({ id: r.id, code: r.code, kind: r.kind, who: r.who, text: r.text, at: r.at }))
  }

  // ---- minutes ------------------------------------------------------------

  /** Minutes a person's rooms used in a calendar month (UTC, "2026-10"). */
  minutesUsed(sub: string, month: string): number {
    return ((this.db.query('SELECT minutes FROM minutes_used WHERE sub = ? AND month = ?').get(sub, month) as { minutes: number } | null)?.minutes) ?? 0
  }

  addMinutes(sub: string, month: string, minutes: number): number {
    this.db.query('INSERT INTO minutes_used (sub, month, minutes) VALUES (?, ?, ?) ON CONFLICT(sub, month) DO UPDATE SET minutes = minutes + excluded.minutes').run(sub, month, minutes)
    return this.minutesUsed(sub, month)
  }

  // ---- what calls out cost ----------------------------------------------

  addDialled(d: Omit<DialledLeg, 'endedAt' | 'cost'>): void {
    this.db.query('INSERT OR REPLACE INTO dialled_legs (leg, code, to_number, provider, rate, placed_at) VALUES (?, ?, ?, ?, ?, ?)').run(d.leg, d.code, d.to, d.provider, d.rate, d.placedAt)
  }

  dialled(leg: string): DialledLeg | null {
    const r = this.db.query('SELECT * FROM dialled_legs WHERE leg = ?').get(leg) as any
    return r ? dialledRow(r) : null
  }

  /** Calls placed since `since` (ms), the day's spend is counted from. */
  dialledSince(since: number): DialledLeg[] {
    return (this.db.query('SELECT * FROM dialled_legs WHERE placed_at >= ? ORDER BY placed_at').all(since) as any[]).map(dialledRow)
  }

  endDialled(leg: string, at: number): void {
    this.db.query('UPDATE dialled_legs SET ended_at = ? WHERE leg = ? AND ended_at IS NULL').run(at, leg)
  }

  costDialled(leg: string, cost: number, at: number): void {
    this.db.query('UPDATE dialled_legs SET cost = ?, ended_at = COALESCE(ended_at, ?) WHERE leg = ?').run(cost, at, leg)
  }

  learnRate(provider: string, prefix: string, rate: number, now = Date.now()): void {
    this.db.query('INSERT OR REPLACE INTO learned_rates (provider, prefix, rate, updated_at) VALUES (?, ?, ?, ?)').run(provider, prefix, rate, now)
  }

  /** What Telnyx actually charged a minute, by route and number prefix. */
  learnedRates(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {}
    for (const r of this.db.query('SELECT provider, prefix, rate FROM learned_rates').all() as any[]) (out[r.provider] ??= {})[r.prefix] = r.rate
    return out
  }

  // ---- call quality ------------------------------------------------------

  addQuality(q: Omit<LegQuality, 'at'>, now = Date.now()): void {
    this.db.query('INSERT INTO leg_quality (code, leg, who, mos_in, mos_out, jitter_ms, loss_pct, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(q.code, q.leg, q.who, q.mosIn, q.mosOut, q.jitterMs, q.lossPct, now)
  }

  quality(code: string, limit = 20): LegQuality[] {
    return (this.db.query('SELECT * FROM leg_quality WHERE code = ? ORDER BY id DESC LIMIT ?').all(code, limit) as any[]).map((r) => ({ code: r.code, leg: r.leg, who: r.who, mosIn: r.mos_in, mosOut: r.mos_out, jitterMs: r.jitter_ms, lossPct: r.loss_pct, at: r.at }))
  }

  /** When each agent last said something in a room (ms), for "is this a rejoin". */
  agentSeen(code: string): Record<string, number> {
    const rows = this.db.query("SELECT who, MAX(at) AS at FROM transcript_lines WHERE code = ? AND kind = 'agent' GROUP BY who").all(code) as { who: string; at: number }[]
    return Object.fromEntries(rows.map((r) => [r.who, r.at]))
  }

  // ---- transcripts ---------------------------------------------------------

  addLine(l: Omit<Line, 'id' | 'at'>, now = Date.now()): Line {
    const row: any = this.db
      .query('INSERT INTO transcript_lines (code, who, kind, text, at) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .get(l.code, l.who.slice(0, 80), l.kind, l.text.slice(0, 2000), now)
    return { id: row.id, ...l, at: now }
  }

  /** A room's transcript, oldest first: the last `limit` lines, or those after line `after`. */
  transcript(code: string, opts: { after?: number; limit?: number } = {}): Line[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 5000)
    const rows = (opts.after !== undefined
      ? this.db.query('SELECT * FROM transcript_lines WHERE code = ? AND id > ? ORDER BY id LIMIT ?').all(code, opts.after, limit)
      : this.db.query('SELECT * FROM (SELECT * FROM transcript_lines WHERE code = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(code, limit)) as any[]
    return rows.map((r) => ({ id: r.id, code: r.code, who: r.who, kind: r.kind, text: r.text, at: r.at }))
  }

  // ---- who is on the line, kept so a restart can put it back -------------

  saveLeg(code: string, conferenceId: string, startedAt: number, p: { leg: string; from: string; name: string; joinedAt: number }): void {
    this.db.transaction(() => {
      this.db.query('INSERT INTO live_rooms (code, conference_id, started_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET conference_id = excluded.conference_id, started_at = excluded.started_at').run(code, conferenceId, startedAt)
      this.db.query('INSERT OR REPLACE INTO live_legs (leg, code, from_number, name, joined_at) VALUES (?, ?, ?, ?, ?)').run(p.leg, code, p.from, p.name, p.joinedAt)
    })()
  }

  dropLeg(code: string, leg: string, roomEmpty: boolean): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM live_legs WHERE leg = ?').run(leg)
      if (roomEmpty) {
        this.db.query('DELETE FROM live_rooms WHERE code = ?').run(code)
        this.db.query('DELETE FROM live_legs WHERE code = ?').run(code)
      }
    })()
  }

  liveSnapshot(): { code: string; conferenceId: string; startedAt: number; participants: { leg: string; from: string; name: string; joinedAt: number }[] }[] {
    const rooms = this.db.query('SELECT * FROM live_rooms').all() as any[]
    return rooms.map((r) => ({
      code: r.code,
      conferenceId: r.conference_id,
      startedAt: r.started_at,
      participants: (this.db.query('SELECT * FROM live_legs WHERE code = ?').all(r.code) as any[]).map((l) => ({ leg: l.leg, from: l.from_number, name: l.name, joinedAt: l.joined_at })),
    }))
  }

  /** Keep only what a restore found still running. */
  pruneLive(keep: Map<string, Set<string>>): void {
    this.db.transaction(() => {
      for (const r of this.db.query('SELECT code FROM live_rooms').all() as { code: string }[]) {
        const legs = keep.get(r.code)
        if (!legs) {
          this.db.query('DELETE FROM live_rooms WHERE code = ?').run(r.code)
          this.db.query('DELETE FROM live_legs WHERE code = ?').run(r.code)
          continue
        }
        for (const l of this.db.query('SELECT leg FROM live_legs WHERE code = ?').all(r.code) as { leg: string }[]) if (!legs.has(l.leg)) this.db.query('DELETE FROM live_legs WHERE leg = ?').run(l.leg)
      }
    })()
  }

  // ---- agent invites -----------------------------------------------------

  private toInvite(r: any): AgentInvite | null {
    return r ? { id: r.id, code: r.code, agent: r.agent, sub: r.sub, role: r.role ?? '', status: r.status, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at } : null
  }

  addInvite(i: Pick<AgentInvite, 'code' | 'agent' | 'sub'> & { role?: string }, now = Date.now()): AgentInvite {
    const id = `inv_${randomBytes(9).toString('base64url')}`
    this.db.query("INSERT INTO agent_invites (id, code, agent, sub, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)").run(id, i.code, i.agent, i.sub, i.role ?? '', now, now)
    return this.invite(id)!
  }

  invite(id: string): AgentInvite | null {
    return this.toInvite(this.db.query('SELECT * FROM agent_invites WHERE id = ?').get(id))
  }

  /** An agent already asked into this room and not yet finished. */
  openInvite(code: string, agent: string): AgentInvite | null {
    return this.toInvite(this.db.query("SELECT * FROM agent_invites WHERE code = ? AND agent = ? AND status IN ('queued', 'dialling') ORDER BY created_at DESC LIMIT 1").get(code, agent))
  }

  /**
   * The oldest queued invite, claimed for dialling in the same statement so two
   * workers never dial the same agent. Invites older than ten minutes are stale:
   * whoever asked has given up.
   */
  claimInvite(now = Date.now()): AgentInvite | null {
    this.db.query("UPDATE agent_invites SET status = 'failed', note = 'nobody picked it up in time', updated_at = ? WHERE status = 'queued' AND created_at < ?").run(now, now - 10 * 60_000)
    return this.toInvite(
      this.db
        .query("UPDATE agent_invites SET status = 'dialling', updated_at = ? WHERE id = (SELECT id FROM agent_invites WHERE status = 'queued' ORDER BY created_at LIMIT 1) RETURNING *")
        .get(now),
    )
  }

  finishInvite(id: string, status: 'done' | 'failed', note = '', now = Date.now()): void {
    this.db.query('UPDATE agent_invites SET status = ?, note = ?, updated_at = ? WHERE id = ?').run(status, note.slice(0, 300), now, id)
  }

  invites(code: string, limit = 10): AgentInvite[] {
    return (this.db.query('SELECT * FROM agent_invites WHERE code = ? ORDER BY created_at DESC LIMIT ?').all(code, limit) as any[]).map((r) => this.toInvite(r)!)
  }

  // ---- room passes -------------------------------------------------------

  private toPass(r: any): Pass | null {
    return r ? { id: r.id, sub: r.sub, amountCents: r.amount_cents, status: r.status, checkoutUrl: r.checkout_url, days: r.days, paidAt: r.paid_at, createdAt: r.created_at } : null
  }

  addPass(p: Pick<Pass, 'id' | 'sub' | 'amountCents' | 'checkoutUrl' | 'days'>, now = Date.now()): Pass {
    this.db.query("INSERT OR IGNORE INTO passes (id, sub, amount_cents, status, checkout_url, days, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)").run(p.id, p.sub, p.amountCents, p.checkoutUrl, p.days, now)
    return this.pass(p.id)!
  }

  pass(id: string): Pass | null {
    return this.toPass(this.db.query('SELECT * FROM passes WHERE id = ?').get(id))
  }

  passes(sub: string): Pass[] {
    return (this.db.query('SELECT * FROM passes WHERE sub = ? ORDER BY created_at DESC LIMIT 50').all(sub) as any[]).map((r) => this.toPass(r)!)
  }

  pendingPasses(sub: string): Pass[] {
    return (this.db.query("SELECT * FROM passes WHERE sub = ? AND status = 'pending'").all(sub) as any[]).map((r) => this.toPass(r)!)
  }

  /** Marks a pass paid once; returns true only the first time. */
  markPassPaid(id: string, now = Date.now()): boolean {
    return this.db.query("UPDATE passes SET status = 'paid', paid_at = ? WHERE id = ? AND status != 'paid'").run(now, id).changes > 0
  }

  setPassStatus(id: string, status: string): void {
    this.db.query("UPDATE passes SET status = ? WHERE id = ? AND status != 'paid'").run(status, id)
  }

  /**
   * When the person's pass runs out, or null without one. Passes stack: each paid
   * one adds its days after the later of when it was paid and when the last ran out.
   */
  passUntil(sub: string, now = Date.now()): number | null {
    const paid = (this.db.query("SELECT days, paid_at FROM passes WHERE sub = ? AND status = 'paid' ORDER BY paid_at").all(sub) as { days: number; paid_at: number }[])
    let until = 0
    for (const p of paid) until = Math.max(until, p.paid_at) + p.days * 86400_000
    return until > now ? until : null
  }
}

const dialledRow = (r: any): DialledLeg => ({ leg: r.leg, code: r.code, to: r.to_number, provider: r.provider, rate: r.rate, placedAt: r.placed_at, endedAt: r.ended_at, cost: r.cost })
