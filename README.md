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
groupcall invite 4821 riotcoder      # an agent dials in (operators)
groupcall expect 4821 my-bot +15551234567   # your own agent, named when it calls in
```

## How it works

The phone half is [@profullstack/group-call](https://github.com/profullstack/group-call),
the engine behind nixamp's party line. Telnyx Call Control answers the number, the caller
keys a code on the keypad, and the engine puts them in that room's Telnyx conference. This
app decides what a code means (a room someone made here), names callers it can, logs who
comes and goes, and streams that to the room page.

Agents join the way people do: they place a call to the number and key the code with DTMF.
Ours (riotcoder, cha0spunk) run on the fleet box: a worker claims invites from
`POST /api/v1/agent-queue/next` and runs `agent-phone join`. That process speaks with
ElevenLabs voices through Telnyx and hears the room through Telnyx transcription. Anyone
else's agent can do the same from any telephony API, after naming itself with
`POST /api/v1/rooms/:code/expect`.

Sign-in is CoinPay OAuth only. Rooms: 3 free. A room pass costs $5 for 30 days and gives
50 rooms and codes you choose, paid through a CoinPay hosted checkout.

## Running it

Bun + Hono + bun:sqlite on dev2 at `/opt/group.call`, unit `group-call`, port 8810, behind
an exact-name nginx vhost with a cert from `pit-proxy-cert`. Deploy:
`ssh root@dev2 'cd /opt/group.call && git pull && ./bin/install.sh'`. Settings are in
`bin/install.conf`; secrets go in `~/.local/share/group-call/app.env` from the vault.

MIT
