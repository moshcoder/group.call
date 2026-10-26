/**
 * groupcall: group.call from the terminal.
 */
import { GroupCallClient, type ApiRoom } from './client.js'
import { VERSION } from './version.js'

export const HELP = `groupcall ${VERSION}: a party line for people and AI agents (https://group.call.pit.world)

  groupcall                                 interactive (TUI): your rooms and who is on them
  groupcall me                              your account, pass and rooms
  groupcall rooms                           your rooms
  groupcall new [name] [--code 4821]        a new room (picking the code needs a room pass)
  groupcall room <code>                     one room: who is on the line, recent activity
  groupcall who <code>                      who is on the line
  groupcall dial <code>                     how to join: the number, the code, a tel: link
  groupcall transcript <code> [--follow]    what was said, by whom; --follow prints new lines as they come
  groupcall say <code> <text...> [--as me]  read a line aloud into the room
  groupcall expect <code> <name> <from>     name the next caller from that number (your agent)
  groupcall call <code> <phone> [name...]   ring a phone into the room; they press 1 to join (pass or operators)
  groupcall invite <code> <agent>           ask riotcoder or cha0spunk to dial in (operators)
  groupcall redeem <credit-code>            add call minutes from a code someone gave you
  groupcall invite-link [note]              a single-use invite link (you both get bonus minutes)
  groupcall rename <code> <name...>
  groupcall delete <code>                   hangs everyone up and frees the code

  groupcall mcp                             MCP server: claude mcp add groupcall -e GROUPCALL_KEY=gc_… -- bunx @profullstack/groupcall mcp
  groupcall serve [--port N]                run your own instance

  --json                                    machine-readable output
  GROUPCALL_KEY=gc_…                        your key, from https://group.call.pit.world/me
`

type Out = { log(text: string): void; error(text: string): void }

export const roomLine = (r: ApiRoom) => `${r.code}  ${r.name.padEnd(28)} ${r.on_the_line ? `${r.on_the_line} on the line` : r.last_used_at ? `last call ${r.last_used_at.slice(0, 10)}` : 'not used yet'}`
export const dialText = (r: ApiRoom) => `Call ${r.dial_in} and key ${r.code}.\nFrom a phone, tap: ${r.tel}`

/** --name value or --name=value. */
export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0) return argv[i + 1]
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
}

export async function main(argv = process.argv.slice(2), out: Out = console, client = new GroupCallClient()): Promise<number> {
  const json = argv.includes('--json')
  const valued = ['--code', '--port', '--as']
  const args = argv.filter((a, i) => !a.startsWith('--') && !valued.includes(argv[i - 1] ?? ''))
  const [command, ...rest] = args
  const show = (value: unknown, text: string) => out.log(json ? JSON.stringify(value, null, 2) : text)
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new Error(`missing ${what}\n\n${HELP}`)
    return v
  }
  try {
    switch (command) {
      case undefined: {
        if (!process.stdout.isTTY) return out.log(HELP), 0
        const { runTui } = await import('./tui.js')
        await runTui(client)
        return 0
      }
      case 'help':
        return out.log(HELP), 0
      case 'version':
        return out.log(VERSION), 0
      case 'mcp': {
        const { runMcp } = await import('./mcp.js')
        await runMcp(client)
        return 0
      }
      case 'serve': {
        const port = flag(argv, 'port')
        // A variable specifier keeps the server (bun:sqlite) out of the desktop app's Node bundle.
        const serverModule = './server.js'
        const { serve } = (await import(serverModule)) as typeof import('./server.js')
        const server = serve(port ? { port: Number(port) } : {})
        out.log(`group.call listening on http://${server.hostname}:${server.port}`)
        await new Promise(() => {})
        return 0
      }
      case 'me': {
        const me = await client.me()
        show(me, `${me.name || me.email}\npass: ${me.pass_until ? `until ${me.pass_until.slice(0, 10)}` : 'none'}  rooms: ${me.rooms.length} of ${me.room_limit}\ndial in: ${me.dial_in}\n\n${me.rooms.map(roomLine).join('\n') || 'no rooms yet: groupcall new "My room"'}`)
        return 0
      }
      case 'rooms': {
        const { rooms } = await client.rooms()
        show(rooms, rooms.map(roomLine).join('\n') || 'no rooms yet: groupcall new "My room"')
        return 0
      }
      case 'new': {
        const code = flag(argv, 'code')
        const room = await client.create(rest.join(' '), code)
        show(room, `${room.code}  ${room.name}\n\n${dialText(room)}`)
        return 0
      }
      case 'room': {
        const room = await client.room(need(rest[0], 'room code'))
        const people = room.live?.map((p) => `  ${p.kind === 'agent' ? '🤖' : '📞'} ${p.name}`).join('\n') || '  nobody on the line'
        const activity = room.activity?.slice(0, 10).map((a) => `  ${a.at.slice(11, 16)} ${a.who} ${a.kind === 'say' ? `said: ${a.text}` : a.kind === 'join' ? 'joined' : a.kind === 'leave' ? 'left' : (a.text ?? a.kind)}`).join('\n') || '  nothing yet'
        show(room, `${room.code}  ${room.name}\n\n${dialText(room)}\n\nOn the line:\n${people}\n\nActivity:\n${activity}`)
        return 0
      }
      case 'who': {
        const room = await client.room(need(rest[0], 'room code'))
        show(room.live ?? [], (room.live ?? []).map((p) => `${p.kind === 'agent' ? 'agent ' : 'person'}  ${p.name}`).join('\n') || 'nobody on the line')
        return 0
      }
      case 'dial': {
        const room = await client.room(need(rest[0], 'room code'))
        show({ dial_in: room.dial_in, code: room.code, tel: room.tel }, dialText(room))
        return 0
      }
      case 'transcript': {
        const code = need(rest[0], 'room code')
        const show1 = (l: { id: number; who: string; kind: string; text: string; at: string }) => out.log(json ? JSON.stringify(l) : `${l.at.slice(11, 19)} ${l.who}${l.kind === 'typed' ? ' (typed)' : ''}: ${l.text}`)
        let { lines } = await client.transcript(code)
        lines.forEach(show1)
        if (!argv.includes('--follow')) return 0
        let after = lines.at(-1)?.id ?? 0
        for (;;) {
          await new Promise((r) => setTimeout(r, 2000))
          ;({ lines } = await client.transcript(code, after))
          lines.forEach(show1)
          after = lines.at(-1)?.id ?? after
        }
      }
      case 'say': {
        const code = need(rest[0], 'room code')
        const r = await client.say(code, need(rest.slice(1).join(' ') || undefined, 'what to say'), flag(argv, 'as'))
        show(r, r.said ? `said to ${r.callers} on the line` : 'nobody is on the line to hear it')
        return r.said ? 0 : 1
      }
      case 'expect': {
        const r = await client.expect(need(rest[0], 'room code'), need(rest[1], 'name'), need(rest[2], 'the number it will call from'))
        show(r, `the next call from ${rest[2]} into ${r.code} will be announced as ${rest[1]} (dial ${r.dial_in} within 2 minutes)`)
        return 0
      }
      case 'call': {
        const r = await client.callPhone(need(rest[0], 'room code'), need(rest[1], 'phone number'), rest.slice(2).join(' ') || undefined)
        show(r, `ringing ${r.to}: they pick up and press 1 to join`)
        return 0
      }
      case 'invite': {
        const r = await client.invite(need(rest[0], 'room code'), need(rest[1], 'agent (riotcoder or cha0spunk)'))
        show(r, `${r.agent} is ${r.status === 'queued' ? 'on the way' : r.status}`)
        return 0
      }
      case 'invite-link': {
        const r = await client.newInvite(rest.join(' ') || undefined)
        show(r, `${r.link}\n(${r.left} invites left)`)
        return 0
      }
      case 'redeem': {
        const r = await client.redeem(need(rest[0], 'credit code'))
        show(r, `${r.message}${r.minutes_left !== null ? ` ${Math.round(r.minutes_left)} minutes left this month.` : ''}`)
        return 0
      }
      case 'rename': {
        const room = await client.rename(need(rest[0], 'room code'), need(rest.slice(1).join(' ') || undefined, 'name'))
        show(room, roomLine(room))
        return 0
      }
      case 'delete':
      case 'rm': {
        show(await client.remove(need(rest[0], 'room code')), `deleted ${rest[0]}`)
        return 0
      }
      default:
        out.error(`unknown command: ${command}\n\n${HELP}`)
        return 2
    }
  } catch (e) {
    out.error(e instanceof Error ? e.message : String(e))
    return 1
  }
}
