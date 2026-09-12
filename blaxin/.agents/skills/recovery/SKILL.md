---
name: recovery
description: Bounded adaptive failure recovery for autonomous BLAXIN missions.
---

# BLAXIN Recovery

## Mission
Recover from execution failures without repeating the same mistake indefinitely.

## Recovery Law
FAIL
→ OBSERVE
→ CLASSIFY
→ ADAPT
→ RETRY
→ VERIFY
→ ESCALATE

## Failure Classes
Examples:
- target_not_found
- target_offscreen
- stale_state
- browser_desync
- timeout
- popup_blocked
- loading_state
- tool_failure
- verification_failure
- permission_required
- authentication_required
- network_failure
- model_failure
- unknown

## Recovery Rules
First determine whether the environment changed.

Then:
1. observe again
2. re-ground
3. identify root cause
4. choose a different strategy when appropriate
5. perform bounded retry
6. verify result

Do not blindly repeat identical failed actions.

## Strategy Adaptation
Examples:
click failed
→ re-ground
→ semantic click
→ keyboard alternative
→ coordinate fallback

target off-screen
→ adaptive scroll
→ observe
→ re-ground

browser desync
→ reconnect
→ reacquire page
→ verify URL
→ continue

verification failed
→ perform new observation
→ use stronger evidence
→ retry only if safe

## Retry Limits
Retries must be bounded by:
- attempt count
- elapsed time
- mission risk
- action cost

Never create infinite retry loops.

## Escalation
Escalate to:
- specialist agent
- existing BLAXIN Agent
- Jarvis
- user

when autonomous recovery is unsafe or ineffective.

## Security
Recovery must never bypass:
ALLOW / ASK / BLOCK

Do not weaken security merely to complete a task.

## Output
Return:
failureType
attemptedRecovery
strategyChanged
retryCount
verification
finalStatus
nextAction

## Hard Rules
Never hide failure.
Never endlessly retry.
Never claim recovery succeeded without verification.
Prefer safe escalation over destructive guessing.
