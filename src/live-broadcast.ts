/** Receive-only Telnyx media fork -> Nixamp live ingest. */
type BroadcastOptions = { streamUrl: string; nixampUrl: string; nixampToken?: string; nixampKey?: string; name?: string }
type Socket = { send: (data: string) => void; close: () => void }
type Ffmpeg = { stdin: { write: (data: Uint8Array) => void; end: () => void }; stdout: AsyncIterable<Uint8Array>; kill: () => void }
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
  private upload: Promise<Response> | null = null
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
          const clientState = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as { podcast?: unknown }
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

  private async startEncoder(): Promise<void> {
    this.stopEncoder()
    const child = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '8000', '-ac', '1', '-i', 'pipe:0', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' }) as unknown as Ffmpeg
    this.ffmpeg = child; this.tracks.clear()
    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try { for await (const chunk of child.stdout) controller.enqueue(chunk); controller.close() }
        catch (error) { controller.error(error) }
      },
    })
    const url = new URL('/api/ingest', this.options.nixampUrl)
    url.searchParams.set('format', 'mp3'); url.searchParams.set('name', this.name)
    const headers = new Headers({ 'content-type': 'audio/mpeg' })
    if (this.options.nixampKey) headers.set('x-nixamp-key', this.options.nixampKey)
    else if (this.options.nixampToken) headers.set('authorization', `Bearer ${this.options.nixampToken}`)
    this.upload = fetch(url, { method: 'POST', headers, body, duplex: 'half' } as RequestInit).catch((error) => {
      console.error(`group.call: Nixamp broadcast failed: ${(error as Error).message}`); return new Response(null, { status: 502 })
    })
    void this.upload.then((response) => { if (!response.ok) console.error(`group.call: Nixamp ingest returned ${response.status}`) })
  }

  private drain(): void {
    if (!this.ffmpeg) return
    const inbound = this.tracks.get('inbound') ?? []; const outbound = this.tracks.get('outbound') ?? []
    while (inbound.length > 0 && outbound.length > 0) this.ffmpeg.stdin.write(mix(inbound.shift()!, outbound.shift()!))
    if (inbound.length === 0 && outbound.length === 0) return
    const solo = inbound.length > 0 ? inbound : outbound
    if (solo.length > 3) this.ffmpeg.stdin.write(solo.shift()!)
  }

  private stopEncoder(): void {
    if (!this.ffmpeg) return
    try { this.ffmpeg.stdin.end() } catch {}
    try { this.ffmpeg.kill() } catch {}
    this.ffmpeg = null; this.tracks.clear()
  }

  private stop(): void { this.stopEncoder(); this.socket = null; this.upload = null }
}
