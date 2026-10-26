/**
 * `groupcall mcp`: group.call for an agent, on stdio.
 *
 *   claude mcp add groupcall -e GROUPCALL_KEY=gc_… -- bunx @profullstack/groupcall mcp
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { GroupCallClient } from './client.js'
import { VERSION } from './version.js'

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] })
const wrap = (fn: (a: any) => Promise<unknown>) => async (a: any) => {
  try {
    return text(await fn(a))
  } catch (e) {
    return failure(e)
  }
}
const code = z.string().regex(/^\d{4}$/).describe('A room code, four digits, e.g. 4821')

export function createMcpServer(client = new GroupCallClient()): McpServer {
  const server: any = new McpServer({ name: 'group.call', version: VERSION })
  server.tool('account', 'Your group.call account: the dial-in number, your room pass, your rooms and how many are on each.', {}, wrap(() => client.me()))
  server.tool('list_rooms', 'Your rooms, with how many people or agents are on the line in each.', {}, wrap(() => client.rooms()))
  server.tool(
    'create_room',
    'Make a room. Returns its four-digit code, the number to dial and a tel: link that dials and keys the code. Give people the number and the code.',
    { name: z.string().max(60).describe('What to call the room, e.g. "Monday standup"'), code: z.string().regex(/^\d{4}$/).optional().describe('Pick the code (needs a room pass)') },
    wrap(({ name, code }) => client.create(name, code)),
  )
  server.tool('room', 'One room: who is on the line right now (people and agents) and recent activity.', { code }, wrap(({ code }) => client.room(code)))
  server.tool(
    'transcript',
    "What has been said in a room, line by line with the speaker (people and agents, transcribed live; typed lines marked). Pass after = the last id you saw to get only newer lines.",
    { code, after: z.number().int().optional(), limit: z.number().int().min(1).max(1000).default(200) },
    wrap(({ code, after, limit }) => client.transcript(code, after, limit)),
  )
  server.tool(
    'say',
    'Read a line aloud to everyone on the phone in the room (text to speech). For agents that cannot place a call themselves. Returns said:false when nobody is on the line.',
    { code, text: z.string().min(1).max(500), as: z.string().max(40).optional().describe('Who it is from, read before the line') },
    wrap(({ code, text, as }) => client.say(code, text, as)),
  )
  server.tool(
    'expect_caller',
    'Before your agent phones in, tell the room its name and the number it will call from (E.164). The next call from that number into this room within two minutes is announced under that name. Then dial the room number and send the four digits as DTMF when asked.',
    { code, name: z.string().min(1).max(40), from: z.string().min(8).describe('E.164, e.g. +15551234567') },
    wrap(({ code, name, from }) => client.expect(code, name, from)),
  )
  server.tool(
    'call_phone',
    'Ring a phone into a room, so a person does not have to dial in. The call comes from the room number; whoever answers presses 1 and is in. US/Canada numbers; needs a room pass or operator account.',
    { code, phone: z.string().min(10).describe('e.g. 408-555-0101 or +14085550101'), name: z.string().max(40).optional().describe('Their name, so the room announces them') },
    wrap(({ code, phone, name }) => client.callPhone(code, phone, name)),
  )
  server.tool('invite_agent', "Ask one of the instance's own agents (riotcoder or cha0spunk) to dial in to a room. Operators only.", { code, agent: z.enum(['riotcoder', 'cha0spunk']) }, wrap(({ code, agent }) => client.invite(code, agent)))
  server.tool('rename_room', 'Rename a room.', { code, name: z.string().min(1).max(60) }, wrap(({ code, name }) => client.rename(code, name)))
  server.tool('delete_room', 'Delete a room: everyone on the line is hung up and the code is freed.', { code }, wrap(({ code }) => client.remove(code)))
  return server
}

export async function runMcp(client = new GroupCallClient()): Promise<void> {
  await createMcpServer(client).connect(new StdioServerTransport())
}
