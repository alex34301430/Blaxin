---
name: test-engineering
description: Layered deterministic and real-runtime testing discipline for BLAXIN.
---

# BLAXIN Test Engineering

## Mission
Prove behavior rather than merely prove compilation.

## Test Layers
Use:
- unit tests
- integration tests
- runtime tests
- browser tests
- E2E tests
- security regression tests
- benchmark tasks

## Test Design
A useful test should verify:
input
→ real behavior
→ observable outcome
→ expected verification

## Negative Tests
Also test:
- target not found
- timeout
- browser desync
- verification failure
- worker failure
- malformed state
- secret leakage

## Regression
Preserve known passing tests.

Never delete a test solely because implementation became harder.

## Output
Track:
- pass
- fail
- skip
- environment requirement
- regression risk

## Hard Rules
Passing tests must represent meaningful behavior.
Do not turn tests into decorative coverage.
