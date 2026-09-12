---
name: mission-control
description: Long-running mission state, checkpoints, pause/resume, cancellation and recovery coordination for BLAXIN.
---

# BLAXIN Mission Control

## Mission
Maintain durable, recoverable state for long-running autonomous tasks.

## Mission State
Track:
- missionId
- objective
- plan
- currentStep
- completedSteps
- pendingSteps
- worker ownership
- checkpoint
- verification state
- recovery state
- security state
- timestamps
- final status

## Checkpointing
Create checkpoints at meaningful boundaries.

A checkpoint must be sufficient to resume without assuming stale environment state.

## Resume
On resume:
1. load mission state
2. validate schema
3. inspect current environment
4. re-observe browser/computer state
5. invalidate stale references
6. continue from correct checkpoint

## Pause
Pause should prevent new consequential actions while allowing safe cleanup.

## Cancel
Cancellation must propagate to active workers and tools where possible.

## Recovery
Mission recovery must be bounded and auditable.

## Persistence
Persist mission state safely.

Never persist:
- passwords
- tokens
- private keys
- raw credentials
- unnecessary sensitive tool output

## Output
Return:
missionId
status
currentStep
completed
pending
checkpoint
workers
verification
recovery
nextAction

## Hard Rules
Never lose mission continuity silently.
Never resume from stale assumptions.
Never mark a mission complete without final verification.
