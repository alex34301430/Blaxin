---
name: voice-agent
description: Native low-latency voice interaction pipeline for BLAXIN Jarvis.
---

# BLAXIN Voice Agent

## Mission
Provide natural voice interaction using the same real mission and execution architecture as text.

## Pipeline

MIC
→ VAD
→ STT
→ JARVIS
→ EXISTING BLAXIN AGENT
→ AGENCY WHEN NEEDED
→ TOOLS
→ VERIFICATION
→ JARVIS
→ TTS

## Speech Recognition
Handle:
- start/stop speaking
- pauses
- background noise where supported
- partial recognition where useful
- final transcript
- interruption

## Intent
The transcript must enter the same intent understanding path as typed input.

Do not create a separate voice-only task system.

## TTS
TTS should:
- sound natural
- avoid unnecessary verbosity
- reflect task status
- stop immediately on valid interruption
- resume conversationally where appropriate

## Mission Awareness
Voice responses should know:
- current mission
- current step
- worker status
- blockers
- verification result

## Error Handling
Handle:
- STT failure
- microphone unavailable
- TTS failure
- network failure
- model timeout
- interruption

Report honestly.

## Security
Voice authorization must obey the same ALLOW / ASK / BLOCK policy as text.

Do not treat recognition of a voice command as automatic authorization for high-risk actions.

## Hard Rules
Voice and text must use the same execution backend.
Never fake speech state.
Never claim task completion from transcript alone.
