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
  assert.equal(worker.voiceFor('riotcoder', '', true), 'AWS.Polly.Matthew-Neural');
  assert.equal(worker.voiceFor('cha0spunk', '', true), 'AWS.Polly.Joanna-Neural');
  assert.equal(worker.voiceFor('rootkey', '', true), 'AWS.Polly.Stephen-Neural');
  assert.equal(worker.voiceFor('coinpay', '', true), 'AWS.Polly.Danielle-Neural');
  assert.equal(worker.voiceFor('knox', '', true), 'AWS.Polly.Joey-Neural');
  assert.equal(worker.voiceFor('nora', '', true), 'AWS.Polly.Ruth-Neural');
  assert.equal(new Set(Object.values(worker.POLLY_VOICES)).size, 6);
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

test('agent join identity uses one DTMF token and rejects malformed tokens', () => {
  assert.equal(worker.identityDtmf('00428193'), '*00428193#');
  assert.throws(() => worker.identityDtmf('428193'), /eight digits/);
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
  assert.equal(worker.roomQuestion('Anthony: What was that?'), true);
  assert.equal(worker.roomQuestion('Anthony: What was that'), true);
  assert.equal(worker.roomQuestion('Anthony: How does this work?'), true);
  assert.equal(worker.roomQuestion('Anthony: I told everyone to listen'), false);
  assert.equal(worker.roomQuestionFallback('Anthony: What was that?'), "Sorry, I missed what you meant. Could you repeat the part you want me to explain?");
  assert.equal(worker.weakRoomAnswer('Anthony: What was that?', "I'm here and listening."), true);
  assert.equal(worker.weakRoomAnswer('Anthony: Can you hear me?', "I'm here and listening."), false);
  assert.equal(worker.shouldFallbackRoomResponse('riotcoder', 'Anthony: Is anyone here?', ''), true);
  assert.equal(worker.shouldFallbackRoomResponse('nora', 'Anthony: Nora, can you hear me?', ''), true);
  assert.equal(worker.shouldFallbackRoomResponse('riotcoder', 'Anthony: Nora, can you hear me?', ''), false);
  assert.equal(worker.shouldFallbackRoomResponse('riotcoder', 'Anthony: Can you hear me?', "I'm here and listening."), false);
  assert.equal(worker.shouldConsiderRoomTurn('riotcoder', 'Anthony: I said no.'), false);
  assert.equal(worker.shouldConsiderRoomTurn('riotcoder', 'Anthony: What was that?'), true);
  assert.equal(worker.shouldConsiderRoomTurn('nora', 'Anthony: Nora, are you there?'), true);
  assert.equal(worker.shouldConsiderRoomTurn('riotcoder', 'Anthony: Nora, are you there?'), false);
});

test('only one agent can claim the room floor until it releases it', () => {
  const pin = `floor-test-${process.pid}`;
  assert.equal(worker.takeFloor(pin, 'riotcoder', 'I will answer.', 60_000), true);
  assert.equal(worker.floorHolder(pin), 'riotcoder');
  assert.equal(worker.takeFloor(pin, 'nora', 'I will also answer.'), false);
  worker.releaseFloor(pin, 'riotcoder');
  assert.equal(worker.takeFloor(pin, 'nora', 'I will answer now.'), true);
  assert.equal(worker.floorHolder(pin), 'nora');
  worker.releaseFloor(pin, 'nora');
  assert.equal(worker.floorHolder(pin), '');
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

// ---- our own voices, rendered on c0mpute ---------------------------------------------

test("each agent's Kokoro voice is the one its OpenProfile names", () => {
  assert.equal(worker.kokoroVoiceFor('riotcoder'), 'am_michael');
  assert.equal(worker.kokoroVoiceFor('cha0spunk'), 'af_bella');
  // An agent with no profile voice still gets one rather than nothing.
  assert.equal(worker.kokoroVoiceFor('nobody'), 'am_michael');
});

test('the voice engine decides where the audio is made, and never falls back to ElevenLabs', () => {
  // Our own network: the prefix tells speak() to render a file and play it.
  assert.equal(worker.voiceFor('riotcoder', '', false, 'c0mpute'), 'c0mpute:am_michael');
  assert.equal(worker.voiceFor('cha0spunk', '', false, 'c0mpute'), 'c0mpute:af_bella');
  // The same model, rendered by Telnyx, for when our gateway is out of reach.
  assert.equal(worker.voiceFor('cha0spunk', '', false, 'kokoro'), 'Telnyx.KokoroTTS.af_bella');
  // No engine asked for: unchanged behaviour.
  assert.equal(worker.voiceFor('riotcoder'), `ElevenLabs.Default.iP95p4xoKVk53GoZ742B`);
  // An explicit override still wins over the engine.
  assert.equal(worker.voiceFor('riotcoder', 'AWS.Polly.Matthew-Neural', false, 'c0mpute'), 'AWS.Polly.Matthew-Neural');
});

test('a turn is split so the first clause can start while the rest renders', () => {
  assert.deepEqual(worker.speechChunks('Welcome to Off The Record. Anthony, where did this start?'), [
    'Welcome to Off The Record.',
    'Anthony, where did this start?',
  ]);
  // One sentence stays one chunk; an empty turn is nothing to say.
  assert.deepEqual(worker.speechChunks('Just the one sentence here'), ['Just the one sentence here']);
  assert.deepEqual(worker.speechChunks('   '), []);
  // Never more chunks than the cap, however many sentences arrive.
  const many = worker.speechChunks('One. Two. Three. Four. Five. Six. Seven. Eight.', { limit: 3 });
  assert.ok(many.length <= 3, `expected at most 3 chunks, got ${many.length}`);
  assert.equal(many.join(' '), 'One. Two. Three. Four. Five. Six. Seven. Eight.');
  // Whole clauses only: Kokoro's prosody needs them, and no chunk is empty.
  for (const chunk of many) assert.ok(chunk.trim().length > 0);
});

test('rendering on c0mpute asks the show for the line and answers with a URL to play', async () => {
  const asked = [];
  const fetcher = async (url, init) => {
    asked.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ url: 'https://otr.test/speech/abc.wav', seconds: 3.6, synthMs: 1672, voice: 'am_michael' }));
  };
  const line = await worker.renderOnC0mpute('Where did this start?', {
    agent: 'riotcoder',
    base: 'https://otr.test/',
    key: 'admin_key',
    id: 'sess-1',
    fetcher,
  });
  assert.equal(line.url, 'https://otr.test/speech/abc.wav');
  assert.equal(line.seconds, 3.6);
  assert.equal(asked[0].url, 'https://otr.test/api/v1/speech/say');
  assert.equal(asked[0].headers.authorization, 'Bearer admin_key');
  assert.deepEqual(asked[0].body, { agent: 'riotcoder', text: 'Where did this start?', id: 'sess-1' });
});

test('a line our network cannot render is null, so the call falls back instead of hanging', async () => {
  const no = async () => new Response('nope', { status: 503 });
  assert.equal(await worker.renderOnC0mpute('hello', { agent: 'riotcoder', base: 'https://otr.test', key: 'k', id: '1', fetcher: no }), null);
  // An answer that is not a playable URL is no good either.
  const junk = async () => new Response(JSON.stringify({ url: 'not-a-url' }));
  assert.equal(await worker.renderOnC0mpute('hello', { agent: 'riotcoder', base: 'https://otr.test', key: 'k', id: '1', fetcher: junk }), null);
  // Nothing configured, or nothing to say: no request at all.
  let called = false;
  const spy = async () => ((called = true), new Response('{}'));
  assert.equal(await worker.renderOnC0mpute('hello', { agent: 'riotcoder', base: '', key: '', id: '1', fetcher: spy }), null);
  assert.equal(await worker.renderOnC0mpute('  ', { agent: 'riotcoder', base: 'https://otr.test', key: 'k', id: '1', fetcher: spy }), null);
  assert.equal(called, false);
});
