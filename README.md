# group.call

**A party line for people and AI agents.** Make a room and get a four-digit code.
Everyone dials one number and keys it. People join from any phone, and AI agents
phone in too, with names and real voices.

**https://group.call.pit.world** · dial **510-616-9327**

- **Web and PWA:** sign in with CoinPay, make rooms, and watch who is on the line live.
  On a phone, a room's page has a one-tap link that dials and keys the code. Add it to
  your home screen.
- **Desktop:** Mac, Windows and Linux, with the CLI inside
  ([releases](https://github.com/moshcoder/group.call/releases)).
- **CLI and TUI:** `bunx @profullstack/groupcall`.
- **MCP:** `claude mcp add groupcall -e GROUPCALL_KEY=gc_… -- bunx @profullstack/groupcall mcp`.
- **API:** see [/help](https://group.call.pit.world/help).

```sh
export GROUPCALL_KEY=gc_…            # from https://group.call.pit.world/me
groupcall new "Monday standup"       # -> 4821; call 510-616-9327 and key 4821
groupcall who 4821
groupcall say 4821 "starting in two minutes"
groupcall contact add Kim --phone 408-555-0101
groupcall invite 4821 riotcoder, cha0spunk, Kim   # from your contacts: agents dial in, people are rung
groupcall expect 4821 my-bot +15551234567   # your own agent, named when it calls in
```

## How it works

The phone half is [@profullstack/group-call](https://github.com/profullstack/group-call),
the engine behind nixamp's party line. Telnyx Call Control answers the number, the caller
keys a code on the keypad, and the engine puts them in that room's Telnyx conference. This
app decides what a code means (a room someone made here), names callers it can, logs who
comes and goes, and streams that to the room page.

Our agents (riotcoder, cha0spunk) are ElevenLabs voice agents built with
[@profullstack/voice-agent](https://github.com/profullstack/voice-agent) (`src/agents.ts`):
Claude Sonnet with real turn-taking, dialled straight into the room over SIP with X-Gc-*
headers that say which room, who asked and why. During the call they act through group.call's
agent tools (`/api/agent-tools/*`: room_status, take_task, call_in, invite, text_room), each
allowed only when a trusted caller spoke in the last two minutes. take_task queues the work for
the agent's task runner, which posts the result to qrypt.chat. Deploy or update both with
`ELEVENLABS_API_KEY=... GROUPCALL_AGENT_TOOL_SECRET=... bun src/agents.ts`, then set the printed
`GROUPCALL_AGENT_SIP` and the secret in app.env. Without `GROUPCALL_AGENT_SIP` they fall back
to the older phone path below.

Agents can also join the way people do: they place a call to the number and key the code with DTMF.
The fallback for ours runs on the fleet box: a worker claims invites from
`POST /api/v1/agent-queue/next` and runs `agent-phone join`. That process speaks with
ElevenLabs voices through Telnyx and hears the room through Telnyx transcription. Anyone
else's agent can do the same from any telephony API, after naming itself with
`POST /api/v1/rooms/:code/expect`.

Calling someone in: the room rings any US or Canadian number from the dial-in, and whoever
answers presses 1 to join. From the room page (**Call someone in**), the CLI
(`groupcall call <code> <phone> [name]`), the TUI (`p` on a room), MCP (`call_phone`), the API
(`POST /api/v1/rooms/:code/call`), or from the call itself: anyone on the line, a person on
their keypad or an agent sending DTMF on its leg, presses `*`, the number, then `#` (`*` again
cancels). It needs the room owner's pass, and the keypad route rings 10 numbers an hour per room.

Contacts and inviting by name: each account keeps a contacts book of people (a phone) and
agents (one of ours, a SIP voice agent such as an ElevenLabs agent, or an agent on a phone
number, which joins on answer with no press 1), with aliases for how speech recognition
spells them ("chaos punk"). Operators have riotcoder and cha0spunk in their book without
saving them. On a call, a known caller (or a person the owner marked trusted) just says
**"invite riotcoder, cha0spunk and Kim"**: each name is matched against the room owner's
book, agents are queued, people are rung, and the room hears what happened ("Kim is not in
the contacts" when one is not). The same from the room page (**Invite from your contacts**),
`/me#contacts`, the CLI (`groupcall contacts`, `groupcall contact add|rm`, `groupcall invite
<code> <names...>`), the TUI (`n` on a room), MCP (`invite`, `list_contacts`, `add_contact`,
`remove_contact`) and the API (`GET|POST /api/v1/contacts`, `PATCH|DELETE
/api/v1/contacts/:id`, `POST /api/v1/rooms/:code/invite {names}`).

Sign-in is CoinPay OAuth only. Rooms: 3 free. A room pass costs $5 for 30 days and gives
50 rooms and codes you choose, paid through a CoinPay hosted checkout.

## Running it

Bun + Hono + bun:sqlite on dev2 at `/opt/group.call`, unit `group-call`, port 8810, behind
an exact-name nginx vhost with a cert from `pit-proxy-cert`. Deploy:
`ssh root@dev2 'cd /opt/group.call && git pull && ./bin/install.sh'`. Settings are in
`bin/install.conf`; secrets go in `~/.local/share/group-call/app.env` from the vault.

### Live Nixamp broadcast

Set `GROUPCALL_BROADCAST_NIXAMP_URL` and `GROUPCALL_BROADCAST_NIXAMP_TOKEN` to enable
a receive-only live broadcast. When Riotcoder joins a room, Telnyx forks both audio
tracks to `/api/v1/broadcast/stream`; group.call mixes and encodes them as MP3 and
keeps Nixamp's `/api/ingest` request open until the call ends. Set
`GROUPCALL_BROADCAST_STREAM_URL` when the public WebSocket URL differs from the
group.call origin. The relay stays disabled unless both Nixamp settings are present.

### Least-cost routing

Phones a room rings go out on the cheapest route that carries the number
([least-cost routing](https://en.wikipedia.org/wiki/Least-cost_routing)), see `src/routing.ts`.
A route is a Telnyx call-control app (tied to an outbound voice profile) with a rate deck:
destination prefix to USD a minute, longest prefix wins. If a route will not place the call,
the next cheapest is tried. A prefix priced `null` (or `-` in a CSV deck) is blocked, the empty
prefix `""` prices everything else, and nothing above `GROUPCALL_MAX_RATE` (default $1/min) is
ever dialled.

With only `TELNYX_CONNECTION_ID` set there is one route to every country: the US and Canada at
$0.007/min, everywhere else (Caribbean `+1` area codes included) estimated at $0.25/min, premium
900/976 blocked. Telnyx's `call.cost` webhook (turn on `call_cost_in_webhooks` on the call-control
app) says what each call really cost; that rate is learned per route and number prefix and beats
the deck from then on.

**Daily budget.** Every call the instance places (phones and SIP agents, all rooms together) may
cost `GROUPCALL_DAILY_SPEND_USD` a UTC day, default $5. Spend = Telnyx's figure for priced calls
plus minutes so far x rate for the rest. At the cap new calls are refused (429) and a watchdog
hangs up running ones within 15 s. Back it with the same limit on the Telnyx side: the group.call
app has its own outbound voice profile with a $5 daily spend limit, so a bug here still cannot
drain the account.

To add providers or prices, point `GROUPCALL_ROUTES` at a JSON file:

```json
{
  "maxRate": 0.05,
  "routes": [
    { "provider": "telnyx", "connectionId": "3079268685966215111", "rates": { "1": 0.007 } },
    { "provider": "telnyx-intl", "connectionId": "…", "from": "+44…", "deck": "intl.csv", "rates": { "1876": null } }
  ]
}
```

`deck` is a carrier rate deck (`prefix,rate` per line), read relative to the file; inline
`rates` override it. Every room-placed call must also be allowed by its outbound voice
profile's country whitelist on Telnyx. Quote before dialling: `groupcall rates +442079460000`,
`GET /api/v1/rates?phone=`, MCP `quote_call`.

MIT
