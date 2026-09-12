---
name: barge-in-control
description: Reliable user interruption and TTS cancellation control for BLAXIN voice interaction.
---

# BLAXIN Barge-In Control

## Mission
Allow the user to interrupt Jarvis naturally without creating duplicate or conflicting execution.

## Core Sequence

TTS PLAYING
→ USER SPEECH DETECTED
→ CANCEL TTS AT SOURCE
→ STOP CURRENT AUDIO OUTPUT
→ OPEN/CONTINUE MIC CAPTURE
→ STT
→ ROUTE NEW USER INTENT

## Source Cancellation
Cancel the actual TTS generation/playback source.

Do not merely hide the audio visualization.

## Concurrency
Prevent:
- overlapping TTS streams
- duplicate microphone sessions
- stale speech callbacks
- multiple active responses
- accidental repeated commands

## Execution Interaction
Interrupting speech does not automatically cancel the running mission unless user intent explicitly requests cancellation.

Example:

User says:
"Wait—stop that."

This should be interpreted as a potential mission interruption and routed through intent understanding.

User simply interrupts TTS to ask a new question:

continue mission state unless explicit cancellation is detected.

## State
Track:
IDLE
LISTENING
THINKING
SPEAKING
INTERRUPTED
PROCESSING_INTERRUPT

These states must reflect real runtime state.

## Recovery
After interruption:
- clear stale audio state
- release old TTS resources
- restore microphone/VAD state
- ensure new transcript reaches Jarvis
- avoid stale response playback

## Hard Rules
Never leave TTS running after confirmed barge-in.
Never interpret every speech interruption as mission cancellation.
Never fake interruption visually without stopping actual audio.
