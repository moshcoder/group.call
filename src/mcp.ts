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
const fleetAgent = z.enum(['riotcoder', 'cha0spunk', 'rootkey', 'coinpay', 'knox'])
const contactFields = {
  name: z.string().min(1).max(40).optional(),
  kind: z.enum(['person', 'agent']).optional(),
  phone: z.string().optional(),
  sip: z.union([z.literal(''), z.string().regex(/^sips?:/)]).optional(),
  agent: z.union([z.literal(''), fleetAgent]).optional(),
  email: z.string().optional(),
  aliases: z.array(z.string().max(40)).max(8).optional(),
  note: z.string().max(200).optional(),
  trusted: z.boolean().optional(),
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
    'Ring a phone into a room, so a person does not have to dial in. The call comes from the room number; whoever answers presses 1 and is in. It goes out on the cheapest route that carries the number (see quote_call); Any country, within a daily calling budget for the whole instance. Needs a room pass or operator account. Already on the call yourself? Send DTMF * then the number then # on your own leg and the room rings them the same way.',
    { code, phone: z.string().min(10).describe('e.g. 408-555-0101 or +14085550101'), name: z.string().max(40).optional().describe('Their name, so the room announces them') },
    wrap(({ code, phone, name }) => client.callPhone(code, phone, name)),
  )
  server.tool(
    'quote_call',
    'What a minute to a phone number costs before you ring it in: every route that carries it, cheapest first (least-cost routing; the cheapest is used, the next if it fails). An error means no route will carry it.',
    { phone: z.string().min(8).describe('e.g. +14085550101 or +442079460000') },
    wrap(({ phone }) => client.rates(phone)),
  )
  server.tool(
    'invite',
    'Invite people and agents into a room by name, from your contacts book: e.g. names "riotcoder, cha0spunk, Kim". Our agents are queued to dial in, SIP agents are dialled direct, phone contacts are called, and email-only contacts receive the room number and code by email. Says per name what happened (unknown names are not in the book). People on the call can say "invite Kim" too.',
    { code, names: z.union([z.string(), z.array(z.string())]).describe('Names from your contacts') },
    wrap(({ code, names }) => client.inviteNames(code, names)),
  )
  server.tool('list_contacts', 'Your contacts book: people and agents you can invite by name (operators also see our own agents, builtin).', {}, wrap(() => client.contacts()))
  server.tool(
    'add_contact',
    'Add someone to your contacts book with any details you have. A phone or SIP address lets group.call call them; an email-only contact gets room dialing instructions when invited. An agent can also be one of ours (riotcoder|cha0spunk|rootkey|coinpay|knox). Aliases help speech recognition ("chaos punk"); trusted lets a person ask for invites by voice from their phone.',
    { ...contactFields, name: z.string().min(1).max(40) },
    wrap((c) => client.addContact(c)),
  )
  server.tool('get_contact', 'View one contact by exact id or name. Ambiguous names require an id.', { reference: z.string().min(1) }, wrap(({ reference }) => client.contact(reference)))
  server.tool('update_contact', 'Edit a saved contact by id. Only supplied fields change; empty strings or aliases:[] clear optional details. Builtin agents must be added first. Email is contact metadata, not a call destination.', { id: z.string().min(1), ...contactFields }, wrap(async ({ id, ...fields }) => {
    if (!Object.keys(fields).length) throw new Error('provide at least one field to update')
    const c = await client.contact(id, true)
    return client.updateContact(c.id, fields)
  }))
  server.tool('remove_contact', 'Remove a contact by its id (from list_contacts).', { id: z.string() }, wrap(({ id }) => client.removeContact(id)))
  server.tool('invite_agent', "Ask one of the instance's own agents (riotcoder, cha0spunk, rootkey, coinpay or knox) to dial in to a room. Operators only.", { code, agent: fleetAgent }, wrap(({ code, agent }) => client.invite(code, agent)))
  server.tool('create_invite', 'Make a single-use invite link to group.call (each person has a few). Whoever signs in through it and you both get bonus minutes.', { note: z.string().max(80).optional() }, wrap(({ note }) => client.newInvite(note)))
  server.tool('redeem_code', 'Redeem a credit code (extra call minutes, one-off or every month).', { code: z.string().min(6) }, wrap(({ code }) => client.redeem(code)))
  server.tool(
    'set_greeter',
    "Give a room a greeter: one of our agents dials in when someone arrives before the host, keeps them company, and leaves when the host joins. host is a phone number or a name on the line (e.g. a SIP agent's); omit it and the greeter hands over to the next person who joins. agent 'off' removes it. Operators only.",
    { code, agent: z.union([fleetAgent, z.literal('off')]), host: z.string().max(40).optional() },
    wrap(({ code, agent, host }) => client.greeter(code, agent === 'off' ? null : agent, host ?? '')),
  )
  server.tool(
    'text_room',
    'Text everyone on the line in a room: a link to a readm3.com report, a PDF, a note. Goes from the room number to every person on the call (not agents); STOP opts a number out.',
    { code, text: z.string().min(1).max(600) },
    wrap(({ code, text }) => client.text(code, text)),
  )
  server.tool(
    'link_smshub',
    "Optional: send this account's group texts through its smshub.dev account (an smshub_ API key), as one smshub group per room from its own number. relay keeps replies going to the group after the call. Falls back to the room number if smshub cannot send.",
    { key: z.string().regex(/^smshub_/), from: z.string().optional(), relay: z.boolean().optional() },
    wrap(({ key, from, relay }) => client.linkSmshub(key, from, relay ?? false)),
  )
  server.tool('unlink_smshub', 'Stop sending group texts through smshub; they go from the room number again.', {}, wrap(() => client.unlinkSmshub()))
  server.tool('list_webhooks', 'Your webhook endpoints and the event types group.call sends.', {}, wrap(() => client.webhooks()))
  server.tool(
    'create_webhook',
    'Have group.call POST room events (room.joined, room.left, transcript.line, text.sent, phone.called, recording.ready) to a URL, as signed CloudEvents (Standard Webhooks). Returns the signing secret. events: patterns like "room.*"; omit for all.',
    { url: z.string().url(), events: z.array(z.string()).optional(), description: z.string().max(200).optional() },
    wrap(({ url, events, description }) => client.addWebhook(url, events, description ?? '')),
  )
  server.tool('test_webhook', 'Send a webhook.test event to an endpoint now.', { id: z.string() }, wrap(({ id }) => client.testWebhook(id)))
  server.tool('delete_webhook', 'Remove a webhook endpoint.', { id: z.string() }, wrap(({ id }) => client.removeWebhook(id)))
  server.tool('webhook_deliveries', 'Recent webhook deliveries, optionally for one endpoint.', { id: z.string().optional() }, wrap(({ id }) => client.webhookLog(id)))
  server.tool('record_room', 'Record every call in a room to one mp3 (everyone mixed), saved when the call ends; on=false stops.', { code, on: z.boolean().default(true) }, wrap(({ code, on }) => client.record(code, on)))
  server.tool('list_recordings', "A room's recordings, with mp3 links (fetch them with your GROUPCALL_KEY as a bearer).", { code }, wrap(({ code }) => client.recordings(code)))
  server.tool('call_sip_agent', 'Dial a voice agent (e.g. an ElevenLabs agent) into a room over SIP: joins on answer, no press 1. X- headers ride on the INVITE. Operators only.', { code, sip: z.string().regex(/^sips?:/), name: z.string().min(1).max(40), headers: z.record(z.string(), z.string()).optional() }, wrap(({ code, sip, name, headers }) => client.callSip(code, sip, name, headers ?? {})))
  server.tool('rename_room', 'Rename a room.', { code, name: z.string().min(1).max(60) }, wrap(({ code, name }) => client.rename(code, name)))
  server.tool('delete_room', 'Delete a room: everyone on the line is hung up and the code is freed.', { code }, wrap(({ code }) => client.remove(code)))
  return server
}

export async function runMcp(client = new GroupCallClient()): Promise<void> {
  await createMcpServer(client).connect(new StdioServerTransport())
}
