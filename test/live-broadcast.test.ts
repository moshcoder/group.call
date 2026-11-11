import { expect, test } from 'bun:test'
import { LiveBroadcastRelay } from '../src/live-broadcast.ts'

const hasFfmpeg = Bun.spawnSync(['sh', '-c', 'command -v ffmpeg']).exitCode === 0

test('nothing is on the air until Telnyx starts a stream', () => {
  const relay = new LiveBroadcastRelay({ streamUrl: 'wss://x/s', listenUrl: 'https://gc.test/api/v1/broadcast/live.mp3' })
  expect(relay.live).toBe(false)
  expect(relay.listen()).toBeNull()
})

test.skipIf(!hasFfmpeg)('a started show is told once, mixes both tracks into MP3 for every listener, and ends their streams', async () => {
  const told: { url: string; name: string }[] = []
  const relay = new LiveBroadcastRelay({ streamUrl: 'wss://x/s', listenUrl: 'https://gc.test/api/v1/broadcast/live.mp3', onLive: (live) => told.push(live) })
  const state = Buffer.from(JSON.stringify({ room: '8625', podcast: 'Off The Record' })).toString('base64')
  await relay.message(JSON.stringify({ event: 'start', start: { media_format: { encoding: 'PCMU' }, client_state: state } }))
  expect(told).toEqual([{ url: 'https://gc.test/api/v1/broadcast/live.mp3', name: 'Off The Record live' }])
  const stream = relay.listen()!
  expect(stream).not.toBeNull()
  const reader = stream.getReader()
  let bytes = 0
  const read = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      bytes += value.byteLength
    }
  })()
  // Six seconds of a 400 Hz tone on each track, in real time: 20 ms (160 bytes of PCMU) a frame.
  // ffmpeg holds the first ~3 s while it fills its input buffer, as it will on a real call.
  const frame = Buffer.alloc(160)
  for (let i = 0; i < 160; i++) frame[i] = i % 20 < 10 ? 0x10 : 0x90
  for (let n = 0; n < 300; n++) {
    for (const track of ['inbound', 'outbound']) {
      await relay.message(JSON.stringify({ event: 'media', media: { track, payload: frame.toString('base64') } }))
    }
    await Bun.sleep(20)
  }
  expect(bytes).toBeGreaterThan(1000)
  await relay.message(JSON.stringify({ event: 'stop' }))
  await read
  expect(relay.live).toBe(false)
}, 20_000)
