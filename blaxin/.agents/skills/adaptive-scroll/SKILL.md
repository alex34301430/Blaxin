---
name: adaptive-scroll
description: Semantic and viewport-aware scrolling strategy for BLAXIN.
---

# BLAXIN Adaptive Scroll

## Mission
Reach off-screen targets efficiently without losing page context.

## Process
1. Identify target.
2. Determine whether it is visible.
3. Estimate direction/distance.
4. Scroll appropriate amount.
5. Observe viewport change.
6. Re-ground target.
7. Repeat if necessary.

## Signals
Use:
- target position
- viewport dimensions
- page structure
- visible text
- current scroll position
- screenshot/DOM changes

## Dynamic Loading
After scroll, allow required loading time and observe again.

## Stop Conditions
Stop when:
- target is safely visible
- target can be grounded
- page end is reached
- additional scrolling provides no useful progress

## Hard Rules
Never assume a scroll succeeded.
Never click before re-grounding after meaningful scrolling.
