import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const testHome = mkdtempSync(join(tmpdir(), 'groupcall-agent-phone-'));
process.env.AGENT_PHONE_HOME = testHome;
const source = readFileSync(new URL('../ops/agent-phone.mjs', import.meta.url), 'utf8');
const worker = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
after(() => {
  delete process.env.AGENT_PHONE_HOME;
  rmSync(testHome, { recursive: true, force: true });
});

const minute = 60_000;
const now = Date.now();

test('configured Polly voice bypasses exhausted ElevenLabs and omits ElevenLabs credentials', () => {
  assert.equal(worker.voiceFor('riotcoder', 'AWS.Polly.Matthew-Neural'), worker.FALLBACK_VOICE);
  assert.deepEqual(worker.speechRequest('Hello.', worker.FALLBACK_VOICE), {
    payload: 'Hello.',
    voice: 'AWS.Polly.Matthew-Neural',
  });
});

test('ElevenLabs requests keep their API key reference', () => {
  assert.deepEqual(worker.speechRequest('Hello.', 'ElevenLabs.Default.voice-id'), {
    payload: 'Hello.',
    voice: 'ElevenLabs.Default.voice-id',
    voice_settings: { api_key_ref: 'qrypt_elevenlabs' },
  });
});

test('a new call identifies its actual agent even when room history has a different agent', () => {
  const history = [{ who: 'cha0spunk', text: 'old line', at: new Date(now - 15 * minute).toISOString(), history: true }];
  assert.equal(worker.shouldIntroduce('riotcoder', history, now), true);
  assert.equal(worker.agentIntro('riotcoder'), "Hi, I’m RiotCoder, Anthony’s AI agent. I’m here and listening.");
  assert.notEqual(worker.agentIntro('riotcoder'), worker.agentIntro('cha0spunk'));
});

test('Nora gets her own spoken identity and answer routing', () => {
  assert.equal(worker.agentIntro('nora'), "Hi, I’m Nora, Anthony’s AI agent. I’m here and listening.");
  assert.equal(worker.addressed('nora', 'Nora, can you hear me'), true);
  assert.equal(worker.addressed('riotcoder', 'Nora, can you hear me'), false);
});

test('a recent line from the same agent suppresses a duplicate intro on a fast redial', () => {
  const recent = [{ who: 'riotcoder', text: 'Hi, I’m RiotCoder.', at: new Date(now - 30_000).toISOString() }];
  assert.equal(worker.shouldIntroduce('riotcoder', recent, now), false);
});

test('room questions work when transcription omitted punctuation', () => {
  assert.equal(worker.roomQuestion('Anthony: Who’s here'), true);
  assert.equal(worker.roomQuestion('Anthony: Can you guys hear me'), true);
  assert.equal(worker.roomQuestion('Anthony: I told everyone to listen'), false);
});

test('the name the listener hears addresses only that agent', () => {
  assert.equal(worker.addressed('riotcoder', 'RiotCoder, are you there?'), true);
  assert.equal(worker.addressed('cha0spunk', 'RiotCoder, are you there?'), false);
  assert.equal(worker.addressed('cha0spunk', 'Chaos Punk, can you hear me?'), true);
  assert.equal(worker.addressed('riotcoder', 'Chaos Punk, can you hear me?'), false);
});

test('all room agents can recognize their spoken names and avoid answering for another agent', () => {
  for (const [agent, heard] of [
    ['riotcoder', 'Riot Coder'],
    ['cha0spunk', 'Chaos Punk'],
    ['rootkey', 'Root Key'],
    ['coinpay', 'Coin Pay'],
    ['knox', 'Knocks'],
    ['nora', 'Nora'],
  ]) {
    assert.equal(worker.addressed(agent, `${heard}, answer this please`), true, `${agent} should recognize ${heard}`);
    for (const [other] of [
      ['riotcoder'], ['cha0spunk'], ['rootkey'], ['coinpay'], ['knox'], ['nora'],
    ]) {
      if (other !== agent) assert.equal(worker.addressed(other, `${heard}, answer this please`), false, `${other} should not answer for ${agent}`);
    }
  }
});
