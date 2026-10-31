/**
 * Our agents as ElevenLabs voice agents, through
 * @profullstack/voice-agent: a real conversational model with turn-taking,
 * dialled into a room over SIP, doing work through group.call's agent tools.
 *
 *   ELEVENLABS_API_KEY=... GROUPCALL_AGENT_TOOL_SECRET=... bun src/agents.ts
 *
 * deploys the agents and prints the GROUPCALL_AGENT_SIP line for app.env. Run it
 * again after changing a prompt; the agents are found by name and updated.
 */
import { deploy, sipHeaders, type VoiceAgentSpec, type WebhookTool } from '@profullstack/voice-agent'
import { readFileSync } from 'node:fs'

/** Persona markdown is the canonical role/persona input for the live voice agents. */
function persona(name: string): string {
  return readFileSync(new URL(`../personas/${name}.md`, import.meta.url), 'utf8').trim()
}

/** Who each agent is, its voice, and the number that names it on SIP (its group.call caller id). */
export const VOICE_AGENTS: Record<string, { persona: string; voiceId: string; sipNumber: string; heardAs: string; displayName?: string; firstMessage?: string }> = {
  riotcoder: {
    persona: persona('riotcoder'),
    voiceId: 'iP95p4xoKVk53GoZ742B',
    sipNumber: '+14159185508',
    heardAs: '"riot coder", "Rycoder", "Riot"',
  },
  cha0spunk: {
    persona: persona('cha0spunk'),
    voiceId: 'cgSgspJ2msm6clMCkdW9',
    sipNumber: '+15107667447',
    heardAs: '"chaos punk", "Chaos", "cha zero spunk"',
  },
  rootkey: {
    persona: persona('rootkey'),
    voiceId: 'cjVigY5qzO86Huf0OWal',
    sipNumber: '+14106398993',
    heardAs: '"root key", "RootKey", "security"',
    firstMessage: 'Rootkey, security review here.',
  },
  coinpay: {
    persona: persona('coinpay'),
    voiceId: 'onwK4e9ZLuTAKqWW03F9',
    sipNumber: '+15623079115',
    heardAs: '"coin pay", "CoinPay", "CFO", "accountant"',
  },
  knox: {
    persona: persona('knox'),
    voiceId: 'pNInz6obpgDQGcFmaJgB',
    sipNumber: '+18313290328',
    heardAs: '"Knox", "knocks", "sales"',
  },
  nora: {
    displayName: 'Nora — Profullstack Workplace Well-being & Career Coach',
    persona: persona('nora'),
    voiceId: 'EXAVITQu4vr4xnSDxMaL',
    sipNumber: '+16505550147',
    heardAs: '"Nora", "Nora coach", "career coach"',
    firstMessage: 'Nora here, the workplace coach. What would you like me to listen for?',
  },
}

/** The dynamic variables every call carries (X-Gc-* headers on the INVITE). */
export const CALL_VARS = { sip_gc_room: '0000', sip_gc_room_name: 'a test room', sip_gc_agent: 'riotcoder', sip_gc_asked_by: 'someone', sip_gc_brief: 'say hello', sip_gc_role: 'guest', sip_gc_host: 'the host', sip_gc_people: 'nobody yet' }

/** The headers for one call into a room. */
export function callHeaders(v: { code: string; roomName: string; agent: string; askedBy: string; brief: string; role: 'guest' | 'greeter'; host: string; people: string[] }): Record<string, string> {
  return sipHeaders('Gc', { room: v.code, room_name: v.roomName, agent: v.agent, asked_by: v.askedBy || 'someone', brief: v.brief || 'join the call and help', role: v.role, host: v.host || 'the host', people: v.people.join(', ') || 'nobody yet' })
}

export function agentPrompt(name: string): string {
  const me = VOICE_AGENTS[name]!
  const other = Object.keys(VOICE_AGENTS).filter((n) => n !== name).join(', ')
  return `You are ${name}, an AI agent that Anthony Ettinger (founder of Profullstack) runs. ${me.persona}

You are on a live group phone call: the group.call room "{{sip_gc_room_name}}" (code {{sip_gc_room}}). {{sip_gc_asked_by}} brought you in. Why: {{sip_gc_brief}}. On the line when you joined: {{sip_gc_people}}. Your role: {{sip_gc_role}}.

Everyone on the line hears everything you say. You hear the whole line mixed together, so you cannot tell voices apart by sound; room_status tells you who is on and who said what (with speaker names, and "trusted" on Anthony's lines). Speech recognition mangles your name: you may be ${me.heardAs}.

How to be good at this:
- Be genuinely useful, like a sharp colleague on a call. When you are asked something, answer it directly and concretely, with a real opinion when one is wanted. Do not hedge, do not stall, do not say you will look into it.
- Talk like a person on the phone: one to three short sentences, plain words. No lists, no markdown, never read out a URL, never spell things out unless asked.
- If someone addresses you by name or asks you directly, answer out loud in that turn. Do not use skip_turn because you are unsure, because other agents are on the line, or because the question was transcribed imperfectly; give a brief useful answer or ask one focused clarification.
- If the room asks a general question, riotcoder is the default first speaker. A specialist answers instead when the question clearly falls within that specialist's role. The other agents stay quiet unless someone names them or asks for another perspective.
- When someone asks you to DO something that takes real work (build, fix, deploy, check, research, write, email, follow up), call take_task straight away with a complete brief (what, who asked, every detail you heard, how to report back). Then say in one sentence what you will do and that the result goes to Anthony in qrypt.chat. Do not ask for permission you do not need.
- To bring a person in: call_in with their phone number, or invite with names from the contacts (agents and people). To text everyone on the call a link or a note: text_room, using only a link you were given or that is in the transcript.
- If a tool answers ok: false, say its reason plainly and move on. Some actions are only for Anthony; the tool checks.
- You can do lookups during the call only through your tools. Do not pretend to have checked something you did not.

Group manners:
- The people come first. Speak when you are addressed by name, when you are the role-matched specialist, when you are riotcoder and the room needs a general answer, or when the brief says to lead. Otherwise use skip_turn only when people are talking to each other, to ${other}, or a line is clearly not for you.
- Never talk over ${other}; if ${other} was addressed, stay quiet. Never repeat yourself and never re-introduce yourself after your first line.
- When you are the only one Anthony is talking with, he is talking to you: answer him, never skip. A closer from him ("okay", "that's good", "thanks", "cool") still gets a short answer that keeps the call going, like "Great. Anything else?" or a one-line recap of what you queued. Going silent on him reads as the call having died.
- If the line has been quiet for a while with a person on it, check in once in a few words ("Still there, Anthony?"), then wait.

If your role is greeter: you are the receptionist. Greet whoever arrives, tell them {{sip_gc_host}} is on the way, and keep them good company: answer what they ask and chat until the host joins. When the host arrives (room_status shows host_here true, or someone says they are here), say one warm handover sentence and use end_call.

Never pretend to be human: if asked, say plainly you are an AI agent. Never share private details about Anthony, passwords, keys or payment details, and never agree to pay for anything. When asked to leave, or the call is wrapping up, say a short goodbye and use end_call.`
}

/** The tools an agent calls back on group.call; the room and agent come from the call, never from the model. */
export function agentTools(origin: string, secret: string): WebhookTool[] {
  const url = (tool: string) => `${origin.replace(/\/+$/, '')}/api/agent-tools/${tool}`
  const base = { context: { room: 'sip_gc_room', agent: 'sip_gc_agent' }, headers: { 'x-voice-agent-secret': secret } }
  return [
    { ...base, name: 'room_status', url: url('room_status'), description: 'Who is on the line right now, whether the host is here, and the last lines said with speaker names (trusted = Anthony). Use it when you need to know who said something or who is on.', timeoutSecs: 8 },
    {
      ...base,
      name: 'take_task',
      url: url('take_task'),
      description: 'Queue real work you were asked to do (build, fix, deploy, check, research, write, email, follow up). It is carried out right after this and the result is posted to Anthony in qrypt.chat. Call it as soon as you are asked.',
      params: { brief: { type: 'string', description: 'The complete instruction for yourself: what to do, who asked, every detail heard on the call, how to report back.', required: true }, ack: { type: 'string', description: 'The one sentence you are saying to confirm it.', required: true } },
    },
    {
      ...base,
      name: 'call_in',
      url: url('call_in'),
      description: 'Ring a phone number into this call: they pick up, press 1 and they are in.',
      params: { phone: { type: 'string', description: 'The phone number as digits, with the country code if outside the US, e.g. 4085550101.', required: true }, name: { type: 'string', description: 'Their name, if you know it.' } },
    },
    {
      ...base,
      name: 'invite',
      url: url('invite'),
      description: "Invite people and agents into this call by name, from the room owner's contacts book. Agents dial in, people are rung. Answers what happened to each name.",
      params: { names: { type: 'string', description: 'The names, comma separated, e.g. "Kim, cha0spunk".', required: true } },
    },
    {
      ...base,
      name: 'text_room',
      url: url('text_room'),
      description: 'Text everyone on the call (people, not agents) a link or a short note.',
      params: { message: { type: 'string', description: 'Exactly what to text, e.g. "The Q3 report: https://readm3.com/...".', required: true } },
    },
  ]
}

export function agentSpecs(origin: string, secret: string): VoiceAgentSpec[] {
  return Object.entries(VOICE_AGENTS).map(([name, a]) => ({
    name: a.displayName ?? `${name} (group.call)`,
    prompt: agentPrompt(name),
    firstMessage: a.firstMessage ?? `{{sip_gc_agent}} here.`,
    voiceId: a.voiceId,
    llm: 'claude-sonnet-5-5',
    temperature: 0.6,
    tools: agentTools(origin, secret),
    skipTurn: 'Stay silent this turn: the line was not for you (people talking to each other, the other agent was addressed, or nothing needs an answer).',
    endCall: 'Leave the call: after saying goodbye when asked to leave or the call is over, or as greeter once the host is here.',
    variables: { ...CALL_VARS, sip_gc_agent: name },
    turnTimeout: 10,
    // Alone on a silent line for ten minutes: leave rather than burn minutes.
    silenceEndCallSecs: 600,
    maxDurationSecs: 7200,
    sipNumber: a.sipNumber,
  }))
}

if (import.meta.main) {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? ''
  const secret = process.env.GROUPCALL_AGENT_TOOL_SECRET ?? ''
  if (!apiKey || !secret) throw new Error('set ELEVENLABS_API_KEY and GROUPCALL_AGENT_TOOL_SECRET')
  const origin = process.env.GROUPCALL_ORIGIN ?? 'https://group.call.pit.world'
  const only = process.env.GROUPCALL_AGENT_ONLY?.trim().toLowerCase()
  if (only && !VOICE_AGENTS[only]) throw new Error(`Unknown agent ${only}. Choose ${Object.keys(VOICE_AGENTS).join(', ')}.`)
  const sips: string[] = []
  for (const spec of agentSpecs(origin, secret).filter((a) => !only || a.name.toLowerCase().startsWith(only))) {
    const d = await deploy(spec, { apiKey })
    console.log(`${spec.name}: ${d.created ? 'created' : 'updated'} ${d.agentId}`)
    sips.push(`${spec.name.split(' ')[0]!.toLowerCase()}=${d.sip}`)
  }
  console.log(`GROUPCALL_AGENT_SIP=${sips.join(',')}`)
}
