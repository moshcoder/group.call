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
  greeter?: string | null
  host?: string | null
  recording?: boolean
  live?: ApiPerson[]
  activity?: ApiActivity[]
}
export type ApiWebhook = { id: string; url: string; events: string[]; description: string; enabled: boolean; failures: number; disabled_reason: string | null; created_at: string }
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
  callPhone(code: string, phone: string, name?: string): Promise<{ ringing: boolean; to: string; via: string; rate: number }> {
    return this.call('POST', `/api/v1/rooms/${encodeURIComponent(code)}/call`, { phone, ...(name ? { name } : {}) })
  }
  /** What ringing a number in costs: the routes that carry it, cheapest first. */
  rates(phone: string): Promise<{ to: string; max_rate: number; daily_cap_usd: number; spent_today_usd: number; routes: { provider: string; prefix: string; usd_per_minute: number }[] }> {
    return this.call('GET', `/api/v1/rates?phone=${encodeURIComponent(phone)}`)
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
  /** Have an agent greet early callers until the host (a phone or a name; blank = next person) arrives. `null` turns it off. */
  greeter(code: string, agent: string | null, host = ''): Promise<{ greeter: string | null; host: string | null }> {
    return this.call('POST', `/api/v1/rooms/${encodeURIComponent(code)}/greeter`, { agent, host })
  }
  /** Text everyone on the line in a room (a link, a note): from the room number to every person on the call. */
  text(code: string, text: string): Promise<{ sent: number; failed: number; skipped: number; via?: 'telnyx' | 'smshub'; error?: string }> {
    return this.call('POST', `/api/v1/rooms/${encodeURIComponent(code)}/text`, { text })
  }
  /** Send your rooms' group texts through your smshub.dev account (optional). */
  smshub(): Promise<{ linked: boolean; from: string | null; relay: boolean }> {
    return this.call('GET', '/api/v1/me/smshub')
  }
  linkSmshub(key: string, from?: string, relay = false): Promise<{ linked: true; from: string | null; relay: boolean; groups: number }> {
    return this.call('POST', '/api/v1/me/smshub', { key, ...(from ? { from } : {}), relay })
  }
  unlinkSmshub(): Promise<{ linked: false }> {
    return this.call('DELETE', '/api/v1/me/smshub')
  }
  /** Your webhook endpoints, and the events group.call sends. */
  webhooks(): Promise<{ endpoints: ApiWebhook[]; event_types: string[] }> {
    return this.call('GET', '/api/v1/webhooks')
  }
  addWebhook(url: string, events?: string[], description = ''): Promise<{ endpoint: ApiWebhook; secret: string }> {
    return this.call('POST', '/api/v1/webhooks', { url, ...(events?.length ? { events } : {}), description })
  }
  removeWebhook(id: string): Promise<{ deleted: true }> {
    return this.call('DELETE', `/api/v1/webhooks/${encodeURIComponent(id)}`)
  }
  testWebhook(id: string): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    return this.call('POST', `/api/v1/webhooks/${encodeURIComponent(id)}/test`)
  }
  rotateWebhook(id: string): Promise<{ secret: string }> {
    return this.call('POST', `/api/v1/webhooks/${encodeURIComponent(id)}/rotate`)
  }
  webhookLog(id?: string): Promise<{ deliveries: { id: string; event_type: string; status: string; attempts: number; last_status: number | null; last_error: string | null; created_at: string }[] }> {
    return this.call('GET', id ? `/api/v1/webhooks/${encodeURIComponent(id)}/deliveries` : '/api/v1/webhooks/deliveries')
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
  /** Invite people and agents from your contacts by name: "riotcoder, Kim". */
  inviteNames(code: string, names: string | string[]): Promise<{ results: InviteResult[]; said: string }> {
    return this.call('POST', `/api/v1/rooms/${encodeURIComponent(code)}/invite`, { names })
  }
  /** Your contacts book; operators also see our own agents (builtin). */
  contacts(): Promise<{ contacts: ApiContact[] }> {
    return this.call('GET', '/api/v1/contacts')
  }
  /** Resolve an exact id or name, refusing ambiguous names and builtin mutations. */
  async contact(reference: string, savedOnly = false): Promise<ApiContact> {
    const { contacts } = await this.contacts()
    const exact = contacts.find((c) => c.id === reference)
    const matches = exact ? [exact] : contacts.filter((c) => c.name.toLowerCase() === reference.toLowerCase())
    if (!matches.length) throw new Error(`no contact ${reference}`)
    if (matches.length > 1) throw new Error(`ambiguous contact ${reference}; use an id: ${matches.map((c) => c.id).join(', ')}`)
    const contact = matches[0]!
    if (savedOnly && contact.builtin) throw new Error(`${contact.name} is a builtin agent; add it to your contacts before editing or removing it`)
    return contact
  }
  addContact(contact: Partial<Omit<ApiContact, 'id' | 'builtin'>>): Promise<ApiContact> {
    return this.call('POST', '/api/v1/contacts', contact)
  }
  updateContact(id: string, contact: Partial<Omit<ApiContact, 'id' | 'builtin'>>): Promise<ApiContact> {
    return this.call('PATCH', `/api/v1/contacts/${encodeURIComponent(id)}`, contact)
  }
  removeContact(id: string): Promise<{ ok: true }> {
    return this.call('DELETE', `/api/v1/contacts/${encodeURIComponent(id)}`)
  }
}

export type ApiContact = { id: string; name: string; kind: 'person' | 'agent'; phone: string; sip: string; agent: string; email: string; aliases: string[]; note: string; trusted: boolean; builtin?: boolean }
export type InviteResult = { name: string; heard: string; status: 'invited' | 'calling' | 'here' | 'unknown' | 'ambiguous' | 'failed'; how?: 'agent' | 'sip' | 'phone' | 'email'; message: string }
