---
name: visual-grounding
description: High-precision multimodal UI target grounding for BLAXIN computer use.
---

# BLAXIN Visual Grounding

## Mission
Identify the exact UI target required for an action using real evidence.

## Grounding Priority
Prefer the strongest available evidence:
1. DOM/accessibility semantics
2. visible text
3. semantic role
4. element geometry
5. screenshot evidence
6. recent interaction history
7. coordinates as final fallback

## Required Checks
Before returning a target:
- identity matches requested target
- target is unique or ambiguity is resolved
- target geometry is valid
- target visibility is known
- viewport position is known
- target is interactable
- overlay/modal obstruction is considered

## Ambiguity
If multiple targets plausibly match:
- compare labels
- compare role
- compare surrounding context
- compare geometry
- acquire another observation when needed

Never choose arbitrarily.

## Off-Screen Handling
An identified target may be:
inViewport = true
or
inViewport = false

If false:
GROUND → SCROLL → OBSERVE → RE-GROUND

Never report an off-screen target as visible.

## Confidence
Grounding confidence must reflect evidence quality.

High confidence:
clear semantic match + compatible geometry/state

Medium confidence:
partial semantic/visual evidence

Low confidence:
ambiguous, stale, or incomplete evidence

Low-confidence targets must not be used for consequential actions.

## Stale State
Re-ground after:
- navigation
- major scroll
- modal appearance
- page transition
- DOM mutation
- browser context change

## Output
Return:
target identity
selector/locator when available
coordinates when needed
viewport status
confidence
evidence
ambiguity
recommended action

## Hard Rules
Never hallucinate UI targets.
Never use stale geometry without revalidation.
Never convert uncertainty into confidence.
