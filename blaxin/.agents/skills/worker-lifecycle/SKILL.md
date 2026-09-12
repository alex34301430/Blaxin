---
name: worker-lifecycle
description: Real lifecycle and state management for BLAXIN Agency workers.
---

# BLAXIN Worker Lifecycle

## States
QUEUED
STARTING
RUNNING
WAITING
BLOCKED
VERIFYING
RECOVERING
COMPLETED
FAILED
CANCELLED
TIMEOUT

## Lifecycle
QUEUED
→ STARTING
→ RUNNING
→ VERIFYING
→ COMPLETED

Failure:
RUNNING
→ FAILED
→ RECOVERING
→ RUNNING
or
→ FAILED

## State Truth
Worker state must come from actual runtime state.

Never fabricate:
- worker activity
- progress
- completion
- tool usage
- latency

## Cancellation
Cancellation must reach the actual worker and stop its work where technically possible.

## Timeout
Every worker needs bounded execution.

## Output
Return:
workerId
state
startedAt
finishedAt
currentTask
failure
verification
