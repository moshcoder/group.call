/**
 * Server-rendered pages. One small script (public/app.js) keeps a room page live
 * (who is on the line, as they come and go) and copies text; everything else
 * works without it.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AgentInvite, Line, Pass, Recording, Room, RoomEvent, User } from './db.js'
import { pitFooter } from './pit-footer.js'
import { RING_PLACEHOLDER } from './ring.js'
import { ringFooter } from './ring-footer.js'
import { AGENTS, CODE_LENGTH, FREE_ROOMS, formatNumber, INVITE_BONUS_MINUTES, PASS_DAYS, PASS_ROOMS, PASS_USD, telLink } from './service.js'

export const SITE = 'https://group.call.pit.world'
export const REPO = 'https://github.com/moshcoder/group.call'
const ENGINE = 'https://github.com/profullstack/group-call'

const TRACKER_SITE = process.env.CRAWLPROOF_SITE_ID ?? ''
const TRACKER = TRACKER_SITE && TRACKER_SITE !== 'off' ? `<script data-site="${TRACKER_SITE}" src="https://crawlproof.com/stats.js" async></script>` : ''

const asset = (name: string) => {
  const body = readFileSync(new URL(`../public/${name}`, import.meta.url))
  return `/${name}?v=${createHash('sha256').update(body).digest('hex').slice(0, 10)}`
}
const STYLE_URL = asset('style.css')
const SCRIPT_URL = asset('app.js')

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M9.5 4.5c1.2 0 2.2.8 2.5 2l1 4c.2 1-.1 2-.9 2.6l-2 1.6a15 15 0 0 0 7.2 7.2l1.6-2c.6-.8 1.6-1.1 2.6-.9l4 1c1.2.3 2 1.3 2 2.5V26c0 1.4-1.1 2.5-2.5 2.5C14.4 28.5 3.5 17.6 3.5 7c0-1.4 1.1-2.5 2.5-2.5z" fill="currentColor"/><circle cx="22" cy="6" r="2" fill="currentColor"/><circle cx="27" cy="11" r="2" fill="currentColor"/><circle cx="20" cy="12" r="2" fill="currentColor"/></svg>`

export type Ctx = { user: User | null; csrf: string; dialIn: string; agents: boolean; callPhones?: boolean; passUntil: number | null }

type LayoutOptions = { title: string; description: string; path: string; body: string; ctx: Ctx; noindex?: boolean; script?: boolean }

function layout(o: LayoutOptions): string {
  const signedIn = Boolean(o.ctx.user)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#07090c">
${o.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(SITE + o.path)}">`}
<meta property="og:type" content="website">
<meta property="og:site_name" content="group.call">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="stylesheet" href="${STYLE_URL}">
<script src="${SCRIPT_URL}" defer></script>
${TRACKER}
</head>
<body>
${RING_PLACEHOLDER}
<header class="top">
  <a class="brand" href="/">${LOGO}<span>group<b>.</b>call</span></a>
  <nav aria-label="Site">
    <a href="/rooms">Rooms</a>
    ${signedIn ? '<a href="/invites">Invites</a>' : ''}
    <a href="/help">Help</a>
    ${signedIn ? `<a href="/me">Account</a><form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${esc(o.ctx.csrf)}"><button class="linkish">Sign out</button></form>` : '<a href="/auth/start">Sign in</a>'}
  </nav>
</header>
<main>
${o.body}
</main>
${ringFooter()}
${pitFooter()}
</body>
</html>`
}

/**
 * What to paste into a text or an email. Plain words only: a tel: link with its
 * pauses and an encoded # reads as gibberish there, and every phone already turns
 * the number into something you can tap.
 */
export const invitation = (name: string, dialIn: string, code: string) => `Join "${name}" on group.call: call ${formatNumber(dialIn)}, then key ${code}#`

const csrfField = (ctx: Ctx) => `<input type="hidden" name="csrf" value="${esc(ctx.csrf)}">`
const flashNote = (flash?: string, error = false) => (flash ? `<p class="note${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">${esc(flash)}</p>` : '')
const signInButton = (next = 'rooms', label = 'Sign in with CoinPay') => `<a class="button" href="/auth/start?next=/${next}">${esc(label)}</a>`

const dialBlock = (ctx: Ctx, code?: string) => {
  const number = formatNumber(ctx.dialIn)
  return `<div class="dial">
  <p class="label">Call</p>
  <p class="number"><a href="tel:${esc(ctx.dialIn)}">${esc(number)}</a></p>
  ${code ? `<p class="label">then key</p><p class="code" aria-label="Room code ${esc(code.split('').join(' '))}">${esc(code)}</p><p><a class="button" href="${esc(telLink(ctx.dialIn, code))}">Call and join from this phone</a></p>` : `<p class="hint">and key your room's ${CODE_LENGTH}-digit code.</p>`}
</div>`
}

export function homePage(ctx: Ctx): string {
  return layout({
    ctx,
    path: '/',
    title: 'group.call: a party line for people and AI agents',
    description: `Make a room, get a ${CODE_LENGTH}-digit code. Everyone dials one number and keys it: people on their phones, and AI agents with names and real voices. No app, no link, no account to join.`,
    body: `<section class="hero">
  <h1>A party line for people and AI agents.</h1>
  <p class="lede">Make a room and get a ${CODE_LENGTH}-digit code. Everyone dials one number and keys it. People join from any phone. Agents phone in too, with names and real voices, and talk like everyone else.</p>
  ${dialBlock(ctx)}
  <p>${ctx.user ? '<a class="button" href="/rooms">Your rooms</a>' : signInButton('rooms', 'Make a room: sign in with CoinPay')}</p>
</section>
<section class="cards">
  <article><h2>Any phone</h2><p>No app, no link, no browser tab. A landline works. So does a car. The code is the whole invitation: say it out loud.</p></article>
  <article><h2>Agents on the call</h2><p>Ask an agent into the room and it dials the same number, keys the code and introduces itself. It hears everyone and answers out loud.</p></article>
  <article><h2>For your agents too</h2><p>An API, a CLI and an MCP server: make rooms, see who is on, say something into the room, and have your own agent dial in under its own name.</p></article>
</section>
<section class="steps">
  <h2>How it works</h2>
  <ol>
    <li><strong>Sign in with CoinPay</strong> and make a room. You get a code like <code>4821</code>.</li>
    <li><strong>Send people the number and the code.</strong> On a phone, the room page has a one-tap link that dials and keys it for you.</li>
    <li><strong>Watch the room live:</strong> who is on, agents arriving, lines said into the room.</li>
  </ol>
  <p>${FREE_ROOMS} rooms free. A room pass is $${PASS_USD} for ${PASS_DAYS} days: up to ${PASS_ROOMS} rooms, and you pick the codes. Paid through CoinPay in any coin or PayPal.</p>
</section>`,
  })
}

export function roomsPage(ctx: Ctx, data: { rooms: Room[]; live: Record<string, number>; limit: number; passes: Pass[]; flash?: string; error?: string; values?: Record<string, string> }): string {
  const v = data.values ?? {}
  const pass = ctx.passUntil
  const list = data.rooms.length
    ? `<ul class="rooms">${data.rooms
        .map(
          (r) => `<li><a href="/r/${esc(r.code)}"><span class="code">${esc(r.code)}</span> <span class="name">${esc(r.name)}</span></a> <span class="muted">${data.live[r.code] ? `${data.live[r.code]} on the line` : r.lastUsedAt ? `last call ${day(r.lastUsedAt)}` : 'not used yet'}</span></li>`,
        )
        .join('')}</ul>`
    : '<p class="muted">No rooms yet. Make one below.</p>'
  return layout({
    ctx,
    path: '/rooms',
    noindex: true,
    title: 'Your rooms · group.call',
    description: 'Your group call rooms.',
    body: `<h1>Your rooms</h1>
${flashNote(data.flash)}${flashNote(data.error, true)}
${list}
<form method="post" action="/rooms" class="stack">
  ${csrfField(ctx)}
  <h2>New room</h2>
  <label>Name <input name="name" maxlength="60" placeholder="Monday standup" value="${esc(v.name ?? '')}"></label>
  ${pass ? `<label>Code <span class="muted">(optional, ${CODE_LENGTH} digits)</span> <input name="code" inputmode="numeric" pattern="[0-9]{${CODE_LENGTH}}" maxlength="${CODE_LENGTH}" value="${esc(v.code ?? '')}"></label>` : ''}
  <button>Make a room</button>
  <p class="muted">${data.rooms.length} of ${data.limit} rooms used.</p>
</form>
<section class="pass">
  <h2>Room pass</h2>
  ${pass ? `<p>Your pass runs until <strong>${day(pass)}</strong>: up to ${PASS_ROOMS} rooms, and you pick the codes.</p>` : `<p>$${PASS_USD} for ${PASS_DAYS} days: up to ${PASS_ROOMS} rooms instead of ${FREE_ROOMS}, and you pick the codes. Pay in any coin or PayPal on CoinPay.</p>`}
  <form method="post" action="/pass">${csrfField(ctx)}<button>${pass ? 'Add 30 more days' : `Buy a pass ($${PASS_USD})`}</button></form>
  ${data.passes.length ? `<ul class="muted small">${data.passes.slice(0, 5).map((p) => `<li><a href="/pass/${esc(p.id)}">${day(p.createdAt)}</a>: $${(p.amountCents / 100).toFixed(2)}, ${esc(p.status)}</li>`).join('')}</ul>` : ''}
</section>
${dialBlock(ctx)}`,
  })
}

const lineHtml = (l: Line) => `<li class="${esc(l.kind)}"><span class="muted">${esc(when(l.at).slice(11, 16))}</span> <b>${esc(l.who)}</b>${l.kind === 'typed' ? ' <span class="muted">(typed)</span>' : ''} ${esc(l.text)}</li>`

export function roomPage(ctx: Ctx, data: { room: Room; owner: boolean; live: { name: string; kind: string; since: number }[]; events: RoomEvent[]; invites: AgentInvite[]; transcript: Line[]; recordings?: Recording[]; canRecord?: boolean; flash?: string; error?: string }): string {
  const r = data.room
  const people = data.live.length
    ? data.live.map((p) => `<li class="${esc(p.kind)}"><span class="dot" aria-hidden="true"></span>${esc(p.name)} <span class="muted">${p.kind === 'agent' ? 'agent' : 'on the phone'}</span></li>`).join('')
    : '<li class="empty muted">Nobody on the line.</li>'
  const log = data.events.length
    ? data.events
        .map((e) => `<li><span class="muted">${esc(when(e.at).slice(11, 16))}</span> ${esc(e.who)} ${e.kind === 'join' ? 'joined' : e.kind === 'leave' ? 'left' : e.kind === 'invite' || e.kind === 'quality' ? esc(e.text) : `said: “${esc(e.text)}”`}</li>`)
        .join('')
    : '<li class="muted">Nothing yet.</li>'
  const ownerTools = data.owner
    ? `<section>
  <h2>Say something</h2>
  <p class="muted">Read aloud to everyone on the line.</p>
  <form method="post" action="/r/${esc(r.code)}/say" class="row">${csrfField(ctx)}<input name="text" maxlength="500" required placeholder="We'll start in two minutes." aria-label="What to say"><button>Say it</button></form>
</section>
${
  data.owner && ctx.callPhones
    ? `<section>
  <h2>Call someone in</h2>
  <p class="muted small">The room rings their phone from ${esc(formatNumber(ctx.dialIn))}. They pick up, press 1, and they are in. No code to key. Anyone already on the line can do it too: press <b>*</b>, their number, then <b>#</b>.</p>
  <form method="post" action="/r/${esc(r.code)}/call" class="row">${csrfField(ctx)}<input name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="408-555-0101" aria-label="Phone number"><input name="name" maxlength="40" placeholder="Name (optional)" aria-label="Their name"><button>Call them in</button></form>
</section>`
    : ''
}
${
  ctx.agents
    ? `<section>
  <h2>Ask an agent in</h2>
  <div class="agents">${Object.entries(AGENTS)
    .map(([name, a]) => `<form method="post" action="/r/${esc(r.code)}/invite">${csrfField(ctx)}<input type="hidden" name="agent" value="${esc(name)}"><button class="secondary">Invite ${esc(name)}</button><span class="muted small">${esc(a.about)}</span></form>`)
    .join('')}</div>
  ${data.invites.length ? `<ul class="muted small">${data.invites.slice(0, 5).map((i) => `<li>${esc(i.agent)}: ${esc(i.status)}${i.note ? ` (${esc(i.note)})` : ''}, ${esc(when(i.createdAt).slice(11, 16))}</li>`).join('')}</ul>` : ''}
</section>`
    : ''
}
${
  data.canRecord
    ? `<section>
  <h2>Record</h2>
  <p class="muted small">${r.record ? 'This room records every call on it: everyone, mixed into one mp3, saved here when the call ends.' : 'Record every call in this room to an mp3, saved here when the call ends. Tell people they are being recorded.'}</p>
  <form method="post" action="/r/${esc(r.code)}/record">${csrfField(ctx)}<input type="hidden" name="on" value="${r.record ? '0' : '1'}"><button class="${r.record ? 'secondary' : ''}">${r.record ? 'Stop recording calls' : 'Record calls'}</button></form>
  ${
    data.recordings?.length
      ? `<ul class="recordings">${data.recordings
          .slice(0, 20)
          .map((rec) => {
            const mins = rec.durationSecs !== null ? `${Math.round(rec.durationSecs / 60)} min` : ''
            const label = `${esc(when(rec.startedAt).slice(0, 16).replace('T', ' '))} ${mins ? `· ${mins}` : ''}`
            return rec.status === 'ready'
              ? `<li>${label} · <a href="/r/${esc(r.code)}/rec/${esc(rec.id)}.mp3" download>mp3</a><br><audio controls preload="none" src="/r/${esc(r.code)}/rec/${esc(rec.id)}.mp3"></audio></li>`
              : `<li class="muted">${label} · ${esc(rec.status)}${rec.note ? ` (${esc(rec.note)})` : ''}</li>`
          })
          .join('')}</ul>`
      : ''
  }
</section>`
    : ''
}
<details>
  <summary>Rename or delete</summary>
  <form method="post" action="/r/${esc(r.code)}/rename" class="row">${csrfField(ctx)}<input name="name" maxlength="60" value="${esc(r.name)}" aria-label="Room name"><button class="secondary">Rename</button></form>
  <form method="post" action="/r/${esc(r.code)}/delete">${csrfField(ctx)}<button class="danger">Delete this room</button> <span class="muted small">Anyone on the line is hung up and the code is freed.</span></form>
</details>`
    : ''
  return layout({
    ctx,
    path: `/r/${r.code}`,
    noindex: true,
    title: `${r.name} · group.call`,
    description: `Dial ${formatNumber(ctx.dialIn)} and key ${r.code} to join ${r.name}.`,
    body: `<h1>${esc(r.name)}</h1>
${flashNote(data.flash)}${flashNote(data.error, true)}
<div class="split">
  ${dialBlock(ctx, r.code)}
  <section class="live" data-live="/r/${esc(r.code)}/live">
    <h2>On the line <span class="count" data-count>${data.live.length}</span></h2>
    <ul class="people" data-people>${people}</ul>
    <h3>Activity</h3>
    <ul class="log" data-log>${log}</ul>
  </section>
</div>
<section class="transcript">
  <h2>Transcript <span class="muted small">live</span></h2>
  <ol class="lines" data-lines>${data.transcript.length ? data.transcript.map(lineHtml).join('') : '<li class="muted empty">Nothing said yet. What people and agents say on the line shows up here as they say it.</li>'}</ol>
  <p class="small"><a href="/r/${esc(r.code)}/transcript.txt">Download the transcript</a> · <span class="muted">transcribed by machine, so names and words can be wrong</span></p>
</section>
<p><button class="secondary" data-copy="${esc(invitation(r.name, ctx.dialIn, r.code))}">Copy the invitation</button></p>
${ownerTools}`,
  })
}

export function mePage(ctx: Ctx, data: { apiKey?: string; flash?: string; minutes?: { used: number; free: number; credits: number; left: number; unlimited: boolean } }): string {
  const m = data.minutes
  const u = ctx.user!
  return layout({
    ctx,
    path: '/me',
    noindex: true,
    title: 'Account · group.call',
    description: 'Your group.call account and API key.',
    body: `<h1>Account</h1>
${flashNote(data.flash)}
<p>Signed in with CoinPay as <strong>${esc(u.name || u.email)}</strong>${u.email ? ` (${esc(u.email)})` : ''}.</p>
<section>
  <h2>Call minutes</h2>
  ${m ? (m.unlimited ? `<p>${m.used} minutes used this month. No limit on this account.</p>` : `<p><strong>${Math.round(m.left)}</strong> minutes left this month: ${m.free} free${m.credits ? ` + ${m.credits} from codes` : ''}, ${m.used} used.</p>`) : ''}
  <form method="post" action="/me/redeem" class="row">${csrfField(ctx)}<input name="code" required placeholder="Have a code? CR-XXXX-XXXX-XXXX" aria-label="Credit code" autocomplete="off"><button>Redeem</button></form>
</section>
<section>
  <h2>API key</h2>
  <p>For the CLI, the MCP server and the API. Making a new key retires the old one.</p>
  ${data.apiKey ? `<p class="note">Your new key, shown once:</p><pre class="copyable"><code>${esc(data.apiKey)}</code></pre><button class="secondary" data-copy="${esc(data.apiKey)}">Copy</button>` : u.apiKeyHash ? '<p class="muted">You have a key. Make a new one if you lost it.</p>' : ''}
  <form method="post" action="/me/key">${csrfField(ctx)}<button>${u.apiKeyHash ? 'Make a new key' : 'Make a key'}</button></form>
  <pre><code>export GROUPCALL_KEY=gc_…
bunx @profullstack/groupcall rooms
claude mcp add groupcall -e GROUPCALL_KEY=gc_… -- bunx @profullstack/groupcall mcp</code></pre>
</section>
<section>
  <h2>Delete your account</h2>
  <form method="post" action="/me/delete">${csrfField(ctx)}<button class="danger">Delete my account and rooms</button></form>
</section>`,
  })
}

export function invitedPage(ctx: Ctx): string {
  return layout({
    ctx,
    path: '/',
    noindex: true,
    title: "You're invited to group.call",
    description: 'A party line for people and AI agents.',
    body: `<section class="hero">
  <p class="label">Invite</p>
  <h1>You're invited to group.call.</h1>
  <p class="lede">A party line for people and AI agents: make a room, get a ${CODE_LENGTH}-digit code, and everyone dials one number. Sign in with CoinPay to accept. You and whoever invited you both get ${INVITE_BONUS_MINUTES} extra minutes.</p>
  ${ctx.user ? '<p class="muted">You are already signed in, so this invite is for someone new. Pass it on.</p>' : signInButton('rooms', 'Accept: sign in with CoinPay')}
</section>`,
  })
}

export function invitesPage(ctx: Ctx, data: { quota: { total: number; used: number; left: number }; invites: { id: string; createdAt: number; expiresAt: number | null; usedBy: string | null; usedAt: number | null; note: string }[]; affiliate: string; link?: string; error?: string }): string {
  return layout({
    ctx,
    path: '/invites',
    noindex: true,
    title: 'Invites · group.call',
    description: 'Your invite links.',
    body: `<h1>Invites</h1>
${flashNote(data.error, true)}
<p>You have <strong>${data.quota.left}</strong> of ${data.quota.total} invites left. Each link works once. When someone signs in through it, you both get ${INVITE_BONUS_MINUTES} extra minutes.</p>
${data.link ? `<p class="note">Your new invite link, shown once:</p><pre class="copyable"><code>${esc(data.link)}</code></pre><p><button class="secondary" data-copy="${esc(data.link)}">Copy the link</button></p>` : ''}
${data.quota.left > 0 ? `<form method="post" action="/invites" class="row">${csrfField(ctx)}<input name="note" maxlength="80" placeholder="Who is it for? (just for you)" aria-label="Note"><button>Make an invite link</button></form>` : ''}
${data.invites.length ? `<ul class="rooms">${data.invites.map((i) => `<li><span>${esc(i.note || 'invite')}</span> <span class="muted">${i.usedAt ? `used ${day(i.usedAt)}` : i.expiresAt && i.expiresAt < Date.now() ? 'expired' : `open, made ${day(i.createdAt)}`}</span></li>`).join('')}</ul>` : ''}
<section>
  <h2>Your link for everyone else</h2>
  <p>Share this anywhere. People who sign up through it are credited to you.</p>
  <pre class="copyable"><code>${esc(data.affiliate)}</code></pre><p><button class="secondary" data-copy="${esc(data.affiliate)}">Copy</button></p>
</section>`,
  })
}

export function passPage(ctx: Ctx, pass: Pass): string {
  return layout({
    ctx,
    path: `/pass/${pass.id}`,
    noindex: true,
    title: 'Room pass · group.call',
    description: 'Your room pass payment.',
    body: `<h1>Room pass</h1>
<section data-pass="/pass/${esc(pass.id)}.json" data-status="${esc(pass.status)}">
  ${
    pass.status === 'paid'
      ? `<p class="note">Paid. Your pass runs until <strong>${ctx.passUntil ? day(ctx.passUntil) : 'soon'}</strong>.</p><p><a class="button" href="/rooms">Back to your rooms</a></p>`
      : pass.status === 'pending'
        ? `<p>Waiting for CoinPay to see the payment. This page updates on its own.</p><p><a class="button" href="${esc(pass.checkoutUrl)}">Open the CoinPay checkout</a></p>`
        : `<p class="note error">This checkout ${esc(pass.status)}. <a href="/rooms">Start another</a>.</p>`
  }
</section>`,
  })
}

export function messagePage(ctx: Ctx, m: { title: string; message: string }): string {
  return layout({ ctx, path: '/', noindex: true, title: `${m.title} · group.call`, description: m.message, body: `<h1>${esc(m.title)}</h1><p>${esc(m.message)}</p><p><a href="/">Home</a></p>` })
}

export function helpPage(ctx: Ctx): string {
  const number = formatNumber(ctx.dialIn)
  return layout({
    ctx,
    path: '/help',
    title: 'Help, API, CLI and MCP · group.call',
    description: 'How group.call works, and how to drive it from the API, the CLI, the TUI and MCP, including having your own AI agent dial in.',
    body: `<h1>Help</h1>
<section>
  <h2>Joining</h2>
  <p>Call <a href="tel:${esc(ctx.dialIn)}">${esc(number)}</a> and key the room's ${CODE_LENGTH}-digit code when asked. If you key it before the prompt finishes, that is fine. A wrong code gets three tries.</p>
  <p>Or have the room call you: on a room's page, <b>Call someone in</b> rings any US or Canadian number from ${esc(number)}. Pick up, press 1, and you are in. From the call itself, anyone on the line (a person or an agent) presses <b>*</b>, the number, then <b>#</b>, and it rings them the same way; <b>*</b> again cancels. That comes with a room pass.</p>
  <p>On a phone, a room's page has a link that dials and keys the code for you (<code>tel:${esc(ctx.dialIn)},,,4821#</code>).</p>
</section>
<section>
  <h2>Rooms</h2>
  <p>Sign in with CoinPay to make rooms. ${FREE_ROOMS} are free. A room pass is $${PASS_USD} for ${PASS_DAYS} days and gives you ${PASS_ROOMS} rooms and codes you choose. Up to 20 people or agents per room.</p>
</section>
<section id="agents">
  <h2>Agents</h2>
  <p>An agent joins the way a person does: it places a phone call to ${esc(number)}, keys the code with touch tones, then listens (speech to text) and talks (text to speech) on that call. Our agents (riotcoder and cha0spunk) do this with ElevenLabs voices. Room owners on this instance can invite them from the room page.</p>
  <p>Your own agent can do the same from any telephony API (Telnyx, Twilio, ...). To have the room announce it by name, tell us the number it will call from, just before it dials:</p>
  <pre><code>curl -X POST ${SITE}/api/v1/rooms/4821/expect \\
  -H "authorization: Bearer $GROUPCALL_KEY" -H 'content-type: application/json' \\
  -d '{"name":"my-agent","from":"+15551234567"}'</code></pre>
  <p>An agent that cannot place calls can still speak into a room: <code>POST /api/v1/rooms/4821/say {"text":"…"}</code> reads the line aloud to everyone on the phone.</p>
</section>
<section>
  <h2>API</h2>
  <p>Make a key on <a href="/me">your account page</a> and send it as <code>authorization: Bearer gc_…</code>.</p>
  <table>
    <tr><td><code>GET /api/v1/me</code></td><td>you, your rooms, your pass</td></tr>
    <tr><td><code>GET /api/v1/rooms</code></td><td>your rooms, with how many are on each</td></tr>
    <tr><td><code>POST /api/v1/rooms</code></td><td><code>{"name"}</code> (and <code>"code"</code> with a pass): a new room</td></tr>
    <tr><td><code>GET /api/v1/rooms/:code</code></td><td>a room: who is on the line, recent activity</td></tr>
    <tr><td><code>PATCH /api/v1/rooms/:code</code></td><td><code>{"name"}</code></td></tr>
    <tr><td><code>DELETE /api/v1/rooms/:code</code></td><td>hangs everyone up and frees the code</td></tr>
    <tr><td><code>POST /api/v1/rooms/:code/say</code></td><td><code>{"text", "as"?}</code>: read aloud into the room</td></tr>
    <tr><td><code>POST /api/v1/rooms/:code/expect</code></td><td><code>{"name", "from"}</code>: name the next caller from that number</td></tr>
    <tr><td><code>POST /api/v1/rooms/:code/call</code></td><td><code>{"phone", "name"?}</code>: ring a phone into the room; they press 1 to join (pass)</td></tr>
    <tr><td><code>POST /api/v1/rooms/:code/agents</code></td><td><code>{"agent"}</code>: ask riotcoder or cha0spunk in (operators)</td></tr>
    <tr><td><code>GET /r/:code/live</code></td><td>server-sent events as people come and go (signed in)</td></tr>
  </table>
</section>
<section>
  <h2>CLI, TUI and MCP</h2>
  <pre><code>export GROUPCALL_KEY=gc_…
bunx @profullstack/groupcall              # the TUI: rooms and who is on them
bunx @profullstack/groupcall new "Standup"
bunx @profullstack/groupcall who 4821
bunx @profullstack/groupcall say 4821 "starting now"
bunx @profullstack/groupcall call 4821 408-555-0101 Anthony
bunx @profullstack/groupcall invite 4821 riotcoder
claude mcp add groupcall -e GROUPCALL_KEY=gc_… -- bunx @profullstack/groupcall mcp</code></pre>
  <p>Or <code>curl -fsSL ${SITE}/install.sh | sh</code>. The desktop app (Mac, Windows, Linux) comes with the CLI inside: <a href="${REPO}/releases">releases</a>. On a phone, add this site to your home screen.</p>
</section>
<section>
  <h2>Open source</h2>
  <p>This site: <a href="${REPO}">${REPO.replace('https://', '')}</a>. The phone engine, shared with nixamp's party line: <a href="${ENGINE}">@profullstack/group-call</a>.</p>
</section>`,
  })
}

export const installScript = () => `#!/bin/sh
# group.call CLI: https://group.call.pit.world
set -e
if command -v bun >/dev/null 2>&1; then bun add -g @profullstack/groupcall
else curl -fsSL https://bun.sh/install | bash && "$HOME/.bun/bin/bun" add -g @profullstack/groupcall; fi
echo "groupcall installed. Make a key at ${SITE}/me, then: export GROUPCALL_KEY=gc_..."
`
