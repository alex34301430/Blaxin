---
name: result-synthesis
description: Combines outputs from BLAXIN workers into one validated mission result.
---

# BLAXIN Result Synthesis

## Mission
Combine specialist outputs without losing uncertainty or contradictory evidence.

## Process
1. Collect worker outputs.
2. Validate structure.
3. compare evidence.
4. detect contradictions.
5. identify missing information.
6. determine confidence.
7. synthesize result.
8. request additional verification when necessary.

## Contradictions
Never silently choose one conflicting result.

Mark:
CONFLICT

Then:
- inspect stronger evidence
- run verification
- or escalate

## Evidence
Prefer independently verified evidence over unsupported claims.

## Output
Return:
summary
workerResults
evidence
conflicts
confidence
verification
finalStatus
nextAction

## Hard Rules
Do not convert multiple uncertain outputs into false certainty.
