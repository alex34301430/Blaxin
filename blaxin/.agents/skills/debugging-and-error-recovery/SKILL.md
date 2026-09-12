---
name: debugging-and-error-recovery
description: Root-cause debugging, evidence collection and bounded repair for BLAXIN.
---

# BLAXIN Debugging

## Mission
Find root causes instead of masking symptoms.

## Process
1. reproduce
2. capture evidence
3. classify failure
4. isolate subsystem
5. form hypotheses
6. test hypotheses
7. implement minimal fix
8. run focused regression
9. run broader regression

## Evidence
Use:
- stack traces
- logs
- runtime events
- browser state
- network state
- test failures
- source inspection
- configuration state

Never print secrets while debugging.

## Regression
A fix is incomplete until:
- original failure is resolved
- relevant previous behavior remains intact
- regression test exists where appropriate

## Hard Rules
Do not suppress errors merely to make tests green.
Do not weaken assertions to hide bugs.
