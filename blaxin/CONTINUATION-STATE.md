# BLAXIN Engineering Mission — Continuation State

## CURRENT STATE
- **Date**: 2026-09-03
- **Branch**: main
- **HEAD**: 9e60309 (pre-session) — 6 commits ahead of origin/main (v1.0.8)
- **Mission Status**: In progress — Phases D–J substantially implemented, not yet committed or pushed this session

## WORK COMPLETED THIS SESSION (VERIFIED)

### D1 — Client endpoint resolution (root cause of the "valid API key rejected" bug)
- New `client/src/services/endpoints.ts`: detects the deployment mode (vite dev / nginx web / packaged Tauri) and resolves REST + WebSocket URLs correctly. In packaged Tauri the UI previously reached the asset server instead of the bundled Node backend on `127.0.0.1:3001`; the WebKitGTK webview then threw "The string did not match the expected pattern." on the empty/non-JSON response, surfaced as "key rejected" during setup.
- `client/src/services/api.ts` rewritten: reads bodies as text and parses safely (no engine parse errors leak), friendly errors incl. empty/unexpected responses, `ApiError` with status/code, `updateCheck()` added, `saveKey(..., {skipValidation})` support.
- `useWebSocket.ts` rewritten: endpoint-aware URL, 25s heartbeat, agent-state description handling, `confirmation-response` send, stale-confirmation cleanup on idle.
- `store.ts`: added `agentDescription` and `pendingConfirmation` state.

### D2 — Connection security
- `server/src/utils/security.ts` (NEW): origin allowlist (`isOriginAllowed`), env extras `BLAXIN_ALLOWED_ORIGINS`, express-cors validator, and `isStateChangingRequestAllowed` policy (no-Origin = non-browser client = allowed; browser origins must be trusted).
- `server/src/index.ts`: CORS restricted to allowlist; state-changing requests re-checked by middleware; both WebSocket servers routed through `server.on('upgrade')` with origin validation BEFORE the 101 handshake; `confirmation-response` WS message handled; bind address honors `BLAXIN_HOST`.
- Desktop: `src-tauri/src/lib.rs` now spawns the backend with `BLAXIN_HOST=127.0.0.1` and `BLAXIN_DESKTOP=1`.
- LIVE-VERIFIED: evil-origin POST → 403; no-origin POST → 200 (intended); localhost/tauri origins → 200; evil-origin GET → no ACAO; WS evil → 403, tauri/no-origin → connect; `connected` event includes description.

### D2 — Persistent data directory
- `server/src/utils/paths.ts` (NEW): `BLAXIN_DATA_DIR` env > desktop XDG (`~/.local/share/blaxin`) > cwd-relative fallback.
- config.ts / credentials.ts / session-state.ts now store under the data dir. Docker server sets `BLAXIN_DATA_DIR=/app/data`; compose mounts `blaxin-data` there; `.env.example`/`docker-compose.yml` document `BLAXIN_ALLOWED_ORIGINS`.

### D3 — API key validation (root-cause hardened)
- `basicKeyCheck()` in providers/index.ts: permissive structural checks only (length, whitespace, control chars); rejects BAD_FORMAT with clear messages before any network call; `saveKey(..., {skipValidation})` for provider-unreachable cases.
- `ValidateKeyResult` with codes (INVALID_KEY/FORBIDDEN/RATE_LIMIT/NETWORK/TIMEOUT/SERVER_ERROR/UNKNOWN); `classifyKeyHttpStatus` / `classifyKeyNetworkError`; base + OpenRouter validateKey use timeouts; OpenRouter keys never format-rejected.
- SetupWizard: code-aware error guidance, "Save key without validation" + "Retry" for network-type failures, input hygiene attrs, key state reset on provider switch.

### E — Provider message/tool-call replay (correctness)
- `server/src/providers/messages.ts` (NEW): `toOpenAICompatibleMessages`, `toAnthropicMessages` (tool_use/tool_result blocks), `toGeminiMessages` (functionCall/functionResponse), `toOllamaMessages`.
- Providers wired: OpenAI/OpenRouter/Groq/Together via base `formatMessages`; Anthropic, Google, Ollama use their converters.
- Orchestrator now stores assistant messages WITH their tool calls and appends only tool results (removed the duplicate empty assistant message that broke OpenAI-compatible replay); arguments capped at 10k chars for history.

### F — Orchestrator (agent engine)
- Sequential task queue (busy + `pendingQueue`, `isBusy()`); `stop()` honors loop boundaries, aborts pending confirmations (deny).
- Real confirmation gate: high-impact tools pause at `requires-confirmation`, wait for user approval/denial via WS `confirmation-response`, 120s timeout defaults to DENY; denied actions are recorded as skipped and never executed.
- Loop detection: 3 consecutive identical successful actions abort with explanation.
- Plan wiring (`currentPlan` objective/steps/states), `task-progress` events, failure lessons stored to memory.
- Client: `ConfirmationModal` (NEW) + approval wiring in `App.tsx`.

### G — Memory
- `server/src/utils/memory.ts` (NEW): typed entries (preference/fact/project/action-result), secret-content refusal (regex scan incl. PEM/keys/Bearer), caps, de-dup, LRU trim; REST: `GET /api/memory`, `DELETE /api/memory(/id)`.

### H — Tool hardening
- computer-control.ts rewritten: all xdotool/ydotool invocations via execFile argv arrays (no shell interpolation); consistent DISPLAY env; key charset guard; numeric validation.
- filesystem.ts: destructive ops blocked on protected roots (`/etc /usr /boot /bin /sbin /lib /proc /sys /dev /run /root /srv /var/{lib,cache,log,spool,backups}`), protected home dirs (`.ssh .gnupg .aws .kube .mozilla browser profiles ...`), and sensitive filenames (`id_rsa`, `*.pem|key|p12|pfx|kdbx`, `.blaxin-credentials`, `.netrc`, `.npmrc`, ...).

### I/J — UI & a11y
- cyberpunk.css: added missing `.spin`/`.pulse-soft`/`fadeIn` keyframes (used by loaders), `:focus-visible` rings, `prefers-reduced-motion` support.
- StatusBar: live activity description ("▸ ...") + LISTENING indicator; ChatPanel: description-aware status line, speaking indicator.
- Update check: `api.updateCheck()` used everywhere; server `/api/update/check` now uses real semver comparison (`utils/semver.ts`), so local builds ahead of the last release are never offered a "downgrade".
- Sidebar/BLAXIN version label unchanged (versions still 1.0.0 until next release bumps them).

### Tests & builds (this session, all passing)
- Added: messages-mapping (10), key-validation (13), security incl. request-guard policy (13), semver+memory (9). Vitest config now runs src only (was double-running dist copies).
- Server: `tsc --noEmit` clean; `npm test` → 8 files, 64 tests PASS; `npm run build` clean.
- Client: `npm run build` clean (714 kB chunk warning noted, non-blocking).
- Live API matrix on scratch server verified (HTTP + WS origin behavior, BAD_FORMAT path, memory endpoints) then stopped/cleaned.

## REMAINING WORK
- [ ] Add API-key regression tests for client-side flow is covered by code; optionally e2e later
- [ ] Docs pass: README updated (this session); final polish of README wording if needed
- [ ] Review remaining known issues below and decide scope
- [ ] Final full sweep (server tsc + tests + build, client build)
- [ ] Logical git commits of this session's work
- [ ] Push to origin/main and verify remote state (6 pre-existing commits + new ones)
- [ ] Release pipeline NOT TESTABLE locally (needs GitHub secrets + CI): v1.0.8 remote status, latest.json refresh, updater artifact verification — see phase N
- [ ] Voice wake-word / interruption polish (architecture present via Web Speech API; not e2e-verified)
- [ ] Tauri desktop e2e (cargo build needs webkit deps; NOT TESTABLE in this environment unless deps present)

## KNOWN ISSUES (still open)
- `blaxin/update/latest.json` is stale (v1.0.2, empty signature); CI refreshes it on the next successful tagged release.
- Version constants in-repo are 1.0.0; the release workflow bumps them during CI. Sidebar shows v1.0.0 in dev — cosmetic until next release.
- Client bundle ~714 kB (min) — chunk-split optimization deferred.
- Terminal panel uses pipes (no PTY): full-screen TUI apps may render imperfectly; interactive apps rely on `signal` messages.
- Ollama/Anthropic/Gemini tool-call replay is implemented per their documented wire formats but has not been exercised against live APIs (no keys); the OpenAI-compatible path is the best-tested.
