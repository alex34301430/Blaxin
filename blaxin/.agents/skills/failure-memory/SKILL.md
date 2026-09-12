---
name: failure-memory
description: Learns from verified execution failures and successful recovery patterns.
---

# BLAXIN Failure Memory

## Mission
Prevent BLAXIN from repeatedly making the same execution mistake.

## Failure Record
Store:
- task category
- environment
- failed action
- observed failure
- probable cause
- recovery attempt
- successful recovery if any
- final result
- confidence

Never store secret material.

## Learning Loop
FAILURE
→ DIAGNOSE
→ RECOVER
→ VERIFY
→ RECORD LESSON
→ REUSE

## Reuse
Before repeating an action:
- check whether similar failures occurred
- prefer known successful recovery
- change strategy when previous strategy failed

## Recurrence
Track recurring failures such as:
- stale browser context
- wrong target
- viewport mismatch
- popup obstruction
- timeout
- verification failure

Use recurrence data to prioritize engineering fixes.

## Hard Rules
Never treat one failure as universal truth.
Never hide failures from diagnostics.
