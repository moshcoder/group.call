import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { agentPrompt, agentSpecs, VOICE_AGENTS } from '../src/agents'

const expectedPersonaText: Record<string, string> = {
  riotcoder: "You are RiotCoder, the Profullstack fleet's engineering agent.",
  cha0spunk: "You are cha0spunk, Profullstack's inbound email and support agent.",
  rootkey: 'You are RootKey, the security professional on the Profullstack agent team.',
  coinpay: 'You are CoinPay, the CFO and accountant on the Profullstack agent team.',
  knox: 'You are Knox, VP of Sales on the Profullstack agent team.',
  nora: "You are Nora, Profullstack's workplace well-being and career coach.",
}
const expectedPersonaHeader: Record<string, string> = {
  riotcoder: '# RiotCoder\n',
  cha0spunk: '# cha0spunk\n',
  rootkey: '# RootKey\n',
  coinpay: '# CoinPay\n',
  knox: '# Knox\n',
  nora: '# Nora\n',
}

test('each live voice agent loads its own tracked Markdown persona', () => {
  assert.deepEqual(Object.keys(VOICE_AGENTS).sort(), Object.keys(expectedPersonaText).sort())
  for (const [agent, expected] of Object.entries(expectedPersonaText)) {
    const configured = VOICE_AGENTS[agent]
    const header = expectedPersonaHeader[agent]
    assert.ok(configured, `missing configured voice agent: ${agent}`)
    assert.ok(header, `missing expected persona header: ${agent}`)
    assert.ok(configured.persona.startsWith(header))
    assert.ok(agentPrompt(agent).includes(expected), `${agent} prompt must include its persona file`)
  }
})

test('every agent prompt has explicit direct-answer and group speaker rules', () => {
  for (const agent of Object.keys(VOICE_AGENTS)) {
    const prompt = agentPrompt(agent)
    assert.match(prompt, /If someone addresses you by name or asks you directly, answer out loud in that turn/)
    assert.match(prompt, /Do not use skip_turn because you are unsure/)
    assert.match(prompt, /riotcoder is the default first speaker/)
    assert.match(prompt, /A specialist answers instead when the question clearly falls within that specialist's role/)
  }
})

test('the six agent specs keep distinct voice identities and include the tracked personas', () => {
  const specs = agentSpecs('https://group.call.pit.world', 'test-secret')
  assert.equal(specs.length, 6)
  assert.equal(new Set(specs.map((spec) => spec.voiceId)).size, 6)
  for (const [agent, expected] of Object.entries(expectedPersonaText)) {
    const spec = specs.find((candidate) => candidate.variables?.sip_gc_agent === agent)
    assert.ok(spec, `missing deployed spec for ${agent}`)
    assert.ok(spec.prompt.includes(expected), `${agent} deploy prompt must include its persona`)
  }
})
