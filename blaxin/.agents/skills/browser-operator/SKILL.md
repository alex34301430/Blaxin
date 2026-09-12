---
name: browser-operator
description: Reliable real-browser navigation, interaction and state management for BLAXIN.
---

# BLAXIN Browser Operator

## Mission
Operate the real browser to complete user goals with synchronized state and verified outcomes.

## Core Flow
OBSERVE → PLAN → NAVIGATE/ACT → OBSERVE → VERIFY → RECOVER

## Browser State
Track when available:
- browser instance
- context
- active page
- URL
- title
- loading state
- connection state

## Navigation
After navigation:
- wait for usable state
- reacquire page
- verify URL/title/content
- invalidate stale targets

## Interaction
Use semantic/DOM/accessibility targeting before coordinates.

For every consequential interaction:
- ground target
- act
- observe
- verify

## Search
When searching:
- identify correct search field
- submit query
- verify results
- disambiguate similar results

## Dynamic Websites
Expect:
- lazy loading
- popups
- overlays
- cookie dialogs
- redirects
- bot checks
- changing DOM

Re-observe when state changes.

## Hard Rules
Never claim navigation or browser action success without verification.
Never use stale page state.
Never assume the active tab.
