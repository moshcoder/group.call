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
 * Telnyx TTS. The worker voice can be overridden per environment, so it keeps
 * talking through AWS Polly while the ElevenLabs workspace is out of quota. This
 * box cannot take webhooks, so Telnyx posts them to
 * qrypt.chat (/api/phone/agent-webhook) and we long-poll them back
* (/api/phone/agent-events, AGENT_PHONE_SECRET). Each turn is a quick read-only
* model run with ~/.config/qc-agents/phone-turn.md. Prints the transcript and
 * how the call ended; the agent reports it in the chat.
 *
 * Only for calls Anthony asked for: the agent says it is an AI in its first line.
 */
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { appendFileSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';

const HOME = process.env.AGENT_PHONE_HOME || process.env.HOME || '/home/anthony';
const read = (p) => readFileSync(p, 'utf8');
const envVal = (file, name) => {
	try {
		return (read(file).match(new RegExp(`^${name}="?([^"\\n]+)"?$`, 'm')) || [])[1] || process.env[name] || '';
	} catch {
		return process.env[name] || '';
	}
};
const TELNYX_KEY = envVal(`${HOME}/www/qrypt.chat/app.env`, 'TELNYX_API_KEY');
const AGENT_APP = envVal(`${HOME}/www/qrypt.chat/app.env`, 'TELNYX_AGENT_APP_ID');
const SECRET = envVal(`${HOME}/www/qrypt.chat/app.env`, 'AGENT_PHONE_SECRET');
const CALLER_ID = envVal(`${HOME}/www/qrypt.chat/app.env`, 'PHONE_CALLER_ID') || '+19492847328';
const EVENTS = 'https://qrypt.chat/api/phone/agent-events';
const VOICES = { riotcoder: 'iP95p4xoKVk53GoZ742B', cha0spunk: 'cgSgspJ2msm6clMCkdW9' }; // ElevenLabs Chris, Jessica
export const FALLBACK_VOICE = 'AWS.Polly.Matthew-Neural';
export function voiceFor(agent, override = '') { return override || (VOICES[agent] ? `ElevenLabs.Default.${VOICES[agent]}` : FALLBACK_VOICE); }
export function speechRequest(text, voice) {
	const request = { payload: text, voice };
	if (voice.startsWith('ElevenLabs.')) request.voice_settings = { api_key_ref: 'qrypt_elevenlabs' };
	return request;
}
const DISPLAY_NAMES = { riotcoder: 'RiotCoder', cha0spunk: 'ChaosPunk', rootkey: 'RootKey', coinpay: 'CoinPay', knox: 'Knox', nora: 'Nora' };
export function agentIntro(agent) { return `Hi, I’m ${DISPLAY_NAMES[agent] || agent}, Anthony’s AI agent. I’m here and listening.`; }
export function shouldIntroduce(agent, transcript, now = Date.now(), recentMs = 3 * 60_000) {
	const last = [...transcript].reverse().find((line) => line.who === agent);
	const at = last ? Date.parse(last.at) : NaN;
	return !Number.isFinite(at) || now - at > recentMs;
}
export function roomQuestion(text) {
	const body = String(text).replace(/(^|\s)[^:\s]*( ending \d+)?:\s*/g, ' ').trim();
	const isGreeting = /^(hello|hi|hey)[\s,.!]*$/i.test(body);
	const soundsLikeQuestion = /[?]\s*$/.test(body) || /^(who|what|can|could|are|is|anyone|anybody)\b/i.test(body) || isGreeting;
	if (!soundsLikeQuestion) return false;
	return /\b(any ?one|any ?body|every ?one|everybody|you guys|you all|y'?all|agents?|bots?|can you hear|are you there|is anyone|hello|still there|who(?:['’]s| is| are)? (?:here|there|you|on the line)|what(?:['’]s| is) happening)\b/i.test(body);
}
const QUIET_MS = 1000; // speak once they have paused this long (1.5 s on a group call: more voices, longer gaps)
const TURN_CWD = `${HOME}/.local/share/agent-phone/turn-cwd`;
mkdirSync(TURN_CWD, { recursive: true });
const CALL_LOGS = `${HOME}/.local/share/agent-phone/calls`;
mkdirSync(CALL_LOGS, { recursive: true });
/** How speech recognition hears each agent's name, so a mangled name still counts as addressed. */
const NAME_ALIASES = {
	riotcoder: ['riotcoder', 'riot coder', 'riot', 'codex', 'rycoder', 'ryokoder', 'ryecoder', 'rioter', 'riot code', 'ryan coder'],
	cha0spunk: ['cha0spunk', 'chaospunk', 'chaos punk', 'chaos', 'che 0 spunk', 'cheos punk', 'kaos punk', 'chaosbunk', 'k o spunk'],
	rootkey: ['rootkey', 'root key', 'security'],
	coinpay: ['coinpay', 'coin pay', 'cfo', 'accountant'],
	knox: ['knox', 'knocks', 'sales'],
	nora: ['nora', 'nora coach', 'career coach', 'workplace coach'],
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
/**
 * The floor, shared by our agents on this box: one file per room, touched by whoever
 * speaks. A line meant for nobody in particular gets one agent answering, not two.
 */
const floorFile = (pin) => `${CALL_LOGS}/floor-${pin}.json`;
/** Who holds the floor in this room right now (an agent mid-sentence), or ''. */
function floorHolder(pin) {
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
/** Hold the floor for about as long as the line takes to say (ElevenLabs reads ~14 chars a second). */
function takeFloor(pin, agent, text = '') {
	try {
		writeFileSync(floorFile(pin), JSON.stringify({ agent, at: Date.now(), until: Date.now() + 2500 + (String(text).length / 14) * 1000 }));
	} catch {}
}
/** The other agent speaking now or within `afterMs` of finishing: its words, not a person's. */
function otherAgentTalking(pin, agent, afterMs = 1500) {
	try {
		const f = JSON.parse(readFileSync(floorFile(pin), 'utf8'));
		if (f.agent === agent) return '';
		if (f.until > Date.now()) return f.agent;
		return Date.now() - statSync(floorFile(pin)).mtimeMs < afterMs ? f.agent : '';
	} catch {
		return '';
	}
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
function releaseFloor(pin, agent) {
	try {
		if (floorHolder(pin) === agent) {
			const f = JSON.parse(readFileSync(floorFile(pin), 'utf8'));
			writeFileSync(floorFile(pin), JSON.stringify({ ...f, until: 0 }));
		}
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
async function brain(agent, prompt) {
	const selected = await configuredTurn(agent, prompt);
	if (selected.trim()) return selected;
	// Keep the existing short-latency providers as fallbacks if the selected engine is unavailable.
	if (CF_ACCOUNT && CF_TOKEN) {
		try {
			const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${process.env.AGENT_PHONE_CF_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast'}`, {
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
	if (GEMINI_KEY) {
		try {
			const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.AGENT_PHONE_GEMINI_MODEL || 'gemini-flash-lite-latest'}:generateContent`, {
				method: 'POST',
				headers: { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' },
				body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 300 } }),
				signal: AbortSignal.timeout(8000),
			});
			const data = await res.json();
			const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
			if (res.ok && text) return text;
		} catch {}
	}
	return '';
}

function configuredTurn(agent, prompt) {
	return new Promise((resolve) => {
		let output = '';
		let settled = false;
		const child = spawn('agent-llm', [agent, 'chat'], { cwd: TURN_CWD, stdio: ['pipe', 'pipe', 'ignore'] });
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
const TASK_CHAT = { riotcoder: '6f1191b7-4dbf-4f31-b78e-8525880c1b2f', cha0spunk: '6f1191b7-4dbf-4f31-b78e-8525880c1b2f' };

/** Queue work for the agent's own task runner (riotcoder-qc-sweep --tasks), which reports in qrypt.chat. */
function queueTask(agent, ack, brief, said) {
	const dir = `${HOME}/.local/share/${agent}-qc`;
	const task = {
		chat_id: TASK_CHAT[agent],
		chat_title: 'Agents',
		ack,
		brief,
		cleared: null,
		messages: `[${new Date().toISOString()}] (Anthony said this on a group.call phone call; transcribed, words may be wrong) ${said}`,
	};
	appendFileSync(`${dir}/tasks.jsonl`, JSON.stringify(task) + '\n');
	execFile(`${HOME}/.local/bin/riotcoder-qc-sweep`, ['--tasks'], { env: { ...process.env, QC_AGENT: agent } }, () => {});
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
	if (!TELNYX_KEY || !AGENT_APP || !SECRET) throw new Error('Missing TELNYX_API_KEY / TELNYX_AGENT_APP_ID / AGENT_PHONE_SECRET in ~/www/qrypt.chat/app.env');
	const to = checkNumber(a._[1]);
	const agent = typeof a.agent === 'string' ? a.agent : process.env.QC_AGENT || 'riotcoder';
	/** Sent by a room's greeter setting: keep an early caller company until the host joins, then leave. */
	const greeter = join && a.role === 'greeter';
	const maxMinutes = Math.min(join ? 60 : 30, Math.max(1, Number(a['max-minutes']) || (join ? 30 : 10)));
	const persona = a.podcast
		? (agent === 'riotcoder' ? 'Codex, an AI assistant and co-host.' : 'Chaospunk, an AI assistant and co-host.')
		: (() => {
			for (const p of [`${HOME}/.config/${agent}-qc/persona.md`, `${HOME}/.config/agent-identities/${agent}/AGENTS.md`]) {
				try {
					const text = read(p).trim();
					if (text) return text;
				} catch {}
			}
			return `${DISPLAY_NAMES[agent] || agent}, Anthony's AI agent.`;
		})();
	const turnTemplate = join ? (a.podcast ? 'podcast-turn.md' : 'group-turn.md') : 'phone-turn.md';
	const template = read(`${HOME}/.config/qc-agents/${turnTemplate}`);
	const voice = voiceFor(agent, fromWorkerEnv('AGENT_PHONE_VOICE') || '');
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
		// The room welcomes us and says who is there; speak after that.
		setTimeout(() => turn(), 9000).unref();
	};

	const act = (path, body) => telnyx(`/calls/${encodeURIComponent(ccid)}/actions/${path}`, body);
	const speak = async (text) => {
		try {
			appendFileSync(logFile, `${new Date().toISOString().slice(11, 23)} [spoke-start]\n`);
		} catch {}
		spoken.push({ text, at: Date.now() });
		if (spoken.length > 4) spoken.shift();
		speaking = true;
		const armSpeechWatchdog = () => {
			clearTimeout(speakWatchdog);
			speakWatchdog = setTimeout(() => {
				speaking = false;
				if (join) releaseFloor(a.pin, agent);
				try { appendFileSync(logFile, `${new Date().toISOString().slice(11, 23)} [speak-timeout]\n`); } catch {}
			}, 30_000).unref();
		};
		armSpeechWatchdog();
		const request = speechRequest(text, voice);
		try {
			await act('speak', request);
		} catch (e) {
			if (voice.startsWith('ElevenLabs.')) {
				if (!a.json) console.error(`(ElevenLabs voice failed: ${e.message}; using ${FALLBACK_VOICE})`);
				try {
					await act('speak', { payload: text, voice: FALLBACK_VOICE });
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
		if (roomQuestion(newest)) return '\n\nTHE NEWEST LINE IS A PERSON ASKING THE ROOM (that includes you). Answer it now with SAY, briefly, even if a similar question was answered earlier in the call. Do not PASS.';
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
		try {
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
				.replace('{intro}', !shouldIntroduce(agent, transcript, Date.now())
					? 'You have already introduced yourself on this call: do not do it again.'
					: join && rejoin
						? 'You were on this call earlier and just reconnected; the transcript above is what was said. Do NOT introduce yourself again and do not announce that you are back unless someone asks. Otherwise follow the rules below as usual: answer people when they talk to you or ask the room something.'
						: join
						? `You just joined. Unless someone is mid-sentence, say a short hello: "Hi everyone, ${agent} here, Anthony's AI agent." Do not PASS on this first turn.`
						: `In this first line, say who you are: "Hi, this is ${agent}, an AI assistant calling for Anthony."`);
			const t0 = Date.now();
			const heardBefore = transcript.filter((t) => t.who === 'them').length;
			const firstTurn = join && shouldIntroduce(agent, transcript, Date.now());
			let raw = firstTurn && !a.podcast ? `SAY: ${agentIntro(agent)}` : await brain(agent, prompt);
			let { kind, text, brief: turnBrief, number: callNumber, message: textMessage } = parseTurn(raw);
			if (firstTurn && !text && !ended) {
				// The hello is not optional: one more try before going quiet.
				raw = await brain(agent, prompt);
				({ kind, text, brief: turnBrief, number: callNumber, message: textMessage } = parseTurn(raw));
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
				takeFloor(a.pin, agent, text);
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
				const otherAgent = join ? otherAgentTalking(a.pin, agent) : '';
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
	const until = Date.now() + (Number(a.for) || 55) * 1000;
	const post = (path, body) =>
		fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
	const running = [];
	/** Run one agent into one room, report how it went, and dial back once after an unplanned drop. */
	const dialJob = (job) =>
		new Promise((resolve) => {
			const podcast = job.room_name === 'TUI Weekly';
			let brief = job.brief;
			if (podcast) { try { brief = read(`${HOME}/.config/qc-agents/tuiweekly-brief.md`).trim() || brief; } catch {} }
			execFile(
				process.argv[1],
				['join', job.dial_in, '--pin', job.code, '--agent', job.agent, '--room', job.room_name, '--goal', brief, '--json', ...(podcast ? ['--podcast'] : []), ...(job.from ? ['--from', job.from] : []), ...(job.role ? ['--role', job.role] : [])],
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
			if (!TASK_CHAT[task.agent]) continue;
			console.log(`${new Date().toISOString()} ${task.agent} task from ${task.code}: ${String(task.brief).slice(0, 120)}`);
			queueTask(task.agent, task.ack || 'On it.', task.brief, task.said);
		}
		const res = await post('/api/v1/agent-queue/next').catch(() => null);
		if (!res || res.status === 204 || !res.ok) {
			await new Promise((r) => setTimeout(r, 3000));
			continue;
		}
		const job = await res.json();
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
