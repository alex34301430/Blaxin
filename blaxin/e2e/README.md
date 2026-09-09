# BLAXIN End-to-End Tests

Real-stack browser tests: the **vite dev server** serves the client while a
**real BLAXIN backend** runs from `server/src` on a scratch data dir, and
the tests drive them through the system's installed **Google Chrome**
(no browser binaries are downloaded — Playwright uses `channel: 'chrome'`).

No provider key is needed: safe deterministic tasks run on the fast path,
so the full UI → WebSocket → agent loop → UI pipeline is exercised for real.

## Prerequisites

- `blaxin/server` dependencies installed (`npm install` in `../server`)
- `blaxin/client` dependencies installed (`npm install` in `../client`)
- Google Chrome on `PATH` (config falls back through Playwright's channel lookup)
- `npm install` in this directory (one time)

The Chrome **sandbox stays enabled**. The `--no-sandbox` escape hatch only
activates when `BLAXIN_E2E_NO_SANDBOX=1` is set explicitly (sandboxless
container hosts with user namespaces blocked); CI runs sandboxed.

## Run

```bash
npm test            # headless
npm run test:headed # watch it happen
```

Playwright starts and stops both servers automatically
(ports 3001 and 5173; override with `PW_BACKEND_PORT` / `PW_VITE_PORT`).
Set `CI=1` to retry flaky tests once.

## What is covered

1. The app loads, connects to the real backend (`LIVE`), and renders chrome.
2. A real safe task ("list the contents of /tmp") completes end to end, and
   both live regions (`role=status` in the StatusBar and the chat) announce
   the real transitions and the reply.
3. The real **confirmation gate**: "open https://example.com/" hits the fast
   path and the browser tool's approval gate. The modal's safe default is
   asserted (focus on Deny), Escape denies, and the step lands DENIED +
   SKIPPED — the action never executes.
4. The **Settings dialog** a11y contract: focus moves in on open, Tab stays
   trapped inside, Escape closes, focus returns to the opener.
5. **JARVIS audio identity** persistence: mute state and clamped volume
   survive a real page reload (localStorage-backed store).
6. The Memory page saves and deletes a durable note through the real API.

## CI

`.github/workflows/e2e.yml` runs the same suite on every push/PR that
touches server, client, or e2e code (ubuntu-22.04 runner, preinstalled
Chrome, sandboxed, both real webServers, failure artifacts uploaded).

## Notes

- The scratch backend data dir lives in `e2e/.runtime/` (gitignored) and is
  left behind for inspection after a run.
- `ws proxy socket error` / `ECONNRESET` lines from the vite proxy are
  benign — they occur when a test page closes while its WebSocket is open.
