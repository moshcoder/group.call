/**
 * `groupcall` with no arguments: your rooms as one folding tree, each opening
 * onto who is on the line right now.
 *
 * One click (or Enter) opens a room in place; the row under the pointer lights
 * up. On a room, i asks riotcoder in and c asks cha0spunk (operators only), and
 * p takes a phone number to ring into it (Enter rings, Esc gives up).
 * Everything re-reads every five seconds; r re-reads now, q quits.
 */
import { createApp } from '@profullstack/hqtui'
import { GroupCallClient, type ApiMe, type ApiPerson, type ApiRoom } from './client.js'

export type Row = { kind: 'room'; room: ApiRoom } | { kind: 'person'; room: ApiRoom; person: ApiPerson } | { kind: 'empty'; room: ApiRoom }
export type TuiState = { me: ApiMe | null; open: Set<string>; detail: Map<string, ApiRoom>; selected: number; hovered: number | null; busy: string | null; note: string | null; dialing: string | null }

export const initialState = (): TuiState => ({ me: null, open: new Set(), detail: new Map(), selected: 0, hovered: null, busy: null, note: null, dialing: null })

/** The rows in draw order: each room, then who is on it while it is open. */
export function rows(s: TuiState): Row[] {
  const out: Row[] = []
  for (const room of s.me?.rooms ?? []) {
    out.push({ kind: 'room', room })
    if (!s.open.has(room.code)) continue
    const live = s.detail.get(room.code)?.live ?? []
    if (live.length === 0) out.push({ kind: 'empty', room })
    for (const person of live) out.push({ kind: 'person', room, person })
  }
  return out
}

/** Picks a row: a room folds or unfolds in place, anything else is just selected. */
export function pick(s: TuiState, index: number): void {
  const row = rows(s)[index]
  if (!row) return
  s.selected = index
  if (row.kind === 'room') {
    if (s.open.has(row.room.code)) s.open.delete(row.room.code)
    else s.open.add(row.room.code)
    s.selected = rows(s).findIndex((r) => r.kind === 'room' && r.room.code === row.room.code)
  }
}

/** Pure key handling, testable without a terminal. */
export function onKey(s: TuiState, key: { name: string; key: string; char?: string }): 'quit' | 'refresh' | 'invite-riotcoder' | 'invite-cha0spunk' | 'call-phone' | null {
  // Keying a number: every key is the number's until Enter or Esc, so q and c type nothing else.
  if (s.dialing !== null) {
    if (key.key === 'ctrl+c' || key.name === 'escape') s.dialing = null
    else if (key.name === 'enter') return s.dialing.replace(/\D/g, '') ? 'call-phone' : ((s.dialing = null), null)
    else if (key.name === 'backspace') s.dialing = s.dialing.slice(0, -1)
    else if (key.char && /^[0-9+\-() ]$/.test(key.char) && s.dialing.length < 20) s.dialing += key.char
    return null
  }
  const n = Math.max(1, rows(s).length)
  if (key.key === 'ctrl+c' || key.name === 'escape' || key.char === 'q') return 'quit'
  if (key.name === 'up') s.selected = (s.selected + n - 1) % n
  else if (key.name === 'down') s.selected = (s.selected + 1) % n
  else if (key.name === 'enter' || key.char === ' ') pick(s, s.selected)
  else if (key.char === 'r') return 'refresh'
  else if (key.char === 'i' && rows(s)[s.selected]) return 'invite-riotcoder'
  else if (key.char === 'c' && rows(s)[s.selected]) return 'invite-cha0spunk'
  else if (key.char === 'p' && rows(s)[s.selected] && s.me?.can_call_phones) s.dialing = ''
  return null
}

export async function runTui(client = new GroupCallClient()): Promise<void> {
  const s = initialState()
  const app = await createApp({ title: 'group.call', quitKeys: [] })
  let visible: number[] = []
  const read = async () => {
    s.me = await client.me()
    // Only open rooms are read in full: who is on the line.
    await Promise.all([...s.open].map(async (code) => s.detail.set(code, await client.room(code))))
  }
  const act = async (label: string, job: () => Promise<string | void>) => {
    s.busy = label
    s.note = null
    app.invalidate()
    try {
      s.note = (await job()) ?? null
      await read()
    } catch (e) {
      s.note = e instanceof Error ? e.message : String(e)
    } finally {
      s.busy = null
      s.selected = Math.max(0, Math.min(s.selected, rows(s).length - 1))
      app.invalidate()
    }
  }
  const refresh = () => act('Reading…', async () => {})
  const timer = setInterval(() => {
    if (!s.busy) void read().then(() => app.invalidate()).catch(() => {})
  }, 5000)
  app.on('key', (event: any) => {
    const action = onKey(s, event)
    const row = rows(s)[s.selected]
    if (action === 'quit') {
      clearInterval(timer)
      return app.quit()
    }
    if (action === 'refresh' || (event.name === 'enter' && row?.kind === 'room')) void refresh()
    if ((action === 'invite-riotcoder' || action === 'invite-cha0spunk') && row) {
      const agent = action === 'invite-riotcoder' ? 'riotcoder' : 'cha0spunk'
      void act(`Asking ${agent}…`, async () => `${(await client.invite(row.room.code, agent)).agent} is on the way.`)
    }
    if (action === 'call-phone' && row && s.dialing !== null) {
      const phone = s.dialing
      s.dialing = null
      void act(`Ringing ${phone}…`, async () => `Ringing ${(await client.callPhone(row.room.code, phone)).to}. They press 1 to join.`)
    }
    app.invalidate()
  })
  app.on('mouse', (event: any) => {
    if (event?.type === 'move' && s.hovered !== null) {
      s.hovered = null
      app.invalidate()
    }
  })
  app.render(({ ui, theme }: any) => {
    const me = s.me
    ui.row({ size: 1 }, (h: any) => {
      h.text(' group.call', { fg: theme.accent, bold: true, size: 12 })
      h.text(me ? `dial ${me.dial_in}` : 'a party line for people and agents', { fg: theme.muted })
      h.text(`${client.base.replace(/^https?:\/\//, '')} `, { fg: theme.muted, align: 'right' })
    })
    const all = rows(s)
    const nodes = (me?.rooms ?? []).map((room) => {
      const open = s.open.has(room.code)
      const live = s.detail.get(room.code)?.live ?? []
      return {
        label: `${open ? '▾' : '▸'} ${room.code}  ${room.name}`,
        color: room.on_the_line ? theme.accent : undefined,
        expanded: open,
        values: [{ text: room.on_the_line ? `${room.on_the_line} on the line` : '', width: 14, align: 'right' }],
        children: open ? (live.length ? live.map((p) => ({ label: `${p.kind === 'agent' ? '🤖' : '📞'} ${p.name}`, values: [{ text: p.kind, width: 8 }] })) : [{ label: 'nobody on the line' }]) : [],
      }
    })
    visible = []
    ui.panel({ title: s.busy ?? (me ? `Your rooms (${me.rooms.length} of ${me.room_limit})` : 'Your rooms') }, (p: any) => {
      if (me && me.rooms.length === 0) return p.text('No rooms yet: groupcall new "My room"', { fg: theme.muted })
      p.tree({
        nodes,
        selected: s.selected,
        ...(s.hovered !== null ? { hovered: s.hovered } : {}),
        followSelection: true,
        guides: true,
        scrollbar: true,
        onRow: (_node: unknown, index: number) => visible.push(index),
        onSelectRow: (r: number) => {
          if (visible[r] !== undefined) {
            pick(s, visible[r]!)
            void refresh()
          }
          app.invalidate()
        },
        onHoverRow: (r: number | null) => {
          s.hovered = r === null ? null : (visible[r] ?? null)
          app.invalidate()
        },
        onScroll: (d: number) => {
          s.selected = Math.max(0, Math.min(all.length - 1, s.selected + d))
          app.invalidate()
        },
      })
    })
    const row = all[s.selected]
    ui.panel({ title: row ? `${row.room.code}  ${row.room.name}` : 'Details', size: 6 }, (p: any) => {
      if (s.dialing !== null) p.text(`Phone to call in: ${s.dialing}▏  (Enter rings, Esc cancels)`, { fg: theme.accent, bold: true })
      if (s.note) p.text(s.note, { fg: theme.accent })
      if (row) {
        p.text(`Call ${row.room.dial_in} and key ${row.room.code}`, { bold: true })
        p.text(`From a phone: ${row.room.tel}`, { fg: theme.muted })
        p.text(row.room.page, { fg: theme.muted })
      } else if (!me) p.text('Reading your rooms…', { fg: theme.muted })
    })
    const keys = [{ key: '↑↓', label: 'move' }, { key: 'Enter', label: 'open' }, { key: 'r', label: 'refresh' }]
    if (row && me?.can_call_phones) keys.push({ key: 'p', label: 'call a phone in' })
    if (row && me?.can_invite_agents) keys.push({ key: 'i', label: 'invite riotcoder' }, { key: 'c', label: 'invite cha0spunk' })
    keys.push({ key: 'q', label: 'quit' })
    ui.statusBar({ items: keys, right: [{ label: 'sign in with CoinPay' }] })
  })
  void refresh()
  await app.start()
}
