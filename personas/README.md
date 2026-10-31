# Voice agent personas

These Markdown files are the canonical role and persona text injected into the
live ElevenLabs prompts by `src/agents.ts`. The associated ElevenLabs voice IDs,
SIP identities and speech-recognition aliases stay alongside them in that file.

This is a runtime persona convention for Group.Call, not a published LogicSRC
format. LogicSRC OpenAgent describes an agent's identity, owner, skills and
requested permissions; OpenProfile.md is the readable identity profile. As of
2026-10-31, LogicSRC does not publish an OpenPersona specification. Keep runtime
instructions here and link to them only if a future public persona format is
defined. These files do not grant permissions or contain credentials.

LogicSRC references: https://logicsrc.com/openagent and
https://logicsrc.com/openprofile.

The shared call behavior is in `src/agents.ts`: directly addressed agents must
answer aloud, specialists handle questions in their roles, and RiotCoder is the
default speaker for general room questions. Update that behavior and its tests
there when the call policy changes.
