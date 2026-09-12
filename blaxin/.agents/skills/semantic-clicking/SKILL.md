---
name: semantic-clicking
description: High-confidence semantic click execution for BLAXIN.
---

# BLAXIN Semantic Clicking

## Mission
Click the intended UI target rather than merely the nearest coordinate.

## Target Priority
Prefer:
1. exact semantic text
2. accessible role/name
3. DOM identity
4. unique visual label
5. geometry
6. coordinate fallback

## Pre-Click
Verify:
- target identity
- uniqueness
- visibility
- interactability
- current page
- overlay obstruction

## Post-Click
Observe resulting state.

Expected evidence may include:
- navigation
- modal
- selection change
- text change
- attribute/state change

## Ambiguity
If two targets match:
do not guess.

Acquire stronger evidence.

## Hard Rules
A click attempt is not a verified click.
Never silently substitute a similar target.
