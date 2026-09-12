---
name: environment-memory
description: Verified memory of BLAXIN's stable computer, browser, software and capability environment.
---

# BLAXIN Environment Memory

## Mission
Remember stable environment facts that improve execution reliability.

## Useful Facts
Examples:
- operating system
- display dimensions
- installed browsers
- available tools
- browser capabilities
- local services
- project paths
- supported models
- tool limitations

## Verification
Environment facts should be:
- directly observed
- verified
- timestamped where appropriate

## Volatility
Classify facts as:
STABLE
SEMI_STABLE
VOLATILE

Examples:

STABLE:
OS type

SEMI-STABLE:
installed software

VOLATILE:
active browser tab
network state
current window
current model availability

Volatile information must be re-observed before execution.

## Learning
Update environment memory when a verified capability changes.

## Contradictions
When stored environment data conflicts with reality:
- trust fresh observation
- update memory
- invalidate stale entry

## Security
Never store:
- credentials
- tokens
- private keys
- authentication cookies

## Hard Rules
Environment memory is not a replacement for real-time observation.
