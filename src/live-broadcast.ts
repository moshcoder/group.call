/**
 * Receive-only Telnyx media fork -> a live MP3 anyone can listen to.
 *
 * Telnyx streams Riotcoder's leg (both tracks: what it says, and the room it
 * hears) over a WebSocket; the two tracks are mixed and encoded to MP3, and the
 * MP3 is served at /api/v1/broadcast/live.mp3 to every listener at once. When
 * a show starts, `onLive` is told the address (the server runs
 * GROUPCALL_BROADCAST_CMD with it, e.g. the golive CLI, which carries it to
 * nixamp, live.streaming, backtoschool.help and pairux.com/@moshcoding).
 *
 * It used to POST the MP3 to a nixamp server's /api/ingest, but nixamp's ingest
 * decodes into a pipe nobody reads, so nothing was ever heard.
 */
type BroadcastOptions = { streamUrl: string; listenUrl: string; name?: string; onLive?: (live: { url: string; name: string }) => void }
type Socket = { send: (data: string) => void; close: () => void }
type Ffmpeg = { stdin: { write: (data: Uint8Array) => void; flush?: () => void; end: () => void }; stdout: AsyncIterable<Uint8Array>; kill: () => void }
const clamp = (value: number) => Math.max(-32768, Math.min(32767, value))

function decodePcmu(payload: Uint8Array): Buffer {
  const out = Buffer.alloc(payload.length * 2)
  for (let i = 0; i < payload.length; i++) {
    const u = (~payload[i]!) & 0xff
    const sign = u & 0x80
    const exponent = (u >> 4) & 0x07
    const sample = ((u & 0x0f) << 3 | 0x84) << exponent
    out.writeInt16LE(sign ? 0x84 - sample : sample - 0x84, i * 2)
  }
  return out
}

function decodePcma(payload: Uint8Array): Buffer {
  const out = Buffer.alloc(payload.length * 2)
  for (let i = 0; i < payload.length; i++) {
    const a = payload[i]! ^ 0x55
    const sign = a & 0x80
    const exponent = (a >> 4) & 0x07
    const mantissa = a & 0x0f
    let sample = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1)
    if (sign === 0) sample = -sample
    out.writeInt16LE(sample, i * 2)
  }
  return out
}

function mix(a: Buffer, b: Buffer): Buffer {
  const size = Math.min(a.length, b.length)
  const out = Buffer.alloc(size)
  for (let i = 0; i + 1 < size; i += 2) out.writeInt16LE(clamp(a.readInt16LE(i) + b.readInt16LE(i)), i)
  return out
}

export class LiveBroadcastRelay {
  readonly streamUrl: string
  private readonly options: BroadcastOptions
  private socket: Socket | null = null
  private ffmpeg: Ffmpeg | null = null
  private listeners = new Set<ReadableStreamDefaultController<Uint8Array>>()
  /** The last few seconds of MP3, so a listener who arrives starts with sound, not silence. */
  private backlog: Uint8Array[] = []
  private backlogBytes = 0
  private tracks = new Map<string, Buffer[]>()
  private format = 'PCMU'
  private name: string

  constructor(options: BroadcastOptions) { this.options = options; this.streamUrl = options.streamUrl; this.name = options.name ?? 'TUI Weekly live' }
  accept(socket: Socket): void { this.stop(); this.socket = socket }

  async message(raw: string | Buffer): Promise<void> {
    let frame: any
    try { frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) } catch { return }
    if (frame.event === 'start') {
      this.format = String(frame.start?.media_format?.encoding ?? 'PCMU').toUpperCase()
      const state = frame.start?.client_state ?? frame.client_state
      if (typeof state === 'string') {
        try {
          const clientState = JSON.parse(Buffer.from(state, 'base64').toString('utf8')) as { podcast?: unknown }
          if (clientState.podcast === 'TUI Weekly' || clientState.podcast === 'Off The Record') this.name = `${clientState.podcast} live`
        } catch {}
      }
      await this.startEncoder(); return
    }
    if (frame.event === 'media') {
      const payload = frame.media?.payload
      if (typeof payload !== 'string' || !this.ffmpeg) return
      const bytes = Uint8Array.from(Buffer.from(payload, 'base64'))
      const pcm = this.format.includes('PCMA') ? decodePcma(bytes) : decodePcmu(bytes)
      const track = String(frame.media?.track ?? 'inbound')
      const queue = this.tracks.get(track) ?? []
      queue.push(pcm); this.tracks.set(track, queue); this.drain(); return
    }
    if (frame.event === 'stop') this.stop()
  }

  close(): void { this.stop() }

  /** Is a show on the air right now? */
  get live(): boolean {
    return this.ffmpeg !== null
  }

  get showName(): string {
    return this.name
  }

  /** A stream of the live MP3 for one listener, or null when nothing is on. */
  listen(): ReadableStream<Uint8Array> | null {
    if (!this.ffmpeg) return null
    let mine: ReadableStreamDefaultController<Uint8Array> | null = null
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        mine = controller
        for (const chunk of this.backlog) controller.enqueue(chunk)
        this.listeners.add(controller)
      },
      cancel: () => {
        if (mine) this.listeners.delete(mine)
      },
    })
  }

  private async startEncoder(): Promise<void> {
    this.stopEncoder()
    const child = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '8000', '-ac', '1', '-i', 'pipe:0', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '64k', '-flush_packets', '1', '-f', 'mp3', 'pipe:1'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' }) as unknown as Ffmpeg
    this.ffmpeg = child; this.tracks.clear(); this.backlog = []; this.backlogBytes = 0
    void (async () => {
      try {
        for await (const chunk of child.stdout) this.fanOut(chunk)
      } catch {}
    })()
    console.log(`group.call: ${this.name} is live at ${this.options.listenUrl}`)
    try { this.options.onLive?.({ url: this.options.listenUrl, name: this.name }) } catch (error) { console.error(`group.call: go-live hook failed: ${(error as Error).message}`) }
  }

  private fanOut(chunk: Uint8Array): void {
    this.backlog.push(chunk); this.backlogBytes += chunk.byteLength
    // ~8 s at 64 kbit/s.
    while (this.backlogBytes > 64_000 && this.backlog.length > 1) this.backlogBytes -= this.backlog.shift()!.byteLength
    for (const listener of this.listeners) {
      try { listener.enqueue(chunk) } catch { this.listeners.delete(listener) }
    }
  }

  private drain(): void {
    if (!this.ffmpeg) return
    const inbound = this.tracks.get('inbound') ?? []; const outbound = this.tracks.get('outbound') ?? []
    while (inbound.length > 0 && outbound.length > 0) this.ffmpeg.stdin.write(mix(inbound.shift()!, outbound.shift()!))
    if (inbound.length > 0 || outbound.length > 0) {
      const solo = inbound.length > 0 ? inbound : outbound
      if (solo.length > 3) this.ffmpeg.stdin.write(solo.shift()!)
    }
    // Bun's FileSink holds writes until flushed; unflushed, the encoder never saw a byte.
    this.ffmpeg.stdin.flush?.()
  }

  private stopEncoder(): void {
    if (!this.ffmpeg) return
    try { this.ffmpeg.stdin.end() } catch {}
    try { this.ffmpeg.kill() } catch {}
    this.ffmpeg = null; this.tracks.clear(); this.backlog = []; this.backlogBytes = 0
    // The show is over: every listener's stream ends, so a relay sees the end and stops.
    for (const listener of this.listeners) { try { listener.close() } catch {} }
    this.listeners.clear()
  }

  private stop(): void { this.stopEncoder(); this.socket = null }
}
