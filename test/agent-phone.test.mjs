import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('a person talking while a host speaks is heard, not credited to the host', () => {
  const floor = 'What was the first challenge you faced when deploying your AI coding agents';
  // The co-host's own voice coming back through the conference.
  assert.equal(worker.echoesFloor('What was the first challenge you faced when deploying', floor), true);
  // A person talking over it. This is the one that matters: crediting these to
  // the co-host threw the guest's answers away on a live episode.
  assert.equal(worker.echoesFloor('Can you hear me?', floor), false);
  assert.equal(worker.echoesFloor("Yeah, let us focus this on the interview. Hello?", floor), false);
  assert.equal(worker.echoesFloor('I am my own customer, but I pay myself using my balance', floor), false);
  // Nothing claimed on the floor means nothing to echo.
  assert.equal(worker.echoesFloor('anything at all', ''), false);
});

test('a co-host is still recognised while the other host holds an empty reservation', () => {
  // Episode 8: an interview turn reserves the floor BEFORE it has any words
  // (takeFloor(pin, agent, '', 45_000)). Attribution used to read the holder's
  // text, which was that empty string, so everything the other host said fell
  // through as the guest - and a host then answered its own co-host's question
  // as though Anthony had asked it.
  const pin = `floor-reserve-${process.pid}`;
  const asked = 'How many bare metal servers are you currently running for Profullstack?';
  assert.equal(worker.takeFloor(pin, 'riotcoder', asked, 60_000), true);
  worker.releaseFloor(pin, 'riotcoder');
  // cha0spunk now reserves the floor with nothing to say yet.
  assert.equal(worker.takeFloor(pin, 'cha0spunk', '', 45_000), true);
  assert.equal(worker.floorHolder(pin), 'cha0spunk');
  const heardByCohost = worker.coHostSpeech(pin, 'cha0spunk');
  assert.deepEqual(heardByCohost.map((s) => s.agent), ['riotcoder']);
  assert.equal(worker.echoesFloor('How many bare metal servers are you running', heardByCohost[0].text), true);
  // And the guest still gets through, reservation or not.
  assert.equal(worker.echoesFloor('Can you hear me?', heardByCohost[0].text), false);
  worker.releaseFloor(pin, 'cha0spunk');
});

test('words spoken without the floor are still the speaker\'s own, not the guest\'s', () => {
  // speak() used to ignore a refused claim and talk anyway, leaving its words
  // with no claim behind them: the co-host heard its partner as a person.
  const pin = `floor-refused-${process.pid}`;
  assert.equal(worker.takeFloor(pin, 'cha0spunk', 'What did that cost you?', 60_000), true);
  assert.equal(worker.takeFloor(pin, 'riotcoder', 'And who disagreed?'), false);
  worker.noteSaid(pin, 'riotcoder', 'And who disagreed?');
  // The refused claim changes nothing about who holds the floor.
  assert.equal(worker.floorHolder(pin), 'cha0spunk');
  assert.deepEqual(worker.coHostSpeech(pin, 'cha0spunk').map((s) => s.agent), ['riotcoder']);
  assert.deepEqual(worker.coHostSpeech(pin, 'riotcoder').map((s) => s.agent), ['cha0spunk']);
  worker.releaseFloor(pin, 'cha0spunk');
});

test('a co-host line goes stale, so an old question never shadows the guest', () => {
  const pin = `floor-stale-${process.pid}`;
  assert.equal(worker.takeFloor(pin, 'riotcoder', 'Tell me about the fleet.', 60_000), true);
  assert.deepEqual(worker.coHostSpeech(pin, 'cha0spunk').map((s) => s.agent), ['riotcoder']);
  const file = join(testHome, '.local/share/agent-phone/calls', `floor-${pin}.json`);
  const aged = JSON.parse(readFileSync(file, 'utf8'));
  for (const line of aged.said.riotcoder) line.at = Date.now() - 120_000;
  aged.text = '';
  writeFileSync(file, JSON.stringify(aged));
  assert.deepEqual(worker.coHostSpeech(pin, 'cha0spunk'), []);
  worker.releaseFloor(pin, 'riotcoder');
});

test('a chunked line is still the host\'s own while its first half is transcribed', () => {
  // A turn is split so playback starts before the whole line renders, and
  // playNextChunk re-claims the floor with the chunk it is playing. Keeping only
  // the newest claim forgot the first half of the sentence while its
  // transcription was still arriving, so it came back as the guest: on the
  // rehearsal, "And this is a rehearsal, ChaosPunk" was logged as `room:`.
  const pin = `floor-chunks-${process.pid}`;
  assert.equal(worker.takeFloor(pin, 'riotcoder', "I'm RiotCoder, an AI assistant and co-host, and this is a rehearsal, ChaosPunk.", 60_000), true);
  assert.equal(worker.takeFloor(pin, 'riotcoder', "How's the line?", 20_000), true);
  const heard = worker.coHostSpeech(pin, 'cha0spunk');
  assert.deepEqual(heard.map((s) => s.agent), ['riotcoder', 'riotcoder']);
  // Both halves of the turn are recognised as the co-host, not the guest.
  assert.equal(heard.some((s) => worker.echoesFloor('And this is a rehearsal chaos punk.', s.text)), true);
  assert.equal(heard.some((s) => worker.echoesFloor("How's the line", s.text)), true);
  // And the guest still gets through either way.
  assert.equal(heard.some((s) => worker.echoesFloor('Can you hear me?', s.text)), false);
  worker.releaseFloor(pin, 'riotcoder');
});

test('each agent keeps a few recent lines, not the whole call', () => {
  const pin = `floor-cap-${process.pid}`;
  for (const line of ['one thing entirely', 'second separate matter', 'third distinct subject', 'fourth unrelated topic', 'fifth other business']) {
    assert.equal(worker.takeFloor(pin, 'riotcoder', line, 30_000), true);
  }
  const heard = worker.coHostSpeech(pin, 'cha0spunk');
  assert.equal(heard.length, 4);
  assert.equal(heard[0].text, 'fifth other business');
  assert.equal(heard.some((s) => s.text === 'one thing entirely'), false);
  worker.releaseFloor(pin, 'riotcoder');
});

test('a host saying its own name is not the guest, however the transcriber spells it', () => {
  // The rehearsal: riotcoder said "I'm RiotCoder, Anthony's AI assistant and
  // co-host" and the transcriber wrote "I'm Riot Coder." Two tokens never
  // matched the one word the host said, so the overlap fell to 1/3 and the host
  // introducing itself was logged as `room:` - the guest.
  const floor = "I'm RiotCoder, Anthony's AI assistant and co-host,";
  assert.equal(worker.echoesFloor("I'm Riot Coder.", floor), true);
  assert.equal(worker.echoesFloor('Hello. I am Chaos Punk, an AI assistant and co host.', "Hello, I'm ChaosPunk, an AI assistant and co-host."), true);
  // 0 read as o, both ways.
  assert.equal(worker.echoesFloor('chaospunk here', 'cha0spunk here'), true);
  // The guest still gets through, and a generic word is not a name.
  assert.equal(worker.echoesFloor('Can you hear me?', floor), false);
  assert.equal(worker.echoesFloor('We run our own security and nothing else', 'rootkey handles the scanning for us'), false);
});

test('a host that has gone quiet is still introduced, so it keeps coordinating', () => {
  // shouldIntroduce() is about the PROMPT: say hello if you have not spoken for
  // three minutes. It used to gate co-host coordination too, and the hosts wait
  // in an empty room while the guest is rung - always longer than three minutes.
  // So on the guest's first words both hosts counted as introducing themselves,
  // skipped the stagger and the reservation, and talked over each other. Episode
  // 9 ended twenty seconds after Anthony said hello.
  const transcript = [
    { who: 'riotcoder', text: 'Welcome to Off The Record.', at: new Date(now - 4 * minute).toISOString() },
    { who: 'them', text: 'Hello? This is Anthony.', at: new Date(now).toISOString() },
  ];
  // Four minutes quiet: the prompt should still ask for a hello...
  assert.equal(worker.shouldIntroduce('riotcoder', transcript, now), true);
  // ...but having spoken on this call is a different fact, and the one the
  // coordination guards now use.
  assert.equal(transcript.some((l) => l.who === 'riotcoder' && !l.history), true);
  assert.equal(transcript.some((l) => l.who === 'cha0spunk' && !l.history), false);
});

test('a joined leg can work out where the room status lives', () => {
  // Without this a leg is blind twice over: followRoom never runs, so it guesses
  // its co-host's voice from audio instead of reading the room's own labelled
  // transcript, and roomWatch falls back to "twenty quiet minutes" - which is why
  // episodes 8 and 9 each left two legs dialled into an empty room after the
  // guest hung up.
  assert.equal(worker.statusUrlFor('https://group.call.pit.world', '8625'), 'https://group.call.pit.world/api/v1/agent-queue/rooms/8625');
  // A trailing slash on the configured base is not a double slash in the path.
  assert.equal(worker.statusUrlFor('https://group.call.pit.world/', '8625'), 'https://group.call.pit.world/api/v1/agent-queue/rooms/8625');
});

test('a model that says PASS is saying nothing, not reading the word out', () => {
  assert.deepEqual(worker.parseTurn('SAY: PASS'), { kind: 'pass', text: '' });
  assert.deepEqual(worker.parseTurn('PASS'), { kind: 'pass', text: '' });
  assert.deepEqual(worker.parseTurn('SAY: Where did this start?'), { kind: 'say', text: 'Where did this start?' });
});

test('a spoken line never reads an address out', () => {
  // A host read "fleetsysops.com" out loud on air.
  assert.equal(worker.sayable('the manifesto on fleetsysops.com influences CoinPay'), 'the manifesto on fleetsysops influences CoinPay');
  assert.equal(worker.sayable('see https://offtherecord.podcast.pit.world/e/7 for notes'), 'see offtherecord for notes');
  assert.equal(worker.sayable('go to www.ugig.net today'), 'go to ugig today');
  // Ordinary speech is untouched, and so is a sentence that merely has a full stop.
  assert.equal(worker.sayable('What broke, and what did it cost?'), 'What broke, and what did it cost?');
  assert.equal(worker.sayable('It worked. Then it did not.'), 'It worked. Then it did not.');
});

test('a long opening sentence is broken at a clause so the first word comes sooner', () => {
  const opener = 'Anthony, welcome to Off The Record, I am RiotCoder, and I am here with ChaosPunk, we are your own AI agents hosting this show, does that work for you?';
  const chunks = worker.speechChunks(opener);
  assert.ok(chunks.length >= 2, 'expected the opener to be split');
  assert.ok(chunks[0].length <= 90, `first chunk should be short, got ${chunks[0].length}`);
  // Broken at a clause boundary, not mid-word, and nothing is lost.
  assert.ok(chunks[0].endsWith(','), `expected a clause boundary, got ${JSON.stringify(chunks[0])}`);
  assert.equal(chunks.join(' '), opener);
  // A short line is still said in one go.
  assert.deepEqual(worker.speechChunks('What broke?'), ['What broke?']);
});
