# BLAXIN Engineering Mission — Continuation State

## CURRENT STATE
- **Date**: 2026-09-08
- **Branch**: main
- **HEAD**: 90cf6e4 (before Phase 1 work; see "PHASE 1 — REPO IDENTITY CANONICALIZATION" below)
- **Version**: 1.2.0 (tag v1.2.0 released; all in-repo version sources agree on 1.2.0)
- **Mission Status**: **Phase 1 (canonicalize repo identity) implemented and verified locally, not yet committed.** All `alex34301430/Blaxin` references canonicalized to `tasinxxx/Blaxin` (or `${{ github.repository }}` in CI) across server, Rust updater, Tauri config, release workflow/script, installer, manifest + validator; `vv1.2.0` notes typo fixed; `.secrets/update-signing-key.txt` hardened to 0600. Verified: no stale refs remain in source, latest.json passes its validator, server tsc clean, server tests 310/311 (1 pre-existing wss-transport timing flake that passes in isolation), client build clean, `cargo check` clean. Awaiting commit per workflow (user approves commits).

Historical sessions below are kept for context (v1.1.1-era notes are superseded — v1.2.0 shipped multi-body registry, local models, OCI, distributed Brain).

## PHASE 1 — REPO IDENTITY CANONICALIZATION (2026-09-08)

### Problem
- Git remote is `tasinxxx/Blaxin` (matches expected identity) but ~50 source/config references hardcoded the stale `alex34301430/Blaxin`, which GitHub silently redirects (repo renamed). Raw/manifest URLs, the runtime update check, and the Rust updater's `EXPECTED_REPO` all pointed at the old name — working today only via GitHub's rename redirect, breaking silently if the old name is ever reclaimed. Release notes also carried a `vv1.2.0` double-v typo.

### Changes (WHAT/WHY)
- `server/src/utils/version.ts`: `GITHUB_REPO` → `tasinxxx/Blaxin` (runtime `/api/update/check` now targets the real repo).
- `src-tauri/src/update.rs`: `DEFAULT_UPDATE_ENDPOINT`, `RELEASE_BASE`, `EXPECTED_REPO`, endpoint allowlist → `tasinxxx/Blaxin` (.deb updater refuses releases from any other repo).
- `src-tauri/tauri.conf.json`: updater endpoint → `tasinxxx/Blaxin` (AppImage updater manifest).
- `.github/workflows/release.yml`: manifest URLs + release-body install URL now use `${{ github.repository }}` (self-healing — always matches the real repo).
- `scripts/release.sh`: manifest URLs → `tasinxxx/Blaxin`.
- `blaxin/install.sh`: `REPO=` + docs → `tasinxxx/Blaxin`.
- `blaxin/update/latest.json`: URLs → `tasinxxx/Blaxin`; `vv1.2.0` → `v1.2.0`.
- `blaxin/update/validate-latest-json.sh` + `build-manifest.py` (comment): URL prefixes → `tasinxxx/Blaxin`.
- `blaxin/.secrets/update-signing-key.txt`: chmod 664 → 600 (updater private key no longer world-readable; file is gitignored/untracked).
- `server/src/orchestrator/index.ts` + `server/src/distributed/brain-drivers.ts`: added an explicit TRUST BOUNDARY / prompt-injection instruction to both system prompts (embedded orchestrator + external Brain): tool output and external content are untrusted DATA, embedded instructions ("ignore previous instructions" etc.) are never followed, external content can't override user instruction/policy, secrets never revealed regardless of claims. Verifies the audit's "prompt injection boundary: PARTIAL → now explicit."

### Evidence
- `grep -rln alex34301430` over source (ts/tsx/rs/json/yml/md/sh/py, excluding node_modules/target/dist): **0 matches**.
- `bash blaxin/update/validate-latest-json.sh blaxin/update/latest.json 1.2.0` → **Validation PASSED**.
- Server `tsc --noEmit` clean; client `npm run build` clean; `cargo check` clean (blaxin v1.2.0).
- Server tests: 311 passed / 1 skipped on the post-hardening run (the wss-transport real-TLS test flaked once under full-suite load in an earlier run — passes in isolation 4/4 and passed in the final run; pre-existing timing flake, unrelated to these changes).

### Remaining risk
- None material. The committed `latest.json` still describes the released v1.2.0 artifacts (URLs now canonical); CI regenerates it on the next tagged release.

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

## BLANK-GUI DIAGNOSIS (v1.1.0 AppImage) — 2026-09-03

**Symptom**: v1.1.0 AppImage on Kali: backend starts (`[BLAXIN] Server is ready!`),
window opens but is completely blank. stderr shows:
`Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...` plus
harmless gvfs/atk-bridge noise.

**Root cause (proven, reproduced on a modern Debian box, same X display):**
The Tauri/linuxdeploy AppImage bundles the CI runner's (ubuntu-22.04, jammy)
WebKitGTK/GTK/GLib stack — `usr/lib/libwebkit2gtk-4.1.so.0`, GTK 3.24.33,
GLib 2.72-ish, and jammy's `WebKitWebProcess`/`WebKitNetworkProcess` helpers.
On hosts where that bundled WebKitWebProcess cannot create a default EGL
display (newer host Mesa, virtual/headless GPU, Xvfb), it aborts before any
web content is rendered. The window then stays uniformly blank (#353535) while
the bundled Node server keeps running. The abort string lives in the bundled
`libwebkit2gtk-4.1.so.0`. Known upstream limitation: tauri-apps/tauri#11988
(closed "upstream / not planned"); same class as devpod#1767, yaak reports.

**Not the cause**: app code (CSP, endpoints, backend URL — all verified fine);
`WEBKIT_DISABLE_DMABUF_RENDERER=1`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`,
`LIBGL_ALWAYS_SOFTWARE=1` do NOT help (tested).

**Evidence matrix (all on the same machine/display):**
- v1.1.0 AppImage as shipped → WebKitWebProcess aborts (EGL), blank window.
- Same AppImage binary with `LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu`
  (system WebKitGTK 2.52.5) → WebKitWebProcess runs, UI renders.
- v1.1.0 `.deb` binary (system WebKitGTK; Depends on `libwebkit2gtk-4.1-0`
  is correct) → UI renders.

**Action for the user (no release needed):** install the `.deb` on
Debian/Ubuntu/Kali (system WebKitGTK), not the AppImage. README now documents
this.

**If the AppImage must work everywhere**: the fix is a build-pipeline change
for a FUTURE release — make the AppImage use the host's system WebKitGTK
(e.g. exclude the WebKit/GTK/GLib stack from linuxdeploy bundling, mirroring
the .deb behavior) or move the primary Linux distribution channel to the .deb.
Not done yet; no new release was cut for this diagnosis.

## V1.1.1 PRODUCTION FIX SESSION — 2026-09-03 (afternoon)

### Done and verified this session
- **Launcher/menu-click fix**: root cause confirmed — `/usr/local/bin/blaxin` (a stale Bengali USB-pendrive launcher script, 952 B) shadows the real `/usr/bin/blaxin` (v1.1.0 .deb binary) in PATH, so the installed `BLAXIN.desktop` (`Exec=blaxin`) launched the wrong program. Fix: move the stale file aside to `/usr/local/bin/blaxin.bak-usb-launcher` (backup) so `Exec=blaxin` resolves to `/usr/bin/blaxin`. Installer now also auto-moves stale `/usr/local/bin/blaxin` after a .deb install.
- **Version 1.1.1 everywhere**: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (+ Cargo.lock), `client/package.json` (+ lockfile), `server/package.json` (+ lockfile), `server/src/utils/version.ts` (`APP_VERSION='1.1.1'`), `resources/blaxin-server/package.json`, client Sidebar label (`BLAXIN</- v1.1.1`). Only remaining `1.0.0` is `session-state.ts` state-schema marker (not user-facing; CI never bumps it). `release.yml` now keeps the Sidebar label in sync on future releases.
- **Branding**: exact `BLAXIN</-` wordmark in Sidebar header, Sidebar footer, SetupWizard title, ChatPanel welcome header, window title (`BLAXIN</- — AI Desktop Agent`), tray tooltip, repo `blaxin.desktop`, install.sh desktop entry, README H1. (Deb menu entry keeps `Name=BLAXIN` — Tauri derives it from productName, which must stay `BLAXIN` because it names the binary.)
- **Icons**: all four `src-tauri/icons/*.png` (32/128/256/512) regenerated from the exact official logo (`/home/tsn/Downloads/ChatGPT Image Sep 3, 2026, 04_30_12 PM.png`, 1254×1254 RGBA); verified pixel-identical to direct resizes (AE=0 for all sizes). Bundled into the new deb at every hicolor size.
- **install.sh distro-aware**: Debian-family (Debian/Ubuntu/Kali/Mint/Pop!_OS, detected via `/etc/debian_version` or dpkg+apt-get) installs the `.deb` via `dpkg -i` (auto `apt-get install -f -y` if deps missing) — system WebKitGTK, avoiding the AppImage EGL blank-window issue. AppImage path preserved (default on non-Debian) plus `--appimage` flag to force. Stale-launcher guard added. Fixes a latent no-jq fallback bug (grep no-match no longer kills the script under `set -euo pipefail`).
- **Tests/builds**: server `tsc --noEmit` clean; server `npm test` → 9 files, 75 tests PASS; server `npm run build` clean; client `npm run build` clean (714 kB chunk warning, known). Installer functionally tested end-to-end against a local mock GitHub release (deb selection, `--appimage` force, no-deb fallback, `--help`) — all correct.
- **Local .deb build + real launch**: `cargo tauri build --bundles deb` compiled (blaxin v1.1.1) and produced `target/release/bundle/deb/BLAXIN_1.1.1_amd64.deb` (39 MB; Depends auto-injected: libwebkit2gtk-4.1-0, libgtk-3-0, libayatana-appindicator3-1). Extracted and launched on DISPLAY=:0: bundled node+server found, `[BLAXIN] Server is ready!`, `/api/health` → `{"status":"ok","version":"1.1.1",...}`, window `BLAXIN</- — AI Desktop Agent` rendered (screenshot + OCR show the sidebar wordmark). Build exits 1 at the end only because Tauri wants `TAURI_SIGNING_PRIVATE_KEY` for updater artifacts — CI has it; the deb itself is complete and unsigned-deb-safe.

### Remaining (needs user sudo password — cannot run non-interactively)
- [ ] `sudo mv /usr/local/bin/blaxin /usr/local/bin/blaxin.bak-usb-launcher`
- [ ] `sudo dpkg -i /home/tsn/Blaxin/blaxin/src-tauri/target/release/bundle/deb/BLAXIN_1.1.1_amd64.deb`
- [ ] Final re-verify after install (`dpkg -s blaxin` → 1.1.1, `which blaxin` → /usr/bin/blaxin, launch + health)
- [ ] Git commit of this session's changes; then (separately) tag v1.1.1 and let CI release — NOT done per instructions

## REMAINING WORK (older, still open)
- [ ] Docs pass: README updated; final polish of README wording if needed
- [ ] Voice wake-word / interruption polish (architecture present via Web Speech API; not e2e-verified)
- [ ] latest.json refresh happens automatically on the next successful tagged release (CI commits it back to main)

## KNOWN ISSUES (still open)
- `blaxin/update/latest.json` is stale (v1.0.2, empty signature); CI refreshes it on the next successful tagged release.
- Version constants in-repo are 1.0.0; the release workflow bumps them during CI. Sidebar shows v1.0.0 in dev — cosmetic until next release.
- Client bundle ~714 kB (min) — chunk-split optimization deferred.
- Terminal panel uses pipes (no PTY): full-screen TUI apps may render imperfectly; interactive apps rely on `signal` messages.
- Ollama/Anthropic/Gemini tool-call replay is implemented per their documented wire formats but has not been exercised against live APIs (no keys); the OpenAI-compatible path is the best-tested.
