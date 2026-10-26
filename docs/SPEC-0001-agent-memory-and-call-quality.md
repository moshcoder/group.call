# SPEC-0001: agent memory, turn-taking and call quality

Status: accepted, in progress · 2026-10-26 · owner riotcoder

## Why

From the first live calls (Anthony, Preshy and two agents in room 9474):

- "you guys seem to drop and rejoin and introduce yourselves with no memory. We need to preserve memory for sure."
- "make sure you don't talk over ANYONE in the call ... pause before replying, you seem to be replying too fast and cutting people off."
- "we have call stability issues, break up going in and out."
- Preshy: "they shouldn't talk until it's really silent."

## 1. Memory

An agent on a call is a fresh process with an empty head. Each join, a crash or a deploy loses
everything said so far. The fix is to treat the room's own record as the agent's memory, then add
a summary and a per-agent note on top.

### 1.1 The room transcript is the shared memory (v1, now)

group.call already stores every line per speaker (`transcript_lines`). The worker's room endpoint
(`GET /api/v1/agent-queue/rooms/:code`, worker key) returns:

- `history`: the last 80 lines, with speaker, kind (person, agent, typed) and time
- `summary`: the room summary (1.2), when there is one
- `agentSeen`: for each agent, when it last spoke in this room

On join, `agent-phone` loads `history` into its transcript before the first turn. Its own past
lines are marked as its own. If it spoke in this room in the last 3 hours, it is a rejoin: no
introduction, at most "Sorry, I dropped. I'm back." and only if somebody is talking to it.

### 1.2 Rolling room summary (v1.1)

Long calls exceed what a turn prompt should carry. Every 25 new lines, group.call asks Gemini
Flash-Lite for a running summary (who is here, what was decided, open questions, tasks given to
agents) and stores it in `room_memory(code, summary, through_line_id, updated_at)`. It shows on
the room page, is returned by the API and MCP, and goes to agents as `summary`.

### 1.3 Per-agent call notes (v1.2)

When an agent leaves, it writes a short note: tasks taken and anything it promised. The note goes
to the agent's Agents chat in qrypt.chat (the same place task results go), and to
`agent_notes(code, agent, note, at)` so the next join into this room loads it. An agent then never
re-asks what it was told on an earlier call in the same room.

### 1.4 Reconnect on drop (v1, now)

If an agent's leg ends and nobody asked it to leave (no HANGUP, the room still has people in it),
the worker dials it back once within 5 seconds with the same memory. A second drop within 2
minutes is reported in the room page activity, and the agent does not loop.

## 2. Turn-taking: never talk over anyone

Rules, enforced in code, not only in the prompt:

1. Silence first. An agent speaks only after 2.0 s in which nobody (person or agent) has made
   sound, measured from interim transcripts on its own leg (which hears the whole room).
2. One voice. The floor file (`floor-<code>.json`) gives one agent the floor for the estimated
   length of its line and releases it on `call.speak.ended`. The other agent waits, and drops its
   line if it was not addressed by name.
3. Yield at once. Any person's speech while an agent talks stops the agent's playback, except its
   own echo (a person line that repeats the agent's words).
4. Quiet by default. Speak when addressed by name, or for a room question no person answered.
   Never fill silence, narrate progress, or claim to be "checking".
5. Late is better than rude. If the 2 s of silence does not come within 10 s, the line is
   dropped, not spoken over someone.

Acceptance: in a scripted 3-person + 2-agent call, no agent speech window overlaps any other
speech window (from `[spoke-start]`/`[spoke-end]` and the room transcript times), and every named
question is answered by the named agent within 5 s of the silence.

## 3. Call quality ("breaking up")

### 3.1 Measure first (now)

Telnyx sends `call_quality_stats` (inbound/outbound MOS, jitter, packet loss) on `call.hangup`.
group.call stores them per leg (`leg_quality(code, leg, who, mos_in, mos_out, jitter_ms,
loss_pct, at)`) and shows the last call's numbers on the room page. `agent-phone` logs the same
for its own leg. A leg with MOS < 3.6 or loss > 1% is flagged in the room activity.

### 3.2 Likely causes, to confirm with 3.1

- **Media relayed between anchorsites.** The group.call app is set to "Latency", so each leg
  anchors where it is nearest and the conference may sit elsewhere. Fix: pin one anchorsite for
  the group.call app and the agents' outbound app.
- **Extra hops for agents.** An agent call goes agents app → PSTN number → group.call app. Fix
  later: dial the agent leg straight into the conference from the group.call app (no number in
  between) once 3.1 shows the hop matters.
- **Caller side.** A cell on a weak signal, or a speakerphone (echo). 3.1 shows per-leg numbers,
  so a bad leg is not blamed on the room.

## Rollout

| Part | When |
| --- | --- |
| 1.1 history on join + rejoin without intro | now (group.call 0.4.0, agent-phone) |
| 1.4 reconnect on drop | now |
| 2 silence 2.0 s, yield, quiet by default | now |
| 3.1 quality stats | now |
| 3.2 anchorsite pin | after one day of 3.1 data |
| 1.2 summary, 1.3 notes | next |
