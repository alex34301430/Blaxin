---
name: verification
description: Evidence-driven verification of BLAXIN actions and mission outcomes.
---

# BLAXIN Verification

## Mission
Determine whether an attempted action actually achieved its intended result.

## Fundamental Rule
Attempt != Success.

Only verified outcomes may return SUCCESS.

Allowed status:
SUCCESS
FAILURE
UNKNOWN

## Verification Strategy
For every action define:
expected state
observable evidence
verification method
timeout
failure condition

## Examples

### Click
Verify:
- intended state transition
- target changed
- expected UI appeared/disappeared

### Type
Verify:
- intended field is still focused or identifiable
- expected value/state exists

### Navigation
Verify:
- URL
- page identity
- expected content
- usable page state

### Scroll
Verify:
- viewport actually moved
- target became available when expected

### File Operation
Verify:
- file existence
- content/state where appropriate
- expected metadata

### Playback
Verify:
- media element exists
- playback state
- currentTime advances over time
- additional visual/player evidence when useful

### Form Submission
Verify:
- success confirmation
- resulting page/state
- expected record/state transition

## Temporal Verification
For dynamic tasks:
state(t0)
→ action
→ wait
→ state(t1)

Compare actual state change.

A single screenshot is insufficient when success requires temporal change.

## Evidence Quality
Strong evidence:
direct machine-readable state + independent observation

Medium:
single reliable observation

Weak:
inference without direct evidence

Weak evidence must not become SUCCESS for consequential operations.

## Verification Failure
If intended state cannot be established:
return UNKNOWN

Do not guess.

## Output
Return:
status
expectedState
observedState
evidence
verificationMethod
confidence
failureReason
nextAction

## Hard Rules
False SUCCESS is unacceptable.
UNKNOWN is a valid result.
Verification must be independent enough to catch execution mistakes.
