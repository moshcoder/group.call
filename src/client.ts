/**
 * The group.call API from anywhere: the CLI, the TUI, the MCP server and the
 * desktop app use this. GROUPCALL_KEY (gc_…, from group.call.pit.world/me)
 * signs every call; GROUPCALL_URL points it at another instance.
 */
export type ApiPerson = { name: string; kind: 'agent' | 'person'; since: number }
export type ApiActivity = { kind: string; who: string; text?: string; at: string }
export type ApiRoom = {
  code: string
  name: string
  dial_in: string
  tel: string
  on_the_line: number
  created_at: string
  last_used_at: string | null
  page: string
  record?: boolean
  recording?: boolean
  live?: ApiPerson[]
  activity?: ApiActivity[]
}
export type ApiRecording = { id: string; status: 'recording' | 'saving' | 'ready' | 'failed'; duration_secs: number | null; bytes: number; started_at: string; ended_at: string | null; mp3: string | null; note?: string }
export type ApiLine = { id: number; who: string; kind: 'person' | 'agent' | 'typed'; text: string; at: string }
export type ApiMe = { name: string; email: string; dial_in: string; pass_until: string | null; room_limit: number; can_invite_agents: boolean; can_call_phones?: boolean; agents: string[]; rooms: ApiRoom[] }

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export class GroupCallClient {
  readonly base: string
  private readonly key: string | undefined
  private readonly doFetch: typeof fetch
  constructor(base = process.env.GROUPCALL_URL ?? 'https://group.call.pit.world', key = process.env.GROUPCALL_KEY, doFetch: typeof fetch = fetch) {
    this.base = base.replace(/\/+$/, '')
    this.key = key
    this.doFetch = doFetch
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.key) throw new ApiError(`Set GROUPCALL_KEY to your key from ${this.base}/me`, 401)
    const response = await this.doFetch(this.base + path, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${this.key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    })
    const data = (await response.json().catch(() => ({}))) as { error?: string }
    if (!response.ok) throw new ApiError(data.error ?? `group.call answered ${response.status}`, response.status)
    return data as T
  }

  me(): Promise<ApiMe> {
    return this.call('GET', '/api/v1/me')
  }
  rooms(): Promise<{ rooms: ApiRoom[] }> {
    return this.call('GET', '/api/v1/rooms')
  }
  create(name: string, code?: string): Promise<ApiRoom> {
    return this.call('POST', '/api/v1/rooms', { name, ...(code ? { code } : {}) })
  }
  room(code: string): Promise<ApiRoom> {
    return this.call('GET', `/api/v1/rooms/${encodeURIComponent(code)}`)
  }
  rename(code: string, name: string): Promise<ApiRoom> {
    return this.call('PATCH', `/api/v1/rooms/${encodeURIComponent(code)}`, { name })
  }
  remove(code: string): Promise<{ ok: boolean }> {
    return this.call('DELETE', `/api/v1/rooms/${encodeURIComponent(code)}`)
  }
  /** The room's transcript: the last `limit` lines, or the lines after line id `after`. */
  transcript(code: string, after?: number, limit = 200): Promise<{ lines: ApiLine[] }> {
    const q = new URLSearchParams({ limit: String(limit), ...(after !== undefined ? { after: String(after) } : {}) })
    return this.call('GET', `/api/v1/rooms/${encodeURIComponent(code)}/transcript?${q}`)
  }
  /** Read a line aloud to everyone on the phone in the room. */
  say(code: string, text: string, as?: string): Promise<{ said: boolean; callers: number }> {
    return this.call('POST', `/api/v1/rooms/${encodeURIComponent(code)}/say`, { text, ...(as ? { as } : {}) })
  }
  /** Name the next caller from `from` into this room, for two minutes. */
  expect(code: string, name: string, from: string): Promise<{ ok: boolean; dial_in: string; code: string }> {
    return this.call('POST', `/api/v1/rooms/${encodeURIComponent(code)}/expect`, { name, from })
  }
  /** Ring a phone into the room: whoever answers presses 1 and is in. */
  callPhone(code: string, phone: string, name?: string): Promise<{ ringing: boolean; to: string }> {
    return this.call('POST', `/api/v1/rooms/${encodeURIComponent(code)}/call`, { phone, ...(name ? { name } : {}) })
  }
  /** A new single-use invite link (you have a few). */
  newInvite(note?: string): Promise<{ link: string; code: string; expires_at: string | null; left: number }> {
    return this.call('POST', '/api/v1/invites', note ? { note } : {})
  }
  /** Redeem a credit code (extra call minutes). */
  redeem(code: string): Promise<{ ok: boolean; message: string; minutes_left: number | null }> {
    return this.call('POST', '/api/v1/redeem', { code })
  }
  /** Dial a voice agent in over SIP: joins on answer, named, X- headers on the INVITE (operators). */
  callSip(code: string, sip: string, name: string, headers: Record<string, string> = {}): Promise<{ ringing: boolean; to: string }> {
    return this.call('POST', `/api/v1/rooms/${encodeURIComponent(code)}/call`, { sip, name, headers })
  }
  /** Record every call in the room (or stop). */
  record(code: string, on = true): Promise<{ record: boolean; recording: boolean }> {
    return this.call('POST', `/api/v1/rooms/${encodeURIComponent(code)}/record`, { on })
  }
  recordings(code: string): Promise<{ recordings: ApiRecording[] }> {
    return this.call('GET', `/api/v1/rooms/${encodeURIComponent(code)}/recordings`)
  }
  /** A ready recording's mp3 bytes. */
  async download(mp3Url: string): Promise<ArrayBuffer> {
    if (!this.key) throw new ApiError(`Set GROUPCALL_KEY to your key from ${this.base}/me`, 401)
    const response = await this.doFetch(mp3Url, { headers: { authorization: `Bearer ${this.key}` } })
    if (!response.ok) throw new ApiError(`group.call answered ${response.status}`, response.status)
    return response.arrayBuffer()
  }
  /** Ask one of our agents (riotcoder, cha0spunk) to dial in. */
  invite(code: string, agent: string): Promise<{ id: string; agent: string; status: string }> {
    return this.call('POST', `/api/v1/rooms/${encodeURIComponent(code)}/agents`, { agent })
  }
}
