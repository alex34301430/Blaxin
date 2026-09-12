---
name: browser-session-sync
description: Reliable synchronization between visible browser state and BLAXIN browser/CDP execution context.
---

# BLAXIN Browser Session Synchronization

## Mission
Ensure every browser tool operates on the actual browser session visible to the user.

## Authoritative State
Track when available:
- browser process
- browser instance ID
- browser context ID
- page/tab ID
- active URL
- title
- connection state
- navigation state

## Consistency Rule
The following must refer to the same real session:

visible browser
↔ browser tool
↔ CDP connection
↔ active page/tab
↔ snapshot
↔ screenshot

If they diverge, state is SESSION_DESYNC.

## Synchronization Checks
Before consequential browser actions:
1. confirm connection
2. confirm active page
3. confirm URL
4. confirm expected title/state when useful
5. reject stale page handles
6. acquire a fresh observation if necessary

## Recovery
On desynchronization:
1. inspect current browser process
2. reconnect to active browser
3. reacquire context
4. reacquire active page
5. snapshot again
6. compare URL/state
7. continue only after synchronization

Never silently continue against about:blank or a stale page.

## Navigation
After navigation:
- wait for usable state
- reacquire page state
- update active URL
- invalidate stale target references

## Tab Handling
Do not assume the previously active tab remains active.

Explicitly identify the current page before interacting.

## Failure States
Use:
CONNECTED
DISCONNECTED
SYNCING
SESSION_DESYNC
UNKNOWN

## Hard Rules
Never claim browser success from a different context.
Never trust stale CDP/page references.
Never hide synchronization failures.
