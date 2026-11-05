#!/usr/bin/env node
/**
 * agent-phone: an AI agent (riotcoder, cha0spunk) phones someone for Anthony.
 *
 *   agent-phone call <number> --goal "what to achieve" [--agent riotcoder] [--max-minutes 10] [--json]
 *   agent-phone join <number> --pin 4821 [--room "Standup"] [--goal "..."] [--agent riotcoder] [--max-minutes 30] [--json]
 *   agent-phone groupcall-worker [--for 55]
 *
 * `join` dials a group call line (group.call.pit.world, @profullstack/group-call),
 * keys the room code with DTMF once the line asks for it, and then takes part in
 * the room with ~/.config/qc-agents/group-turn.md: mostly listening, speaking
 * when addressed. It leaves when asked, after 5 quiet minutes, or at the limit.
 * `groupcall-worker` claims invites from group.call (GROUPCALL_AGENT_WORKER_KEY in
 * ~/.config/groupcall/worker.env) and runs `join` for each, reporting back.
 *
 * Telnyx Call Control places the call, transcribes the room, and speaks through
 * Telnyx TTS. Each agent has a distinct AWS Polly fallback voice, so they remain
 * recognizable while the ElevenLabs workspace is out of quota. This
 * box cannot take webhooks, so Telnyx posts them to
 * qrypt.chat (/api/phone/agent-webhook) and we long-poll them back
* (/api/phone/agent-events, AGENT_PHONE_SECRET). Each turn is a quick read-only
* model run with ~/.config/qc-agents/phone-turn.md. Prints the transcript and
 * how the call ended; the agent reports it in the chat.
 *
 * Only for calls Anthony asked for: the agent says it is an AI in its first line.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';

const HOME = process.env.HOME || '';
if (!HOME) throw new Error('HOME must identify the running agent account');
const read = (p) => readFileSync(p, 'utf8');
const envVal = (file, name) => {
	try {
		return (read(file).match(new RegExp(`^${name}="?([^"\\n]+)"?$`, 'm')) || [])[1] || process.env[name] || '';
	} catch {
		return process.env[name] || '';
	}
};
const PHONE_ENV = HOME === '/home/anthony' ? `${HOME}/www/qrypt.chat/app.env` : `${HOME}/.config/agent-phone/phone.env`;
const TELNYX_KEY = envVal(PHONE_ENV, 'TELNYX_API_KEY');
const AGENT_APP = envVal(PHONE_ENV, 'TELNYX_AGENT_APP_ID');
const SECRET = envVal(PHONE_ENV, 'AGENT_PHONE_SECRET');
const CALLER_ID = envVal(PHONE_ENV, 'PHONE_CALLER_ID');
const EVENTS = 'https://qrypt.chat/api/phone/agent-events';
const VOICES = { riotcoder: 'iP95p4xoKVk53GoZ742B', cha0spunk: 'cgSgspJ2msm6clMCkdW9' }; // ElevenLabs Chris, Jessica
/**
 * The Kokoro voice each agent's OpenProfile names (c0mpute's speech_profiles.rs).
 * These are our own weights: rendered on the c0mpute network when we can reach a
 * gateway, and by Telnyx's copy of the same model when we cannot. Voice
 * presentation is an explicit synthetic choice, not a claim about the agent.
 */
export const KOKORO_VOICES = {
	riotcoder: 'am_michael',
	cha0spunk: 'af_bella',
	knox: 'af_sarah',
	rootkey: 'am_onyx',
	coinpay: 'am_echo',
	nora: 'af_nicole',
	quill: 'am_michael',
};
export function kokoroVoiceFor(agent) { return KOKORO_VOICES[agent] || 'am_michael'; }
export const FALLBACK_VOICE = 'AWS.Polly.Matthew-Neural';
export const POLLY_VOICES = {
	riotcoder: 'AWS.Polly.Matthew-Neural',
	cha0spunk: 'AWS.Polly.Joanna-Neural',
	rootkey: 'AWS.Polly.Stephen-Neural',
	coinpay: 'AWS.Polly.Danielle-Neural',
	knox: 'AWS.Polly.Joey-Neural',
	nora: 'AWS.Polly.Ruth-Neural',
	quill: 'AWS.Polly.Matthew-Neural',
};
export function fallbackVoiceFor(agent) { return POLLY_VOICES[agent] || FALLBACK_VOICE; }
/**
 * The voice a leg speaks in.
 *
 * `engine` picks where the audio is made: 'c0mpute' renders it on our own
 * network in the agent's profile voice (the `c0mpute:` prefix tells `speak` to
 * render and play a file rather than ask Telnyx to read text); 'kokoro' is the
 * same model rendered by Telnyx; otherwise the old behaviour, ElevenLabs with a
 * Polly fallback.
 */
export function voiceFor(agent, override = '', skipElevenLabs = false, engine = '') {
	if (override) return override;
	if (engine === 'c0mpute') return `c0mpute:${kokoroVoiceFor(agent)}`;
	if (engine === 'kokoro') return `Telnyx.KokoroTTS.${kokoroVoiceFor(agent)}`;
	if (!skipElevenLabs && VOICES[agent]) return `ElevenLabs.Default.${VOICES[agent]}`;
	return fallbackVoiceFor(agent);
}

/**
 * Split a spoken turn so the first words can start playing while the rest is
 * still being rendered. Kokoro needs whole clauses for its prosody, so a chunk
 * is never cut mid-sentence and never shorter than `min` unless it is the last
 * one.
 */
/**
 * Two chunks at most: the gap between one chunk and the next is a webhook round
 * trip (about a second, measured), so more chunks buy a faster first word at the
 * cost of a pause in the middle of a sentence. One split, at the end of the
 * first sentence, sounds like someone drawing breath.
 */
export function speechChunks(text, { max = 240, limit = 2 } = {}) {
	const line = String(text).replace(/\s+/g, ' ').trim();
	if (!line) return [];
	const sentences = (line.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [line]).map((s) => s.trim()).filter(Boolean);
	/**
	 * A long opening sentence is the whole wait: the guest hears nothing until it
	 * has rendered. So break it at its last clause boundary instead, which Kokoro
	 * reads as naturally as a full stop and which halves the silence before the
	 * first word.
	 */
	const first = sentences[0] ?? '';
	if (first.length > 90) {
		const comma = first.lastIndexOf(', ', 90);
		if (comma > 25) sentences.splice(0, 1, first.slice(0, comma + 1), first.slice(comma + 2));
	}
	if (sentences.length <= 1) return [line];
	// The first sentence goes alone: it is what the caller waits for, and a short
	// one renders in well under a second.
	const chunks = [sentences[0]];
	for (const sentence of sentences.slice(1)) {
		const last = chunks[chunks.length - 1];
		const full = chunks.length >= limit;
		if (chunks.length > 1 && (full || last.length + sentence.length + 1 <= max)) chunks[chunks.length - 1] = `${last} ${sentence}`;
		else if (full) chunks[chunks.length - 1] = `${last} ${sentence}`;
		else chunks.push(sentence);
	}
	return chunks;
}
export function speechRequest(text, voice) {
	const request = { payload: text, voice };
	if (voice.startsWith('ElevenLabs.')) request.voice_settings = { api_key_ref: 'qrypt_elevenlabs' };
	return request;
}
/**
 * Render one spoken line in an agent's own voice on the c0mpute network, through
 * the show's speech endpoint, and answer with the URL Telnyx should play.
 *
 * Telnyx `speak` renders text on Telnyx's side; this renders it on ours. Null
 * whenever our own network cannot do it, which is never fatal: the caller says
 * the line with the same Kokoro model hosted by Telnyx instead.
 */
export async function renderOnC0mpute(text, { agent, base, key, id, fetcher = fetch, timeoutMs = 45_000 } = {}) {
	const line = String(text ?? '').trim();
	if (!base || !key || !line) return null;
	try {
		const res = await fetcher(`${String(base).replace(/\/+$/, '')}/api/v1/speech/say`, {
			method: 'POST',
			headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
			body: JSON.stringify({ agent, text: line, id }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return null;
		const said = await res.json();
		return said && typeof said.url === 'string' && /^https:\/\//.test(said.url) ? said : null;
	} catch {
		return null;
	}
}

/**
 * A line as it should be heard, not as it is written.
 *
 * A host read "fleetsysops.com" out loud on air. Addresses are for the show
 * notes; spoken, they are just noise with a dot in them.
 */
export function sayable(text) {
	return String(text)
		// A whole address becomes just its name: the first label of the host.
		.replace(/https?:\/\/\S+/gi, (m) => m.replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '').split('.')[0])
		// A bare address, however many labels deep, becomes its first name.
		.replace(/\b(?:www\.)?([a-z0-9][a-z0-9-]*)(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|sh|work|news|world|ai|app|co|me|tech|now|vote|help|info|podcast|agent|hacker)\b/gi, '$1')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

export function identityDtmf(token) {
	if (!/^\d{8}$/.test(String(token))) throw new Error('Agent join token must be eight digits');
	return `*${token}#`;
}
const DISPLAY_NAMES = { riotcoder: 'RiotCoder', cha0spunk: 'ChaosPunk', rootkey: 'RootKey', coinpay: 'CoinPay', knox: 'Knox', nora: 'Nora', quill: 'Quill' };
export function agentIntro(agent) { return `Hi, I’m ${DISPLAY_NAMES[agent] || agent}, Anthony’s AI agent. I’m here and listening.`; }
export function shouldIntroduce(agent, transcript, now = Date.now(), recentMs = 3 * 60_000) {
	const last = [...transcript].reverse().find((line) => line.who === agent);
	const at = last ? Date.parse(last.at) : NaN;
	return !Number.isFinite(at) || now - at > recentMs;
}
export function roomQuestion(text) {
	const body = String(text).replace(/(^|\s)[^:\s]*( ending \d+)?:\s*/g, ' ').trim();
	const isGreeting = /^(hello|hi|hey)[\s,.!]*$/i.test(body);
	return /[?]\s*$/.test(body)
		|| /^(who|what|when|where|why|which|how|can|could|are|is|anyone|anybody|do|does|did|will|would|should|have|has)\b/i.test(body)
		|| /^(?:you(?: all| guys)?|everybody|everyone)\s+(?:hear|listen|understand|there|on the line)\b/i.test(body)
		|| isGreeting;
}
export function roomQuestionFallback(question) {
	const body = roomBody(question);
	if (/^(?:what was that|what did you say|what was that about)\b/i.test(body))
		return "Sorry, I missed what you meant. Could you repeat the part you want me to explain?";
	return "I heard your question, but my answer didn't come through. Could you ask it again?";
}
export function weakRoomAnswer(question, answer) {
	const response = String(answer).trim().replace(/[.!?]+$/, '');
	if (!/^(?:i'?m here(?: and listening| and ready to assist)?|i'?m listening|here and listening)$/i.test(response)) return false;
	return !/\b(?:are you there|can (?:anyone|anybody|you) hear|who(?:'s| is) here|is anyone there)\b/i.test(String(question));
}
const roomBody = (text) => String(text).replace(/(^|\s)[^:\s]*( ending \d+)?:\s*/g, ' ').trim();
const QUIET_MS = 1000; // speak once they have paused this long (1.5 s on a group call: more voices, longer gaps)
const TURN_CWD = `${HOME}/.local/share/agent-phone/turn-cwd`;
mkdirSync(TURN_CWD, { recursive: true });
/**
 * Call logs and the room floor. AGENT_PHONE_HOME redirects them, which is how the
 * tests stay out of a live agent's call directory: they set it, and without this
 * their floor files landed next to real episodes' logs.
 */
const CALL_LOGS = `${process.env.AGENT_PHONE_HOME || HOME}/.local/share/agent-phone/calls`;
mkdirSync(CALL_LOGS, { recursive: true });
/** How speech recognition hears each agent's name, so a mangled name still counts as addressed. */
const NAME_ALIASES = {
	riotcoder: ['riotcoder', 'riot coder', 'riot', 'codex', 'rycoder', 'ryokoder', 'ryecoder', 'rioter', 'riot code', 'ryan coder'],
	cha0spunk: ['cha0spunk', 'chaospunk', 'chaos punk', 'chaos', 'che 0 spunk', 'cheos punk', 'kaos punk', 'chaosbunk', 'k o spunk'],
	rootkey: ['rootkey', 'root key', 'security'],
	coinpay: ['coinpay', 'coin pay', 'cfo', 'accountant'],
	knox: ['knox', 'knocks', 'sales'],
	nora: ['nora', 'nora coach', 'career coach', 'workplace coach'],
	quill: ['quill', 'scribe', 'call scribe'],
};
function lev(a, b) {
	const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
	for (let j = 1; j <= b.length; j++) d[0][j] = j;
	for (let i = 1; i <= a.length; i++)
		for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
	return d[a.length][b.length];
}
/** The spellings to compare against, squashed: no spaces, 0 read as o. */
const SQUASHED = {
	riotcoder: ['riotcoder', 'codex'],
	cha0spunk: ['chaospunk', 'chaozerospunk', 'chaosspunk', 'kaospunk'],
	rootkey: ['rootkey'],
	coinpay: ['coinpay'],
	knox: ['knox'],
	nora: ['nora'],
	quill: ['quill'],
};
/**
 * Whether a transcribed line says this agent's name. Speech recognition mangles
 * made-up names ("Ryah Coder", "Chazyrospunk"), so any run of one to three words
 * that is close to the name (edit distance) counts.
 */
export const addressed = (agent, text) => {
	const words = String(text).toLowerCase().replace(/0/g, 'o').replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(Boolean);
	const t = ` ${words.join(' ')} `;
	if ((NAME_ALIASES[agent] || [agent]).some((n) => t.includes(` ${n.replace(/0/g, 'o')} `))) return true;
	const targets = SQUASHED[agent] || [agent.replace(/0/g, 'o')];
	for (let i = 0; i < words.length; i++)
		for (let n = 1; n <= 3 && i + n <= words.length; n++) {
			const w = words.slice(i, i + n).join('');
			if (w.length < 5) continue;
			for (const target of targets) {
				if (w.includes(target)) return true;
				if (1 - lev(w, target) / Math.max(w.length, target.length) >= 0.62) return true;
			}
		}
	return false;
};
export function shouldFallbackRoomResponse(agent, question, answer) {
	const mine = addressed(agent, question);
	const directedElsewhere = Object.keys(NAME_ALIASES).some((other) => other !== agent && addressed(other, question));
	return !(directedElsewhere && !mine)
		&& (roomQuestion(question) || mine)
		&& (!String(answer || '').trim() || weakRoomAnswer(question, answer));
}
export function shouldConsiderRoomTurn(agent, text, { firstTurn = false, greeter = false, podcast = false } = {}) {
	if (firstTurn || greeter || podcast) return true;
	const mine = addressed(agent, text);
	const someoneElse = Object.keys(NAME_ALIASES).some((other) => other !== agent && addressed(other, text));
	if (someoneElse && !mine) return false;
	const body = roomBody(text);
	return mine || roomQuestion(body) || looksLikeGoodbye(body);
}
/**
 * The floor, shared by our agents on this box: one file per room, touched by whoever
 * speaks. A line meant for nobody in particular gets one agent answering, not two.
 */
const floorFile = (pin) => `${CALL_LOGS}/floor-${pin}.json`;
const floorLockDir = (pin) => `${floorFile(pin)}.lock`;
/** Who holds the floor in this room right now (an agent mid-sentence), or ''. */
export function floorHolder(pin) {
	try {
		const f = JSON.parse(readFileSync(floorFile(pin), 'utf8'));
		return f.until > Date.now() ? String(f.agent) : '';
	} catch {
		return '';
	}
}
const floorTakenByOther = (pin, agent) => {
	const h = floorHolder(pin);
	return h !== '' && h !== agent;
};

/** Run a short floor-file update under an atomic directory lock shared by call workers. */
function withFloorLock(pin, update) {
	const lock = floorLockDir(pin);
	let locked = false;
	try {
		mkdirSync(lock);
		locked = true;
	} catch (e) {
		if (e?.code !== 'EEXIST') return false;
		try {
			if (Date.now() - statSync(lock).mtimeMs > 10_000) {
				rmSync(lock, { recursive: true, force: true });
				mkdirSync(lock);
				locked = true;
			}
		} catch {}
	}
	if (!locked) return false;
	try {
		return update();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

/**
 * Hold the floor for about as long as the line takes to say (roughly 14 chars a
 * second), and record the words with the claim.
 *
 * The file keeps one entry PER AGENT as well as the current holder, because the
 * holder is a single slot and attribution is not. An interview turn reserves the
 * floor before it has any words (`takeFloor(pin, agent, '', 45_000)`), and a leg
 * whose claim is refused speaks anyway; in both cases the holder's text is empty
 * or stale while its co-host is the one actually talking. Credit a heard line to
 * whichever agent's own recent words it echoes, and the single slot stops
 * deciding whose voice this is.
 */
export function takeFloor(pin, agent, text = '', minimumMs = 0) {
	try {
		return withFloorLock(pin, () => {
			if (floorTakenByOther(pin, agent)) return false;
			writeFloor(pin, agent, String(text), Math.max(minimumMs, 2500 + (String(text).length / 14) * 1000));
			return true;
		});
	} catch { return false; }
}
/**
 * Write the claim: the holder slot, plus this agent's own line under `said`.
 *
 * A reservation (no words yet) must not erase the words this agent last spoke —
 * its co-host is still hearing them come back off the line.
 */
function writeFloor(pin, agent, text, forMs) {
	const file = floorFile(pin);
	let prev = {};
	try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch {}
	const now = Date.now();
	const said = mergeSaid(prev, agent, text, now);
	const temp = `${file}.${process.pid}.${now}.tmp`;
	writeFileSync(temp, JSON.stringify({ agent, at: now, until: now + forMs, text: text.slice(0, 600), said }));
	renameSync(temp, file);
}
/** At most this many recent lines per agent: a turn is two chunks, and one may be re-claimed. */
const SAID_PER_AGENT = 4;
/**
 * Add a line to what `agent` has said lately, keeping the ones before it.
 *
 * A turn is split so playback can start before the whole line is rendered, and
 * `playNextChunk` re-claims the floor with the chunk it is playing. Keeping only
 * the latest claim therefore forgot the first half of the sentence while its
 * transcription was still arriving - which came back as the guest. Keep the last
 * few lines per agent and match a heard line against each of them.
 */
function mergeSaid(prev, agent, text, now = Date.now()) {
	const said = {};
	const from = prev?.said && typeof prev.said === 'object' ? prev.said : {};
	for (const [who, entry] of Object.entries(from)) said[who] = normaliseSaid(entry);
	// Carry the old single-slot shape forward, so a leg already on a call is not
	// suddenly a stranger to one that restarts.
	if (prev?.agent && prev?.text && !said[prev.agent]) said[prev.agent] = [{ at: Number(prev.at) || now, text: String(prev.text) }];
	const line = String(text ?? '').trim();
	if (line) {
		const mine = (said[agent] ?? []).filter((e) => e.text !== line.slice(0, 600));
		said[agent] = [{ at: now, text: line.slice(0, 600) }, ...mine].slice(0, SAID_PER_AGENT);
	}
	for (const [who, lines] of Object.entries(said)) {
		const fresh = lines.filter((e) => now - e.at < CO_HOST_MEMORY_MS);
		if (fresh.length) said[who] = fresh;
		else delete said[who];
	}
	return said;
}
/** One agent's lines, newest first, from either the list shape or the single-entry one. */
function normaliseSaid(entry) {
	const list = Array.isArray(entry) ? entry : entry && typeof entry === 'object' ? [entry] : [];
	return list
		.map((e) => ({ at: Number(e?.at) || 0, text: String(e?.text || '') }))
		.filter((e) => e.text.trim())
		.sort((a, b) => b.at - a.at)
		.slice(0, SAID_PER_AGENT);
}
/**
 * Record what this agent is saying without claiming the floor, for the case where
 * the claim was refused or lost a race: the co-host still has to recognise these
 * words as ours rather than hear them as the guest.
 */
export function noteSaid(pin, agent, text) {
	if (!String(text).trim()) return;
	try {
		withFloorLock(pin, () => {
			const file = floorFile(pin);
			let prev = {};
			try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch {}
			const now = Date.now();
			const said = mergeSaid(prev, agent, text, now);
			const temp = `${file}.${process.pid}.${now}.tmp`;
			writeFileSync(temp, JSON.stringify({ ...prev, said }));
			renameSync(temp, file);
			return true;
		});
	} catch {}
}
/** How long a co-host's line stays its own: the time its audio can still be coming back. */
const CO_HOST_MEMORY_MS = 30_000;
/**
 * What each OTHER agent on this room has said lately, newest first — whoever
 * holds the floor. One entry per agent, kept apart on purpose: merging them into
 * one bag of words would make a guest's short answer look like an echo of
 * something.
 */
export function coHostSpeech(pin, agent) {
	try {
		const f = JSON.parse(readFileSync(floorFile(pin), 'utf8'));
		const said = {};
		for (const [who, entry] of Object.entries(f.said && typeof f.said === 'object' ? f.said : {})) said[who] = normaliseSaid(entry);
		// Old single-slot files, and a leg writing one while this one reads.
		if (f.agent && f.text && !said[f.agent]) said[f.agent] = [{ at: Number(f.at) || 0, text: String(f.text) }];
		const now = Date.now();
		return Object.entries(said)
			.filter(([who]) => who !== agent)
			.flatMap(([who, lines]) => lines.filter((e) => now - e.at < CO_HOST_MEMORY_MS).map((e) => ({ agent: who, text: e.text, at: e.at })))
			.sort((a, b) => b.at - a.at);
	} catch {
		return [];
	}
}

/**
 * Is this line the floor holder's own voice coming back, rather than somebody
 * talking over it?
 *
 * Holding the floor used to mean every word a leg heard was credited to its
 * co-host, which threw away the guest whenever he spoke while a host was
 * talking — and two hosts talking in turn means somebody holds the floor nearly
 * all of the time. So compare: words that are in what the co-host is saying are
 * its echo; words that are not are a person, and a person always gets through.
 */
/**
 * Every multi-word spelling of an agent's name, longest first: the transcriber
 * splits our made-up names into two words ("RiotCoder" comes back as "Riot
 * Coder", "ChaosPunk" as "chaos punk"), and two tokens never match the one the
 * host actually said. Only the multi-word aliases are collapsed - single generic
 * ones like "security" or "chaos" would merge words the guest is entitled to use
 * himself.
 */
const SPLIT_NAMES = Object.entries(NAME_ALIASES)
	.flatMap(([agent, names]) => names.filter((n) => n.includes(' ')).map((n) => [n, agent.replace(/0/g, 'o')]))
	.sort((a, b) => b[0].length - a[0].length);
/** One spelling of a name per token, so "Riot Coder" and "RiotCoder" are the same word. */
function oneWordNames(text) {
	let t = String(text).toLowerCase().replace(/0/g, 'o');
	for (const [alias, agent] of SPLIT_NAMES) t = t.split(alias).join(agent);
	return t;
}
export function echoesFloor(heard, floorText) {
	const words = (text) =>
		oneWordNames(text)
			.replace(/[^a-z0-9' ]+/g, ' ')
			.split(/\s+/)
			.filter((w) => w.length > 2);
	const said = words(floorText);
	if (!said.length) return false;
	const mine = words(heard);
	if (!mine.length) return true;
	const bag = new Set(said);
	const hits = mine.filter((w) => bag.has(w)).length;
	// Most of a short line has to match; speech recognition never gets it all.
	return hits / mine.length >= 0.5;
}

/** When the other agent last started speaking (ms), or 0. */
function otherSpokeAt(pin, agent) {
	try {
		const f = JSON.parse(readFileSync(floorFile(pin), 'utf8'));
		return f.agent !== agent ? Number(f.at || 0) : 0;
	} catch {
		return 0;
	}
}

/** Whether the other agent spoke in the last few seconds (so a shared question is probably answered). */
function floorHolderRecently(pin, agent, withinMs = 6000) {
	try {
		const f = JSON.parse(readFileSync(floorFile(pin), 'utf8'));
		return f.agent !== agent && Date.now() - statSync(floorFile(pin)).mtimeMs < withinMs;
	} catch {
		return false;
	}
}
export function releaseFloor(pin, agent) {
	try {
		withFloorLock(pin, () => {
			if (floorHolder(pin) !== agent) return false;
			const f = JSON.parse(readFileSync(floorFile(pin), 'utf8'));
			const file = floorFile(pin);
			const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
			writeFileSync(temp, JSON.stringify({ ...f, until: 0 }));
			renameSync(temp, file);
			return true;
		});
	} catch {}
}

function args(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const k = a.slice(2);
			out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
		} else out._.push(a);
	}
	return out;
}

/** +E.164 or a 10-digit North American number; refuses 911/N11, 900/976 and malformed input. */
export function checkNumber(input) {
	let s = String(input || '').replace(/[^\d+]/g, '');
	if (/^\d{10}$/.test(s)) s = `+1${s}`;
	else if (/^1\d{10}$/.test(s)) s = `+${s}`;
	if (!/^\+[1-9]\d{7,14}$/.test(s)) throw new Error(`Not a phone number: ${input}`);
	if (s.startsWith('+1')) {
		const area = s.slice(2, 5);
		const ex = s.slice(5, 8);
		if (/^[2-9]11$/.test(area) || /^[2-9]11$/.test(ex)) throw new Error('Service numbers like 911 cannot be called.');
		if (area === '900' || area === '976' || ex === '976') throw new Error('Premium-rate numbers cannot be called.');
	}
	return s;
}

async function telnyx(path, body) {
	const res = await fetch(`https://api.telnyx.com/v2${path}`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${TELNYX_KEY}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body || {}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${path}: ${data?.errors?.[0]?.detail || res.status}`);
	return data.data;
}

/** Settings shared with the group.call worker (GEMINI_API_KEY for fast turns). */
const workerEnv = (() => {
	try {
		return readFileSync(`${HOME}/.config/groupcall/worker.env`, 'utf8');
	} catch {
		return '';
	}
})();
const fromWorkerEnv = (name) => process.env[name] || (workerEnv.match(new RegExp(`^${name}="?([^"\\n]+)"?$`, 'm')) || [])[1];
const GEMINI_KEY = fromWorkerEnv('GEMINI_API_KEY');
const CF_ACCOUNT = fromWorkerEnv('CF_AI_ACCOUNT_ID');
const CF_TOKEN = fromWorkerEnv('CF_AI_TOKEN');

/**
 * One turn of the conversation. Use the agent's configured model first; Cloudflare
 * Workers AI and Gemini remain fast fallbacks if that run is unavailable.
 */
/**
 * The fast providers, on their own.
 *
 * A phone call cannot wait for a thorough answer. The agent's configured model
 * runs locally and took 4.5-9.7 s a turn on the first co-hosted episodes —
 * sometimes returning nothing at all — which put ten to thirteen seconds of
 * silence after every answer the guest gave. On a live show speed beats depth:
 * a host that replies in two seconds with a decent question is a better host.
 */
export async function quickTurn(prompt, { fetcher = fetch } = {}) {
	if (GEMINI_KEY) {
		try {
			const res = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.AGENT_PHONE_GEMINI_MODEL || 'gemini-flash-lite-latest'}:generateContent`, {
				method: 'POST',
				headers: { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' },
				body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 300 } }),
				signal: AbortSignal.timeout(6000),
			});
			const data = await res.json();
			const text = (data?.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('').trim();
			if (res.ok && text) return text;
		} catch {}
	}
	if (CF_ACCOUNT && CF_TOKEN) {
		try {
			const res = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${process.env.AGENT_PHONE_CF_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast'}`, {
				method: 'POST',
				headers: { authorization: `Bearer ${CF_TOKEN}`, 'content-type': 'application/json' },
				body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_tokens: 300, temperature: 0.5 }),
				signal: AbortSignal.timeout(6000),
			});
			const data = await res.json();
			const text = String(data?.result?.response || '').trim();
			if (res.ok && text) return text;
		} catch {}
	}
	return '';
}

async function brain(agent, prompt) {
	const selected = await configuredTurn(agent, prompt);
	if (selected.trim()) return selected;
	const quick = await quickTurn(prompt);
	if (quick) return quick;
	return '';
}

function configuredTurn(agent, prompt) {
	return new Promise((resolve) => {
		let output = '';
		let settled = false;
		const modelEnv = { ...process.env };
		for (const name of ['GROUPCALL_AGENT_WORKER_KEY', 'TELNYX_API_KEY', 'AGENT_PHONE_SECRET']) delete modelEnv[name];
		const child = spawn('agent-llm', [agent, 'chat'], { cwd: TURN_CWD, stdio: ['pipe', 'pipe', 'ignore'], env: modelEnv });
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => child.kill('SIGTERM'), 45_000);
		child.stdout.on('data', (chunk) => { output += chunk.toString(); });
		child.stderr?.on('data', () => {});
		child.stdin.on('error', () => {});
		child.on('error', () => finish(''));
		child.on('close', (code) => finish(code === 0 ? output : ''));
		child.stdin.end(prompt);
	});
}

export const looksLikeGoodbye = (text) => /\b(good ?bye|bye( now)?|have a (good|great|nice) (one|day|night|evening|afternoon))\b[.!]*\s*$/i.test(String(text).trim());

export function parseTurn(out) {
	const s = String(out || '').trim();
	const m = /^(SAY|HANGUP|TASK|CALLIN|TEXT):\s*([\s\S]+)$/m.exec(s);
	if (!m) return { kind: 'pass', text: '' };
	const kind = m[1].toLowerCase();
	const text = m[2].trim().split('\n')[0].trim();
	// "SAY: PASS" is a model saying nothing, not a line to read out.
	if (/^(?:pass|skip|silence|nothing)\.?$/i.test(text)) return { kind: 'pass', text: '' };
	if (kind === 'text') {
		// What everyone on the call is texted: a link, a short note. Without one there is nothing to send.
		const message = String(/^MESSAGE:\s*(.+)$/m.exec(s)?.[1] || '').trim().slice(0, 600);
		return message ? { kind, text, message } : { kind: 'say', text: "What should I text everyone? Give me the link." };
	}
	if (kind === 'callin') {
		// A US/Canadian number only: group.call refuses anything else anyway.
		const digits = String(/^NUMBER:\s*(.+)$/m.exec(s)?.[1] || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
		return /^\d{10}$/.test(digits) ? { kind, text, number: digits } : { kind: 'say', text: "I didn't catch the number. Can you say it again?" };
	}
	if (kind !== 'task') return { kind, text };
	const brief = (/^BRIEF:\s*([\s\S]+)$/m.exec(s)?.[1] || text).trim();
	return { kind, text, brief };
}

/** The qrypt.chat chat each agent reports task results into (the Agents group with Anthony). */
const TASK_CHAT = {
	cha0spunk: '6f1191b7-4dbf-4f31-b78e-8525880c1b2f',
	coinpay: '6f1191b7-4dbf-4f31-b78e-8525880c1b2f',
	knox: '6f1191b7-4dbf-4f31-b78e-8525880c1b2f',
	nora: '6f1191b7-4dbf-4f31-b78e-8525880c1b2f',
	quill: '6f1191b7-4dbf-4f31-b78e-8525880c1b2f',
	riotcoder: '6f1191b7-4dbf-4f31-b78e-8525880c1b2f',
	rootkey: '6f1191b7-4dbf-4f31-b78e-8525880c1b2f',
};

/** Queue work for the agent's own task runner (riotcoder-qc-sweep --tasks), which reports in qrypt.chat. */

function queueTask(agent, ack, brief, said) {
	if (!TASK_CHAT[agent]) throw new Error(`Unknown agent ${agent}`);
	const task = {
		source: 'groupcall',
		chat_id: TASK_CHAT[agent],
		chat_title: 'Agents',
		ack,
		instructions: `Anthony's phone request:\n${brief}\n\nWords heard on the call (transcription may be wrong):\n${said}`,
		request: said,
		context: said,
	};
	execFileSync('/usr/bin/python3', ['/usr/local/libexec/qc-agent-responder', '--enqueue'], {
		env: { ...process.env, QC_AGENT: agent },
		input: JSON.stringify(task),
		stdio: ['pipe', 'ignore', 'ignore'],
		timeout: 20_000,
	});
}

async function main() {
	const a = args(process.argv.slice(2));
	if (a._[0] === 'groupcall-worker') return groupcallWorker(a);
	const join = a._[0] === 'join';
	if (join && !/^\d{4,8}$/.test(String(a.pin || ''))) {
		console.error('Usage: agent-phone join <number> --pin 4821 [--room "Standup"] [--goal "..."] [--agent riotcoder] [--max-minutes 30] [--role greeter] [--json]');
		process.exit(2);
	}
	if (join && typeof a.goal !== 'string') a.goal = 'You were invited to join this group call. Introduce yourself briefly, then listen, and help when someone asks you something.';
	if ((a._[0] !== 'call' && !join) || !a._[1] || typeof a.goal !== 'string') {
		console.error('Usage: agent-phone call <number> --goal "what to achieve" [--agent riotcoder] [--max-minutes 10] [--json]');
		process.exit(2);
	}
	if (!TELNYX_KEY || !AGENT_APP || !SECRET || !CALLER_ID) throw new Error('Missing phone settings in ~/.config/agent-phone/phone.env');
	const to = checkNumber(a._[1]);
	const agent = typeof a.agent === 'string' ? a.agent : process.env.QC_AGENT || 'riotcoder';
	/** Sent by a room's greeter setting: keep an early caller company until the host joins, then leave. */
	const greeter = join && a.role === 'greeter';
	// A show's leg has to outlast the show: a 60-minute cap cut the sign-off off
	// the end of a 60-minute format. Still bounded, so a runaway leg cannot sit on
	// the line forever.
	const maxMinutes = Math.min(join ? 125 : 30, Math.max(1, Number(a['max-minutes']) || (join ? 30 : 10)));
	const persona = a.podcast
		? (agent === 'riotcoder' ? 'RiotCoder, Anthony\'s AI assistant and co-host.' : 'Chaospunk, an AI assistant and co-host.')
		: (() => {
			for (const p of [`${HOME}/.config/${agent}-qc/persona.md`, `${HOME}/.config/agent-identities/${agent}/AGENTS.md`]) {
				try {
					const text = read(p).trim();
					if (text) return text;
				} catch {}
			}
			return `${DISPLAY_NAMES[agent] || agent}, Anthony's AI agent.`;
		})();
	const turnTemplate = typeof a.template === 'string' && a.template ? a.template : join ? (a.podcast ? 'podcast-turn.md' : 'group-turn.md') : 'phone-turn.md';
	const template = read(`${HOME}/.config/qc-agents/${turnTemplate}`);
	const skipElevenLabs = /^(?:1|true|yes)$/i.test(fromWorkerEnv('AGENT_PHONE_SKIP_ELEVENLABS') || '');
	/**
	 * Where this leg's audio is made: 'c0mpute' renders it on our own network in
	 * the agent's profile voice, 'kokoro' is the same model rendered by Telnyx,
	 * and anything else keeps the old ElevenLabs-with-Polly behaviour.
	 */
	const voiceEngine = String(typeof a['voice-engine'] === 'string' ? a['voice-engine'] : fromWorkerEnv('AGENT_PHONE_VOICE_ENGINE') || '').toLowerCase();
	const speechBase = fromWorkerEnv('AGENT_PHONE_SPEECH_URL') || '';
	const speechKey = fromWorkerEnv('AGENT_PHONE_SPEECH_KEY') || '';
	let voice = voiceFor(agent, fromWorkerEnv('AGENT_PHONE_VOICE') || '', skipElevenLabs, voiceEngine);
	if (voice.startsWith('c0mpute:') && !(speechBase && speechKey)) {
		voice = `Telnyx.KokoroTTS.${kokoroVoiceFor(agent)}`;
		if (!a.json) console.error(`(no AGENT_PHONE_SPEECH_URL/KEY: speaking ${voice} instead of rendering on c0mpute)`);
	}
	const transcript = [];
	const started = Date.now();
	const logFile = `${CALL_LOGS}/${new Date().toISOString().replace(/[:.]/g, '-')}-${agent}-${join ? a.pin : to.replace(/\D/g, '')}.log`;
	const note = (who, text) => {
		transcript.push({ who, text, at: new Date().toISOString() });
		const line = `${who === 'them' ? (join ? 'room' : 'them') : agent}: ${text}`;
		try {
			appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} ${line}\n`);
		} catch {}
		if (!a.json) console.log(line);
	};

	const leg = await telnyx('/calls', {
		connection_id: AGENT_APP,
		to,
		from: typeof a.from === 'string' && /^\+\d{8,15}$/.test(a.from) ? a.from : CALLER_ID,
		timeout_secs: 40,
		time_limit_secs: maxMinutes * 60,
		...(join ? {} : { answering_machine_detection: 'detect' }),
	});
	const ccid = leg.call_control_id;
	const session = leg.call_session_id;
	if (!a.json) console.log(`calling ${to} as ${agent} (session ${session})`);
	// Stopped any way short of SIGKILL, hang up first: a dead agent must not sit silent in a room until its time limit.
	for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => telnyx(`/calls/${encodeURIComponent(ccid)}/actions/hangup`).finally(() => process.exit(130)));

	// SPEC-0001 1.1: the room's own record is our memory. Load it before the first turn, so a
	// rejoin (a drop, a crash, a deploy) picks up the conversation instead of starting over.
	let rejoin = false;
	let afterId = 0;
	const roomHeaders = { authorization: `Bearer ${process.env.GROUPCALL_AGENT_WORKER_KEY}` };
	if (join && process.env.GROUPCALL_STATUS_URL) {
		const r = await fetch(process.env.GROUPCALL_STATUS_URL, { headers: roomHeaders }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
		const all = await fetch(`${process.env.GROUPCALL_STATUS_URL}/lines?after=0&wait=0`, { headers: roomHeaders }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
		afterId = all?.lines?.at(-1)?.id || 0;
		if (r) r.history = (all?.lines || r.history || []).slice(-80);
		for (const l of r?.history || []) {
			const at = new Date(l.at).toISOString();
			if (l.kind === 'agent' && l.who === agent) transcript.push({ who: agent, text: l.text, at, history: true });
			else if (l.kind === 'agent') transcript.push({ who: l.who, text: l.text, at, history: true });
			else transcript.push({ who: 'them', text: `${l.who}: ${l.text}`, at, history: true });
		}
		rejoin = !shouldIntroduce(agent, transcript, Date.now());
		if (r?.history?.length) {
			try {
				appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} [memory] ${r.history.length} earlier lines loaded${rejoin ? ', rejoining' : ''}\n`);
			} catch {}
		}
	}

	let machine = '';
	let speaking = false;
	let thinking = false;
	let hangupAfterSpeech = false;
	let buffer = '';
	let quietTimer = null;
	let ended = null;
	let answered = false;
	let staleRetry = false;
	let lastVoice = 0;
	let speakWatchdog = null;
	/** Our own recent lines, to spot our voice coming back through someone's speakerphone. */
	const spoken = [];
	const words = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1);
	const isEcho = (t) => {
		const heard = words(t);
		if (heard.length === 0) return false;
		return spoken.some((s) => {
			if (Date.now() - s.at > 15_000) return false;
			const mine = new Set(words(s.text));
			return heard.filter((w) => mine.has(w)).length / heard.length >= 0.6;
		});
	};
	// join: the room code is keyed once the line asks for it; until then nothing is said.
	let keyed = !join;
	let lastHeard = Date.now();
	/** Hear the room the way group.call heard it: each line whole, with its speaker. */
	const followRoom = async () => {
		const url = process.env.GROUPCALL_STATUS_URL;
		if (!url) return;
		while (!ended) {
			const r = await fetch(`${url}/lines?after=${afterId}&wait=20`, { headers: roomHeaders, signal: AbortSignal.timeout(30_000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
			if (!r) {
				await new Promise((res) => setTimeout(res, 1000));
				continue;
			}
			for (const l of r.lines || []) {
				afterId = Math.max(afterId, l.id);
				if (ended || (l.kind === 'agent' && l.who === agent)) continue;
				if (l.kind === 'agent') {
					transcript.push({ who: l.who, text: l.text, at: new Date().toISOString() });
					try {
						appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} ${l.who} (other agent): ${l.text}\n`);
					} catch {}
					if (addressed(agent, l.text)) {
						buffer += ` ${l.who}: ${l.text}`;
						scheduleTurn();
					}
					continue;
				}
				lastVoice = Math.max(lastVoice, Date.now() - 1000);
				buffer += ` ${l.who}${l.kind === 'typed' ? ' (typed)' : ''}: ${l.text}`;
				scheduleTurn();
			}
		}
	};
	const keyCode = async () => {
		if (keyed || ended) return;
		keyed = true;
		if (join) void followRoom();
		await act('send_dtmf', { digits: `${a.pin}#`, duration_millis: 250 }).catch((e) => console.error(`dtmf failed: ${e.message}`));
		if (join && a['join-token']) {
			setTimeout(() => act('send_dtmf', { digits: identityDtmf(a['join-token']), duration_millis: 180 }).catch((e) => console.error(`identity dtmf failed: ${e.message}`)), 1800).unref();
		}
		// The room welcomes us and says who is there; speak after that.
		setTimeout(() => turn(), 9000).unref();
	};

	const act = (path, body) => telnyx(`/calls/${encodeURIComponent(ccid)}/actions/${path}`, body);
	/** Chunks of the current turn still to render and play, in order. */
	let playQueue = [];
	/** The next chunk, already being rendered while the current one plays. */
	let prefetched = null;
	let speechSeq = 0;
	let ourVoiceFailures = 0;
	const renderingOurselves = () => voice.startsWith('c0mpute:');
	/** Nothing of this turn is left to play. */
	const playbackDone = () => !playQueue.length && !prefetched;
	const stopPlayback = () => {
		playQueue = [];
		prefetched = null;
	};
	/** Start rendering the next chunk now, so it is ready when this one ends. */
	const renderNextChunk = () => {
		const text = playQueue.shift();
		if (text === undefined) return null;
		return renderOnC0mpute(text, { agent, base: speechBase, key: speechKey, id: `${session}-${++speechSeq}` }).then((line) => (line ? { ...line, text } : null));
	};
	/**
	 * Play the next chunk of this turn, keeping one chunk rendering ahead of the
	 * audio. False when there is nothing left or our network could not render it.
	 */
	const playNextChunk = async () => {
		const pending = prefetched ?? renderNextChunk();
		prefetched = null;
		if (!pending) return false;
		const line = await pending;
		if (!line) return false;
		prefetched = renderNextChunk();
		try {
			await act('playback_start', { audio_url: line.url, overlay: false });
		} catch (e) {
			if (!a.json) console.error(`(playback failed: ${e.message})`);
			return false;
		}
		armSpeechWatchdog(line.seconds);
		// Now the length is known: hold the floor for exactly as long as this plays,
		// plus the webhook round trip to the next chunk.
		if (join) takeFloor(a.pin, agent, line.text ?? '', (line.seconds + 8) * 1000);
		try {
			appendFileSync(logFile, `${new Date().toISOString().slice(11, 23)} [c0mpute ${line.voice} ${line.seconds}s synth ${line.synthMs}ms]\n`);
		} catch {}
		return true;
	};
	/**
	 * A turn is over when its audio is: give playback the line's own length plus
	 * slack, rather than one flat timeout that cuts long answers off.
	 */
	const armSpeechWatchdog = (seconds = 0) => {
		clearTimeout(speakWatchdog);
		speakWatchdog = setTimeout(() => {
			speaking = false;
			stopPlayback();
			if (join) releaseFloor(a.pin, agent);
			try { appendFileSync(logFile, `${new Date().toISOString().slice(11, 23)} [speak-timeout]\n`); } catch {}
		}, Math.max(30_000, (seconds + 20) * 1000)).unref();
	};
	const speak = async (rawText) => {
		const text = sayable(rawText);
		/**
		 * One voice at a time, enforced here rather than only at the turn.
		 *
		 * Every path that speaks ends up in this function, and a claim refused
		 * means the co-host is mid-sentence. Speaking anyway talks over it AND
		 * leaves our words with no claim behind them, so the co-host hears them as
		 * the guest: on episode 8 both hosts asked the guest how many bare metal
		 * servers he runs within four seconds, and one of them then answered the
		 * other's question as though the guest had asked it.
		 */
		if (join && floorTakenByOther(a.pin, agent)) {
			try {
				appendFileSync(logFile, `${new Date().toISOString().slice(11, 23)} [yielded to ${floorHolder(a.pin)}] ${text.slice(0, 80)}\n`);
			} catch {}
			speaking = false;
			return;
		}
		try {
			appendFileSync(logFile, `${new Date().toISOString().slice(11, 23)} [spoke-start]\n`);
		} catch {}
		spoken.push({ text, at: Date.now() });
		if (spoken.length > 4) spoken.shift();
		speaking = true;
		armSpeechWatchdog();
		/**
		 * Claim the floor for anything we say, including the first thing.
		 *
		 * The other agent decides whether a line it hears is a person talking or
		 * its co-host by who holds the floor; an opening line said without it
		 * reaches the co-host as a stranger's voice, and two hosts then interview
		 * each other. Rendering makes this worse: the audio starts seconds after
		 * the turn is decided, so the claim has to cover the render as well as the
		 * speech, and `playNextChunk` extends it once the real length is known.
		 */
		// Claim it for the render plus the speech; and whether or not the claim
		// lands, the words go on the record so the co-host can place them.
		if (join) {
			takeFloor(a.pin, agent, text, Math.max(20_000, (String(text).length / 11) * 1000 + 15_000));
			noteSaid(a.pin, agent, text);
		}
		// Our own voice, off the c0mpute network: render the line and play the file.
		if (renderingOurselves()) {
			playQueue = speechChunks(text);
			prefetched = null;
			if (await playNextChunk()) return;
			stopPlayback();
			// Our network could not do it. The same Kokoro weights, rendered by
			// Telnyx, keep the agent's voice; after two failures stop paying the
			// round trip to find out and stay on Telnyx's copy for this call.
			ourVoiceFailures += 1;
			const kokoro = `Telnyx.KokoroTTS.${kokoroVoiceFor(agent)}`;
			if (!a.json) console.error(`(c0mpute could not render that line; speaking ${kokoro})`);
			if (ourVoiceFailures >= 2) voice = kokoro;
			try {
				await act('speak', { payload: text, voice: kokoro, language: 'en-US' });
				return;
			} catch (e) {
				const fallback = fallbackVoiceFor(agent);
				if (!a.json) console.error(`(Kokoro voice failed: ${e.message}; using ${fallback})`);
				try {
					await act('speak', { payload: text, voice: fallback });
				} catch (fallbackError) {
					clearTimeout(speakWatchdog);
					speaking = false;
					if (join) releaseFloor(a.pin, agent);
					if (!a.json) console.error(`(speech failed: ${fallbackError.message})`);
				}
				return;
			}
		}
		const request = speechRequest(text, voice);
		try {
			await act('speak', request);
		} catch (e) {
			if (voice.startsWith('ElevenLabs.')) {
				const fallback = fallbackVoiceFor(agent);
				if (!a.json) console.error(`(ElevenLabs voice failed: ${e.message}; using ${fallback})`);
				try {
					await act('speak', { payload: text, voice: fallback });
				} catch (fallbackError) {
					clearTimeout(speakWatchdog);
					speaking = false;
					if (join) releaseFloor(a.pin, agent);
					if (!a.json) console.error(`(speech failed: ${fallbackError.message})`);
				}
			} else {
				clearTimeout(speakWatchdog);
				speaking = false;
				if (join) releaseFloor(a.pin, agent);
				if (!a.json) console.error(`(speech failed: ${e.message})`);
			}
		}
	};
	let leftOnPurpose = false;
	const hangup = () => {
		leftOnPurpose = true;
		return act('hangup').catch(() => {});
	};

	/**
	 * What people said in the last few seconds, as one utterance: speech recognition splits
	 * "Chaos Punk, what is" / "12 plus 30?" into two lines, and the name is in the first.
	 */
	function recentSpeech(windowMs = 8000) {
		const live = transcript.filter((t) => t.who === 'them' && !t.history);
		const last = live.at(-1);
		if (!last) return '';
		const lastAt = Date.parse(last.at);
		return live.filter((t) => lastAt - Date.parse(t.at) <= windowMs).map((t) => t.text).join(' ');
	}

	/** Just a name ("Chaos Punk."): the rest of the sentence is coming; wait for it. */
	const nameOnly = (text) => {
		const body = String(text).replace(/(^|\s)[^:\s]*( ending \d+)?:\s*/g, ' ').trim();
		return addressed(agent, body) && body.split(/\s+/).filter(Boolean).length <= 3 && !/\?/.test(body);
	};

	/** Tells the model, in plain words, who the newest line was for. */
	function addressedHint() {
		if (a.interview) {
			const newest = recentSpeech();
			const partner = agent === 'riotcoder' ? 'ChaosPunk' : 'RiotCoder';
			const partnerAgent = agent === 'riotcoder' ? 'cha0spunk' : 'riotcoder';
			// Nobody has spoken but the hosts: the show has not started, so there is
			// no answer to follow up on and nothing to interview.
			if (!transcript.some((t) => t.who === 'them' && !t.history)) {
				return agent === 'riotcoder'
					? `\n\nNOBODY HAS SPOKEN YET BUT YOU TWO. The guest is not on the line. Say your opening line to the guest exactly as your brief describes it — greet him, say who is hosting, and brief him on the format — and nothing else. Ask him no questions about his work yet, and never pretend he has already said something. If you have already said it, reply PASS and wait for him.`
					: `\n\nNOBODY HAS SPOKEN YET BUT YOU TWO. The guest is not on the line and ${partner} opens the show. Say one short warm hello if you have not yet, then reply PASS every turn until the guest speaks. Do not interview ${partner}.`;
			}
			if (addressed(agent, newest)) return `\n\nTHE GUEST JUST SPOKE TO YOU BY NAME (speech recognition mangles it). Answer or follow up now with SAY. Do not PASS.`;
			if (addressed(partnerAgent, newest)) return `\n\nThe guest was speaking to ${partner}, not you: PASS.`;
			const last = [...transcript].reverse().find((t) => !t.history && t.who !== agent);
			// The co-host asked the guest something and the guest has not answered:
			// the worst thing either host can do is answer it for him.
			if (last && last.who === partnerAgent) return `\n\n${partner} just spoke and THE GUEST HAS NOT ANSWERED YET. Say nothing: PASS. Never answer a question ${partner} put to the guest.`;
			/**
			 * A short answer means move on.
			 *
			 * On the first co-hosted episode the guest said "I'm checking into that
			 * now", was asked the same thing again in different words, said "I'm
			 * looking into it", and hung up. A guest who has nothing more to say on
			 * a point has told you so; pressing it is how you lose him.
			 */
			const lastHeard = [...transcript].reverse().find((t) => t.who === 'them' && !t.history)?.text ?? '';
			const thin = lastHeard.split(/\s+/).filter(Boolean).length <= 8;
			// He asked US something. Ignoring it to read the next question off the
			// brief is how the second episode ended: "what's gonna end this?",
			// unanswered, and he hung up.
			if (roomQuestion(newest)) return `\n\nTHE GUEST JUST ASKED YOU SOMETHING: "${newest.slice(0, 120)}". Answer it with SAY, directly, in one or two sentences, before anything else. If he is asking how the show ends or how to stop, tell him plainly that he can say "let's wrap up" any time and you will close the episode. Do not ignore him and do not ask your next question in the same breath.`;
			return `\n\nTHE GUEST JUST FINISHED AN ANSWER and you have the floor. Ask your next question now with SAY: one or two sentences, specific, following up on what he actually said. Do not PASS, do not summarise his answer back to him, and do not ask ${partner} anything unless you are handing the topic over.${thin ? ` HIS LAST ANSWER WAS SHORT ("${lastHeard.slice(0, 80)}"), which means he has nothing more to say about it. Do NOT ask about that point again in any words. Move to a different subject entirely.` : ''} Read the transcript above before you speak: if a question like yours has already been asked on this call, ask something else.`;
		}
		if (a.podcast) {
			const partnerLine = [...transcript].reverse().find((t) => t.who !== agent && !t.history);
			if (partnerLine && ['riotcoder', 'cha0spunk'].includes(partnerLine.who)) {
				const partner = partnerLine.who === 'riotcoder' ? 'Codex' : 'Chaospunk';
				return `\n\nPODCAST CO-HOST TURN: answer ${partner}'s latest point with a substantive spoken response, then end with one specific question addressed to ${partner} so they can take the next turn. Do not PASS.`;
			}
		}
		const newest = recentSpeech();
		if (!newest) return '';
		// A greeter is the only one here for whoever is waiting: everything they say is to it.
		if (greeter && !Object.keys(NAME_ALIASES).some((o) => o !== agent && addressed(o, newest)))
			return '\n\nYOU ARE THE RECEPTIONIST, and the person on the line is waiting for the host with only you to talk to. Answer the newest line now with SAY, warmly and briefly, and keep the conversation going. Do not PASS. Never pretend to be the host.';
		if (addressed(agent, newest)) return `\n\nTHE NEWEST LINE IS ADDRESSED TO YOU (${agent}; the name is misspelled by speech recognition). Answer it now with SAY. Do not PASS.`;
		const other = Object.keys(NAME_ALIASES).find((o) => o !== agent && addressed(o, newest));
		if (other) return `\n\nThe newest line is addressed to ${other}, not you: PASS.`;
		if (roomQuestion(newest)) return '\n\nTHE NEWEST LINE IS A PERSON ASKING THE ROOM (that includes you). Answer the substance of their question now with SAY, briefly, even if a similar question was answered earlier in the call. Do not PASS. Do not just say you are here or listening unless that is what they asked.';
		return '';
	}

	let nameWaitFor = '';
	async function turn() {
		if (thinking || ended || !keyed) return;
		if (join) {
			const heard = recentSpeech();
			if (nameOnly(heard) && nameWaitFor !== heard) {
				nameWaitFor = heard;
				setTimeout(() => turn(), 3500).unref();
				return;
			}
		}
		thinking = true;
		let reservedQuestionFloor = false;
		try {
			const newest = join ? recentSpeech() : '';
			const firstTurn = join && shouldIntroduce(agent, transcript, Date.now());
			if (join && !shouldConsiderRoomTurn(agent, newest, { firstTurn, greeter, podcast: a.podcast || a.interview })) return;
			const mine = addressed(agent, newest);
			const namedToAnother = join && !a.podcast && Object.keys(NAME_ALIASES).some((other) => other !== agent && addressed(other, newest)) && !mine;
			if (namedToAnother) return;
			const roomQuestionTurn = join && !a.podcast && !a.interview && roomQuestion(newest) && !mine && !greeter;
			/**
			 * Two hosts, one guest: whoever takes the floor asks the next question.
			 * The lead reaches for it first and the co-host waits a beat, so the
			 * lead normally leads and the co-host still covers a lead that has gone
			 * quiet. A host the guest named by name skips the queue.
			 */
			const partnerAgent = agent === 'riotcoder' ? 'cha0spunk' : 'riotcoder';
			const partnerSpokeLast = (() => {
				const last = [...transcript].reverse().find((t) => !t.history && t.who !== agent);
				return Boolean(last && last.who === partnerAgent);
			})();
			if (join && a.interview && !firstTurn) {
				// Never answer a question the co-host put to the guest.
				if (partnerSpokeLast && !mine) return;
				if (!mine) {
					await new Promise((r) => setTimeout(r, agent === 'riotcoder' ? 700 : 2600));
					if (ended) return;
				}
				const waitUntil = Date.now() + 8000;
				while (Date.now() < waitUntil && !ended && (floorTakenByOther(a.pin, agent) || Date.now() - lastVoice < 1200)) await new Promise((r) => setTimeout(r, 150));
				if (ended || !takeFloor(a.pin, agent, '', 45_000)) return;
				reservedQuestionFloor = true;
			}
			const greetingTurn = firstTurn && !roomQuestionTurn;
			if (roomQuestionTurn) {
				// Elect one agent before asking any model, avoiding six simultaneous model calls.
				const waitUntil = Date.now() + 8000;
				while (Date.now() < waitUntil && !ended && (floorTakenByOther(a.pin, agent) || Date.now() - lastVoice < 2000)) await new Promise((r) => setTimeout(r, 150));
				if (ended || !takeFloor(a.pin, agent, '', 60_000)) return;
				reservedQuestionFloor = true;
			}
			// Re-read each turn, so a prompt fix reaches agents already on a call.
			let current = template;
			try {
				current = read(`${HOME}/.config/qc-agents/${turnTemplate}`);
			} catch {}
			const prompt = current
				.replaceAll('{agent}', agent)
				.replace('{persona}', persona)
				.replace('{goal}', a.goal)
				.replace('{number}', to)
				.replace('{machine}', machine)
				.replace('{room}', join ? `"${a.room || 'a group call'}", code ${a.pin}, on ${to}.${addressedHint()}` : '')
				.replace('{transcript}', transcript.map((t) => `${t.who === 'them' ? (join ? 'room' : 'them') : t.who === agent ? `${agent} (you)` : `${t.who} (the other agent)`}: ${t.text}`).join('\n') || '(the call just connected; nobody has spoken yet)')
				.replace('{now}', `It is ${new Date().toUTCString()}. The call has lasted ${Math.round((Date.now() - started) / 1000)} s of at most ${maxMinutes * 60} s.`)
				.replace('{intro}', !firstTurn
					? 'You have already introduced yourself on this call: do not do it again.'
					: roomQuestionTurn
						? 'A person asked the room a question as you joined. Answer the substance of it now; do not replace the answer with a generic introduction or listening line.'
						: join && rejoin
						? 'You were on this call earlier and just reconnected; the transcript above is what was said. Do NOT introduce yourself again and do not announce that you are back unless someone asks. Otherwise follow the rules below as usual: answer people when they talk to you or ask the room something.'
						: join
						? `You just joined. Unless someone is mid-sentence, say a short hello: "Hi everyone, ${agent} here, Anthony's AI agent." Do not PASS on this first turn.`
						: `In this first line, say who you are: "Hi, this is ${agent}, an AI assistant calling for Anthony."`);
			const t0 = Date.now();
			const heardBefore = transcript.filter((t) => t.who === 'them').length;
			// A show opens the way its brief says to, not with the stock hello.
			// On air, ask the fast provider first and only fall back to the slower
			// configured model if it gives nothing.
			const think = async () => (a.interview ? (await quickTurn(prompt)) || (await brain(agent, prompt)) : brain(agent, prompt));
			let raw = greetingTurn && !a.podcast && !a.interview ? `SAY: ${agentIntro(agent)}` : await think();
			let { kind, text, brief: turnBrief, number: callNumber, message: textMessage } = parseTurn(raw);
			if (greetingTurn && !text && !ended) {
				// The hello is not optional: one more try before going quiet.
				raw = await think();
				({ kind, text, brief: turnBrief, number: callNumber, message: textMessage } = parseTurn(raw));
			}
			if ((roomQuestionTurn || mine || greeter) && shouldFallbackRoomResponse(agent, newest, text)) {
				text = roomQuestionFallback(newest);
				kind = 'say';
				appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} [room-question fallback]\n`);
			}
			try {
				appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} [turn ${Date.now() - t0} ms] ${text ? kind.toUpperCase() : raw.trim() ? 'PASS' : 'EMPTY (model failed or timed out)'}\n`);
			} catch {}
			if (ended || !text) return;
			if (join && kind !== 'hangup' && transcript.filter((t) => t.who === 'them').length > heardBefore) {
				// More was said while we thought: answer the whole of it, not the first half.
				try {
					appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} [stale, thinking again]\n`);
				} catch {}
				staleRetry = true;
				return;
			}
			if (join) {
				const lastHeard = recentSpeech();
				const mine = addressed(agent, lastHeard);
				const otherNamed = Object.keys(NAME_ALIASES).some((o) => o !== agent && addressed(o, lastHeard)) && !mine;
				const introduced = !shouldIntroduce(agent, transcript, Date.now());
				if (introduced && kind !== 'hangup' && otherNamed) return;
				// The other agent already answered what we are answering: leave it, unless it was ours by name.
				const lineAt = Date.parse([...transcript].reverse().find((t) => t.who === 'them')?.at || '') || 0;
				if (introduced && !mine && kind !== 'hangup' && otherSpokeAt(a.pin, agent) > lineAt) return;
				// One voice at a time: wait out the other agent mid-sentence and anyone still talking.
				const waitUntil = Date.now() + 8000;
				while (Date.now() < waitUntil && !ended && (floorTakenByOther(a.pin, agent) || Date.now() - lastVoice < 2000)) await new Promise((r) => setTimeout(r, 150));
				if (ended) return;
				if (floorTakenByOther(a.pin, agent)) return; // still theirs after 8 s: let it go
				// The other agent took the floor and answered while we waited: unless this was ours by name, leave it.
				if (introduced && !mine && kind !== 'hangup' && Date.now() - t0 > 2500 && floorHolderRecently(a.pin, agent)) return;
				if (!takeFloor(a.pin, agent, text)) return;
			}
			if (kind === 'task') {
				// Work only for someone this agent works for: the room's own transcript says who spoke.
				const r = process.env.GROUPCALL_STATUS_URL
					? await fetch(process.env.GROUPCALL_STATUS_URL, { headers: { authorization: `Bearer ${process.env.GROUPCALL_AGENT_WORKER_KEY}` } }).then((x) => (x.ok ? x.json() : null)).catch(() => null)
					: null;
				const asked = [...(r?.recent || [])].reverse().find((l) => l.trusted && Date.now() - l.at < 2 * 60_000);
				if (!asked) {
					text = "I can only take on work when Anthony asks for it, sorry.";
				} else {
					try {
						queueTask(agent, text, turnBrief, [...(r.recent || [])].filter((l) => l.trusted).slice(-3).map((l) => l.text).join(' '));
						appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} [task queued] ${turnBrief}\n`);
					} catch (e) {
						text = "I couldn't queue that, I'll mention it to Anthony in chat.";
					}
				}
			}
			if (kind === 'text') {
				// Texts go to real phones from the room's number: only when Anthony asked, like work and call-ins.
				const r = join && process.env.GROUPCALL_STATUS_URL
					? await fetch(process.env.GROUPCALL_STATUS_URL, { headers: { authorization: `Bearer ${process.env.GROUPCALL_AGENT_WORKER_KEY}` } }).then((x) => (x.ok ? x.json() : null)).catch(() => null)
					: null;
				const asked = [...(r?.recent || [])].reverse().find((l) => l.trusted && Date.now() - l.at < 2 * 60_000);
				if (!asked) text = "I can only text everyone when Anthony asks, sorry.";
				else {
					const sent = await fetch(`${process.env.GROUPCALL_STATUS_URL}/text`, {
						method: 'POST',
						headers: { authorization: `Bearer ${process.env.GROUPCALL_AGENT_WORKER_KEY}`, 'content-type': 'application/json' },
						body: JSON.stringify({ text: textMessage, agent }),
					}).then((x) => x.json()).catch((e) => ({ error: e.message }));
					appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} [texted] ${JSON.stringify(sent)} ${textMessage}\n`);
					if (!sent?.sent) text = sent?.error ? `I couldn't send the text: ${String(sent.error).replace(/ \(10DLC\)/, '')}.` : "Nobody on the call has a number I can text.";
				}
			}
			let callIn = '';
			if (kind === 'callin') {
				// Only for Anthony, like work: the room pays for the call. The room itself checks the
				// pass, the hourly cap and US/Canada when it gets the keys.
				const r = join && process.env.GROUPCALL_STATUS_URL
					? await fetch(process.env.GROUPCALL_STATUS_URL, { headers: { authorization: `Bearer ${process.env.GROUPCALL_AGENT_WORKER_KEY}` } }).then((x) => (x.ok ? x.json() : null)).catch(() => null)
					: null;
				const asked = [...(r?.recent || [])].reverse().find((l) => l.trusted && Date.now() - l.at < 2 * 60_000);
				if (!asked) text = "I can only call people in when Anthony asks, sorry.";
				else callIn = callNumber;
			}
			note(agent, text);
			if (callIn) {
				// * number # on our own leg: group.call rings them in, and they press 1 to join.
				act('send_dtmf', { digits: `*${callIn}#`, duration_millis: 250 })
					.then(() => appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} [calling in] ${callIn}\n`))
					.catch((e) => console.error(`call-in dtmf failed: ${e.message}`));
			}
			// A goodbye ends the call even if the model wrote SAY: (it did, in the first live test).
			if (kind === 'hangup' || looksLikeGoodbye(text)) hangupAfterSpeech = true;
			await speak(text);
			if (hangupAfterSpeech) setTimeout(hangup, 15_000).unref(); // in case speak.ended never comes
		} finally {
			if (reservedQuestionFloor && !speaking) releaseFloor(a.pin, agent);
			thinking = false;
			if (staleRetry && !ended) {
				staleRetry = false;
				setTimeout(() => turn(), 0);
			} else if (buffer && !ended) scheduleTurn();
		}
	}
	function scheduleTurn() {
		clearTimeout(quietTimer);
		quietTimer = setTimeout(() => {
			if (!buffer.trim()) return;
			note('them', buffer.trim());
			buffer = '';
			turn();
		}, join ? 2000 : QUIET_MS);
	}

	async function handle(ev) {
		const p = ev.payload || {};
		switch (ev.event_type) {
			case 'call.answered':
				if (answered) break;
				answered = true;
				await act('transcription_start', { language: 'en', transcription_engine: 'Deepgram', transcription_tracks: 'inbound' }).catch(async () => {
					await act('transcription_start', { language: 'en', transcription_engine: 'Telnyx', transcription_tracks: 'inbound' }).catch((e) => console.error(`transcription failed: ${e.message}`));
				});
				if (join) setTimeout(keyCode, 6000).unref(); // in case the prompt is never transcribed
				else turn();
				break;
			case 'call.machine.detection.ended':
				if (p.result === 'machine') machine = 'It went to VOICEMAIL: leave a short message after the beep, then end the call.';
				break;
			case 'call.transcription': {
				const d = p.transcription_data || {};
				// Interim words mean somebody is talking right now: do not start speaking over them.
				if (String(d.transcript || '').trim() && !isEcho(d.transcript)) lastVoice = Date.now();
				if (!d.is_final || !String(d.transcript || '').trim()) break;
				lastHeard = Date.now();
				if (!keyed) {
					// The line's own prompt: key the code as soon as it asks.
					if (/code|digit|enter|welcome/i.test(d.transcript)) await keyCode();
					break;
				}
				if (join && isEcho(d.transcript)) {
					// Our own voice, back through someone's speaker: neither an interruption nor a question.
					try {
						appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} [echo ignored] ${d.transcript.trim()}\n`);
					} catch {}
					break;
				}
				// Credited to a co-host only when the words are ITS words, whoever
				// holds the floor: the holder is one slot and both hosts talk. A line
				// that echoes nobody is a person, and a person always gets through.
				const otherAgent = join ? (coHostSpeech(a.pin, agent).find((s) => echoesFloor(d.transcript, s.text))?.agent ?? '') : '';
				if (otherAgent) {
					// The other agent talking: context, not a question for us (unless it names us).
					transcript.push({ who: otherAgent, text: d.transcript.trim(), at: new Date().toISOString() });
					try {
						appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} ${otherAgent} (other agent): ${d.transcript.trim()}\n`);
					} catch {}
					if (addressed(agent, d.transcript)) {
						buffer += ` ${d.transcript.trim()}`;
						scheduleTurn();
					}
					break;
				}
				if (speaking && !hangupAfterSpeech && (!join || (words(d.transcript).length >= 2 && !floorTakenByOther(a.pin, agent)))) {
					// A person talked over us: stop and listen. (Our own echo and the other agent never cut us off.)
					act('playback_stop', {}).catch(() => {});
					stopPlayback();
					speaking = false;
					if (join) releaseFloor(a.pin, agent);
				}
				// On a group call, what was said comes from the room's own transcript (followRoom),
				// which has every speaker's line whole; our leg's STT only tells us someone is talking.
				if (join && process.env.GROUPCALL_STATUS_URL) break;
				buffer += ` ${d.transcript.trim()}`;
				scheduleTurn();
				break;
			}
			case 'call.playback.ended':
				// Still more of this turn to play: keep the floor and play it.
				if (speaking && !playbackDone()) {
					if (await playNextChunk()) break;
					stopPlayback();
				}
				clearTimeout(speakWatchdog);
				speakWatchdog = null;
				try {
					appendFileSync(logFile, `${new Date().toISOString().slice(11, 23)} [spoke-end]\n`);
				} catch {}
				speaking = false;
				if (join) releaseFloor(a.pin, agent);
				if (hangupAfterSpeech) await hangup();
				break;
			case 'call.speak.ended':
				clearTimeout(speakWatchdog);
				speakWatchdog = null;
				try {
					appendFileSync(logFile, `${new Date().toISOString().slice(11, 23)} [spoke-end]\n`);
				} catch {}
				speaking = false;
				if (join) releaseFloor(a.pin, agent);
				if (hangupAfterSpeech) await hangup();
				break;
			case 'call.hangup':
				ended = { cause: p.hangup_cause || 'hangup', source: p.hangup_source || '', at: p.end_time || ev.occurred_at };
				if (p.call_quality_stats) {
					try {
						appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} [quality] ${JSON.stringify(p.call_quality_stats)}\n`);
					} catch {}
				}
				break;
		}
	}

	/**
	 * When to leave a group call: when no person (only agents, or nobody) has been
	 * on the line for a minute, or nobody came within three, asked of group.call
	 * every 20 s. Without a status URL, twenty quiet minutes.
	 */
	let hostName = 'your host';
	const roomWatch = (() => {
		const url = process.env.GROUPCALL_STATUS_URL;
		const key = process.env.GROUPCALL_AGENT_WORKER_KEY;
		let lastAsked = 0;
		let lastPerson = Date.now();
		let seenPerson = false;
		return {
			async check(heard) {
				if (!url || !key) return Date.now() - heard > 20 * 60_000 ? 'twenty quiet minutes' : '';
				if (Date.now() - lastAsked < 20_000) return '';
				lastAsked = Date.now();
				const r = await fetch(url, { headers: { authorization: `Bearer ${key}` } }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
				if (!r) return '';
				if (greeter && r.host_here) {
					hostName = r.host && r.host !== 'the next person to join' ? r.host.replace(/^the person calling from .*/, 'your host') : 'your host';
					return 'the host arrived';
				}
				if (r.people > 0) {
					seenPerson = true;
					lastPerson = Date.now();
					return '';
				}
				if (seenPerson && Date.now() - lastPerson > 60_000) return 'everyone else left';
				if (!seenPerson && Date.now() - lastPerson > 3 * 60_000) return 'nobody came';
				return '';
			},
		};
	})();

	let after = 0;
	const deadline = Date.now() + (maxMinutes * 60 + 120) * 1000;
	while (!ended && Date.now() < deadline) {
		if (join && keyed && !thinking && !speaking) {
			const why = await roomWatch.check(lastHeard);
			if (why) {
				note(agent, `(left: ${why})`);
				if (why === 'the host arrived') {
					// Hand over out loud, wait for it to be said, then go.
					await speak(`Looks like ${hostName} is here. I'll leave you to it. Bye for now!`);
					const until = Date.now() + 12_000;
					await new Promise((r) => setTimeout(r, 1500));
					while (speaking && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
				}
				await hangup();
				ended = { cause: why, at: new Date().toISOString() };
				break;
			}
		}
		const res = await fetch(`${EVENTS}?session=${encodeURIComponent(session)}&after=${after}`, {
			headers: { 'x-agent-phone-secret': SECRET, 'User-Agent': 'agent-phone/1.0 (qrypt.chat)' },
		}).catch(() => null);
		if (!res?.ok) {
			await new Promise((r) => setTimeout(r, 1000));
			continue;
		}
		const { events = [] } = await res.json();
		for (const row of events) {
			after = Math.max(after, row.id);
			await handle(row.event);
		}
	}
	if (!ended) {
		await hangup();
		ended = { cause: 'gave_up', at: new Date().toISOString() };
	}
	const result = { to, agent, ...(join ? { pin: String(a.pin), room: a.room || null, left_on_purpose: leftOnPurpose } : {}), answered, voicemail: !!machine, seconds: Math.round((Date.now() - started) / 1000), ended, transcript };
	if (a.json) console.log(JSON.stringify(result, null, 1));
	else console.log(`call ended (${ended.cause}${answered ? '' : ', never answered'}) after ${result.seconds} s`);
}

/**
 * Claims agent invites from group.call and runs `agent-phone join` for each,
 * then tells group.call how it went. Runs for --for seconds (cron starts it
 * every minute under flock), so a crash costs a minute at most.
 */
async function groupcallWorker(a) {
	const conf = (() => {
		try {
			return read(`${HOME}/.config/groupcall/worker.env`);
		} catch {
			return '';
		}
	})();
	const val = (name) => process.env[name] || (conf.match(new RegExp(`^${name}="?([^"\\n]+)"?$`, 'm')) || [])[1];
	const base = (val('GROUPCALL_URL') || 'https://group.call.pit.world').replace(/\/+$/, '');
	const key = val('GROUPCALL_AGENT_WORKER_KEY');
	if (!key) throw new Error('GROUPCALL_AGENT_WORKER_KEY missing (~/.config/groupcall/worker.env)');
	const workerAgent = String(a.agent || val('GROUPCALL_AGENT') || '');
	if (workerAgent && !TASK_CHAT[workerAgent]) throw new Error('Unknown GROUPCALL_AGENT');
	if (workerAgent && HOME !== `/home/${workerAgent}`) throw new Error(`${workerAgent} phone worker must run from its own home`);
	const until = Date.now() + (Number(a.for) || 55) * 1000;
	const post = (path, body) =>
		fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
	const running = [];
	/** Run one agent into one room, report how it went, and dial back once after an unplanned drop. */
	const dialJob = (job) =>
		new Promise((resolve) => {
			const podcast = /^(?:tui weekly|off the record)$/i.test(String(job.room_name || '').trim());
			let brief = job.brief;
			if (/^tui weekly$/i.test(String(job.room_name || '').trim())) { try { brief = read(`${HOME}/.config/qc-agents/tuiweekly-brief.md`).trim() || brief; } catch {} }
			if (/^off the record$/i.test(String(job.room_name || '').trim())) { try { brief = read(`${HOME}/.config/qc-agents/offtherecord-brief.md`).trim() || brief; } catch {} }
			execFile(
				process.argv[1],
				['join', job.dial_in, '--pin', job.code, '--agent', job.agent, '--room', job.room_name, '--goal', brief, '--json', ...(podcast ? ['--podcast'] : []), ...(job.from ? ['--from', job.from] : []), ...(job.joinToken ? ['--join-token', job.joinToken] : []), ...(job.role ? ['--role', job.role] : [])],
				{ timeout: 65 * 60_000, maxBuffer: 8 << 20, env: { ...process.env, GROUPCALL_STATUS_URL: `${base}/api/v1/agent-queue/rooms/${job.code}`, GROUPCALL_AGENT_WORKER_KEY: key, ...(val('GEMINI_API_KEY') ? { GEMINI_API_KEY: val('GEMINI_API_KEY') } : {}) } },
				async (err, stdout) => {
					let r = {};
					try {
						r = JSON.parse(String(stdout).slice(String(stdout).indexOf('{')));
					} catch {}
					const ok = !err && r.answered;
					// SPEC-0001 1.4: dropped without meaning to, with people still on: dial back once, memory intact.
					if (r.answered && r.left_on_purpose === false && !job.redialled) {
						const st = await fetch(`${base}/api/v1/agent-queue/rooms/${job.code}`, { headers: { authorization: `Bearer ${key}` } }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
						if (st && st.people > 0) {
							console.log(`${new Date().toISOString()} ${job.agent} dropped from ${job.code} (${r.ended?.cause || '?'}); dialling back`);
							await dialJob({ ...job, redialled: true });
							return resolve();
						}
					}
					const note = ok ? `on the call ${r.seconds} s, ${r.ended?.cause || 'ended'}${job.redialled ? ' (after one redial)' : ''}` : `could not join: ${(err && err.message) || r.ended?.cause || 'no answer'}`.slice(0, 280);
					await post(`/api/v1/agent-queue/${encodeURIComponent(job.id)}`, { ok, note }).catch(() => {});
					console.log(`${new Date().toISOString()} ${job.agent} <- ${job.code}: ${note}`);
					resolve();
				},
			);
		});
	while (Date.now() < until) {
		// Work a voice agent (ElevenLabs, over SIP) took on during a call: hand it to that agent's task runner.
		for (;;) {
			const t = await post('/api/v1/agent-queue/tasks/next').catch(() => null);
			if (!t || t.status !== 200) break;
			const task = await t.json();
			if (!TASK_CHAT[task.agent] || (workerAgent && task.agent !== workerAgent)) continue;
			console.log(`${new Date().toISOString()} ${task.agent} task from ${task.code}`);
			queueTask(task.agent, task.ack || 'On it.', task.brief, task.said);
		}
		const res = await post('/api/v1/agent-queue/next').catch(() => null);
		if (!res || res.status === 204 || !res.ok) {
			await new Promise((r) => setTimeout(r, 3000));
			continue;
		}
		const job = await res.json();
		if (workerAgent && job.agent !== workerAgent) {
			await post(`/api/v1/agent-queue/${encodeURIComponent(job.id)}`, { ok: false, note: 'worker scope mismatch' }).catch(() => {});
			continue;
		}
		console.log(`${new Date().toISOString()} ${job.agent} -> ${job.code} (${job.room_name})`);
		running.push(dialJob(job));
	}
	// A call outlives the claiming window: wait for it, so its result is reported.
	await Promise.all(running);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error(`agent-phone: ${e.message}`);
		process.exit(1);
	});
}
