---
name: performance-engineering
description: Evidence-driven latency, throughput and resource optimization for BLAXIN.
---

# BLAXIN Performance Engineering

## Mission
Improve BLAXIN speed without reducing correctness, security or verification.

## Measure
Track where useful:
- model latency
- tool latency
- browser latency
- perception latency
- verification latency
- worker latency
- mission duration
- retry overhead
- memory overhead

## Optimization Priority
Optimize:
1. unnecessary work
2. redundant observations
3. serial work that is safely parallelizable
4. expensive repeated context
5. slow tool paths

## Constraints
Never remove required verification merely to reduce latency.

Never optimize fake telemetry.

## Comparison
Before/after optimization should have measurable evidence.

## Hard Rules
Do not optimize assumptions.
Do not trade reliability for cosmetic speed.
