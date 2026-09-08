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
3. The Memory page saves and deletes a durable note through the real API.

## Notes

- The scratch backend data dir lives in `e2e/.runtime/` (gitignored) and is
  left behind for inspection after a run.
- `ws proxy socket error` / `ECONNRESET` lines from the vite proxy are
  benign — they occur when a test page closes while its WebSocket is open.
