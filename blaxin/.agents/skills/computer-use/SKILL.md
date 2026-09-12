---
name: computer-use
description: High-reliability real desktop and browser computer-use skill for BLAXIN.
---

# BLAXIN Computer Use

## Mission

Operate the real computer reliably to accomplish the user's objective.

This skill is an execution capability, not a conversational capability.

The existing BLAXIN Agent remains the execution authority. Jarvis may request computer work, but this skill must operate through the existing Agent/tool architecture.

## Core Law

Always follow:

OBSERVE
→ UNDERSTAND
→ PLAN
→ GROUND
→ ACT
→ OBSERVE AGAIN
→ VERIFY
→ RECOVER
→ REPORT

Never assume an action succeeded.

## Target Grounding

Before interacting with a UI target, gather the strongest available evidence:

1. DOM information
2. accessibility information
3. visible text
4. semantic role
5. element geometry
6. screenshot evidence
7. viewport position
8. current page/window state

Prefer semantic targeting over raw coordinates.

Use coordinates only when stronger grounding is unavailable or insufficient.

Never guess between multiple ambiguous targets.

If confidence is insufficient:
- acquire another observation
- refine grounding
- or return UNKNOWN

## Viewport Awareness

Track whether a target is actually inside the current viewport.

An off-screen target may be known but must remain:

inViewport = false

Do not click an off-screen element simply because its DOM node exists.

When necessary:

GROUND
→ SCROLL
→ OBSERVE
→ RE-GROUND
→ ACT

Never silently assume scrolling succeeded.

## Clicking

Before click:
- verify target identity
- verify target position
- verify target is interactable
- verify no higher-priority overlay blocks it

After click:
- observe resulting state
- compare expected state transition
- verify that the intended target changed

A click attempt is not a successful click until the resulting state is verified.

## Typing

Before typing:
- verify focused target
- verify field identity
- verify field is editable

After typing:
- observe the field again
- verify the intended value/state exists

Never assume keyboard input reached the intended field.

Never expose credentials in logs, events, screenshots metadata, or memory.

## Scroll

Scrolling must be adaptive.

After each meaningful scroll:
- observe viewport
- determine movement
- locate newly available target
- re-ground target

Avoid blindly scrolling fixed amounts when semantic information can guide the operation.

## Drag and Drop

For drag/drop:
1. identify source
2. identify destination
3. verify both
4. start drag
5. maintain drag state
6. release
7. observe
8. verify resulting state

Use temporal observation when static screenshots cannot establish success.

## Browser Interaction

Always maintain awareness of:
- browser instance
- browser context
- active tab/page
- URL
- title
- connection state

The visible browser and backend/CDP control context must refer to the same actual session.

If they diverge:
return SESSION_DESYNC
then attempt recovery.

Never act on a stale page handle.

## Observation Strategy

Use the cheapest reliable observation first.

Use:
- DOM/snapshot for structure
- screenshot for visual state
- micro-recording/frame sampling for temporal behavior

Do not perform unnecessary repeated observations.

But never skip an observation required for verification.

## Action Selection

Choose the most reliable available action.

Preferred order:

1. semantic target interaction
2. accessibility/DOM interaction
3. keyboard navigation
4. robust browser interaction
5. coordinate interaction
6. recovery strategy

Coordinate-only execution should not be the default.

## Recovery

When an action fails:

1. observe again
2. determine failure type
3. re-ground target
4. adapt strategy
5. retry within bounded limits
6. verify again

Possible recovery:
- scroll
- wait for loading
- dismiss popup
- reopen page
- reacquire browser context
- re-focus target
- switch interaction method
- delegate to another specialist
- request user intervention

Never retry forever.

## Temporal Verification

For dynamic actions such as:
- video playback
- loading
- drag/drop
- transitions
- popup appearance
- asynchronous UI updates

use time-separated observations.

For example:

state(t0)
→ action
→ wait appropriate interval
→ state(t1)

Then compare the states.

A single screenshot is insufficient when success depends on change over time.

## Security

Never:
- reveal credentials
- persist passwords
- log tokens
- expose private keys
- submit highly consequential actions without required authorization

Respect the independent BLAXIN security policy:

ALLOW
ASK
BLOCK

## Result Contract

Return structured execution information:

status:
SUCCESS | FAILURE | UNKNOWN

action:
what was attempted

target:
what was interacted with

evidence:
what was actually observed

verification:
how success/failure was established

recovery:
what recovery was attempted

nextAction:
what should happen next

## Hard Rules

NEVER:
- guess a target
- claim success without verification
- use stale browser state
- treat off-screen as visible
- hide uncertainty
- create fake runtime state
- leak secrets
- bypass security policy

Prefer honest UNKNOWN over false SUCCESS.
