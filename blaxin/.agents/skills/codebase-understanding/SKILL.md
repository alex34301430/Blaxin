---
name: codebase-understanding
description: Deep repository analysis and architecture comprehension for BLAXIN engineering tasks.
---

# BLAXIN Codebase Understanding

## Mission
Understand existing architecture before modifying it.

## Inspect
Identify:
- application entry points
- frontend/backend boundaries
- agents
- tools
- event bus
- WebSocket
- persistence
- memory
- browser subsystem
- computer-use subsystem
- voice subsystem
- security
- tests
- packaging

## Dependency Mapping
Determine:
- callers
- callees
- data flow
- state flow
- side effects
- ownership boundaries

## Change Safety
Before modifying:
- identify working behavior
- identify contracts
- identify regression tests
- identify hidden coupling

## Hard Rules
Do not rewrite working architecture without evidence.
Do not remove apparently unused code without checking runtime references.
