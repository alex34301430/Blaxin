// BLAXIN Brain-status UI synchronization — two-process (real Body server)
// =============================================================
// The UI mirrors server-owned state, refreshed by REST polling
// (/api/brain/status) and by WebSocket pushes (the body server relays the
// remote-Brain driver's 'brain-status' events to /ws clients). This file
// exercises exactly that boundary with real processes:
//
//   Test 1 — EMBEDDED (local) mode: /api/brain/status and the WebSocket
//            'connected' payload report mode=embedded and NO fabricated
//            external brain/link state.
//   Test 2 — EXTERNAL mode: the UI WebSocket sees the full lifecycle as
//            authoritative pushes + REST snapshots: CONNECTED →
//            RECONNECTING (brain down) → CONNECTED (brain back) →
//            REVOKED (terminal, survives reconnect, never reads healthy).
//
// No real credentials; the Brain runs its deterministic driver.
// =============================================================

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'net';
import WebSocket from 'ws';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TSX = join(SERVER_ROOT, 'node_modules', '.bin', 'tsx');

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];
const logs = new Map<string, string>();

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function spawnProc(name: string, entry: string, env: Record<string, string>): ChildProcess {
  const child = spawn(TSX, [entry], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      BLAXIN_MEMORY_FILE: undefined,
      BLAXIN_TELEMETRY_FILE: undefined,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.set(name, (logs.get(name) || '') + d.toString()));
  child.stderr.on('data', (d) => logs.set(name, (logs.get(name) || '') + d.toString()));
  children.push(child);
  return child;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${url}\n--- logs ---\n${dumpLogs()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${JSON.stringify(json)}\n--- logs ---\n${dumpLogs()}`);
  return json;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function poll(fn: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}\n--- logs ---\n${dumpLogs()}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function kill(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

function dumpLogs(): string {
  const out: string[] = [];
  for (const [name, log] of logs) {
    out.push(`===== ${name} logs =====\n${log.slice(-4000)}`);
  }
  return out.join('\n');
}

function openUiSocket(base: string): Promise<{ ws: WebSocket; events: Array<{ event: string; data: any }> }> {
  return new Promise((resolve, reject) => {
    const events: Array<{ event: string; data: any }> = [];
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
    ws.on('message', (data) => {
      try { events.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    ws.on('open', () => resolve({ ws, events }));
    ws.on('error', reject);
  });
}

function hasEvent(events: Array<{ event: string; data: any }>, event: string, predicate?: (d: any) => boolean): boolean {
  return events.some((e) => e.event === event && (!predicate || predicate(e.data)));
}

function closeWs(ws: WebSocket): void {
  try { ws.close(); } catch { /* ignore */ }
}

afterAll(async () => {
  for (const child of children.splice(0)) await kill(child);
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}, 30_000);

describe('brain status UI synchronization (real processes)', () => {
  it('EMBEDDED mode reports a local Brain and never fabricates an external link', async () => {
    const bodyDir = tmpDir('ui-embedded-');
    const bodyPort = await freePort();
    const bodyProc = spawnProc('embedded-body', 'src/index.ts', {
      BLAXIN_HOST: '127.0.0.1',
      PORT: String(bodyPort),
      BLAXIN_DATA_DIR: bodyDir,
      BLAXIN_BRAIN_MODE: 'embedded', // local orchestrator acts as the Brain
      BLAXIN_BODY_NAME: 'Embedded Test Body',
    });
    const bodyBase = `http://127.0.0.1:${bodyPort}`;
    await waitForHttp(`${bodyBase}/api/health`, 20_000);

    // REST: honest local mode — mode=embedded, no external brain payload.
    const rest = await getJson(`${bodyBase}/api/brain/status`);
    expect(rest.mode).toBe('embedded');
    expect(rest.brain).toBeUndefined();

    // WebSocket: the 'connected' payload mirrors the same honest snapshot.
    const { ws, events } = await openUiSocket(bodyBase);
    await poll(async () => hasEvent(events, 'connected'), 5_000, 'connected event');
    const connected = events.find((e) => e.event === 'connected')?.data ?? {};
    expect(connected.mode).toBe('embedded');
    expect(connected.bodyId).toBeNull();
    expect(connected.brain).toBeNull();

    // Embedded mode never pushes external link state changes.
    await new Promise((r) => setTimeout(r, 600));
    expect(hasEvent(events, 'brain-status')).toBe(false);
    closeWs(ws);

    const after = await getJson(`${bodyBase}/api/brain/status`);
    expect(after.mode).toBe('embedded');
    expect(after.brain).toBeUndefined();
    await kill(bodyProc);
    children.splice(children.indexOf(bodyProc), 1);
  }, 60_000);

  it('EXTERNAL mode: the UI WebSocket + REST mirror CONNECTED → RECONNECTING → CONNECTED → REVOKED', async () => {
    const brainDir = tmpDir('ui-brain-');
    const bodyDir = tmpDir('ui-body-');
    writeFileSync(join(brainDir, 'marker.txt'), 'ui-sync-marker');
    const brainPort = await freePort();
    const bodyPort = await freePort();
    const brainUrl = `ws://127.0.0.1:${brainPort}/ws/brain`;

    // ── Brain (deterministic driver, no credentials) ──────────────
    const brainEnv = {
      BLAXIN_BRAIN_HOST: '127.0.0.1',
      BLAXIN_BRAIN_PORT: String(brainPort),
      BLAXIN_DATA_DIR: brainDir,
      BLAXIN_BRAIN_DEFAULT_DRIVER: 'deterministic',
      BLAXIN_BRAIN_DETERMINISTIC_STEPS: JSON.stringify([]),
    };
    let brainProc = spawnProc('brain', 'src/brain-main.ts', brainEnv);
    const brainBase = `http://127.0.0.1:${brainPort}`;
    await waitForHttp(`${brainBase}/health`, 20_000);

    // ── Body (external mode, auto-connecting to the Brain URL) ────
    const bodyProc = spawnProc('body', 'src/index.ts', {
      BLAXIN_HOST: '127.0.0.1',
      PORT: String(bodyPort),
      BLAXIN_DATA_DIR: bodyDir,
      BLAXIN_BRAIN_MODE: 'external',
      BLAXIN_BRAIN_URL: brainUrl,
      BLAXIN_BODY_NAME: 'UI Sync Body',
    });
    const bodyBase = `http://127.0.0.1:${bodyPort}`;
    await waitForHttp(`${bodyBase}/api/health`, 20_000);

    // Before pairing the link settles at an honest DISCONNECTED
    // (the Brain does not know this Body yet and no code was supplied).
    await poll(async () => {
      const s = await getJson(`${bodyBase}/api/brain/status`);
      return s.mode === 'external' && s.brain?.state === 'DISCONNECTED';
    }, 15_000, 'external mode reports DISCONNECTED before pairing');

    // ── UI WebSocket: connected payload carries the external snapshot ─
    const { ws, events } = await openUiSocket(bodyBase);
    await poll(async () => hasEvent(events, 'connected'), 5_000, 'connected event');
    const initialConnected = events.find((e) => e.event === 'connected')?.data ?? {};
    expect(initialConnected.mode).toBe('external');
    expect(initialConnected.bodyId).toMatch(/^BLX-BODY-/);
    expect(initialConnected.brain?.state).toBe('DISCONNECTED');

    // ── Pair with a one-time code ──────────────────────────────────
    const pair = await postJson(`${brainBase}/pairing/start`, {});
    await postJson(`${bodyBase}/api/brain/connect`, { url: brainUrl, code: pair.code });
    await poll(async () => {
      const s = await getJson(`${bodyBase}/api/brain/status`);
      return s.brain?.state === 'CONNECTED';
    }, 15_000, 'REST CONNECTED after pairing');
    const connected = await getJson(`${bodyBase}/api/brain/status`);
    expect(connected.mode).toBe('external');
    expect(connected.bodyId).toMatch(/^BLX-BODY-/);
    expect(connected.brain?.brainId).toMatch(/^BLX-BRAIN-/);
    expect(connected.brain?.brainId).toBe(pair.brainId);
    expect(connected.brain?.protocol).toBe(1);
    expect(connected.brain?.url).toBe(brainUrl);
    expect(connected.brain?.transport).toBe('ws');
    expect(connected.brain?.sessionId).toBeTruthy();
    expect(connected.brain?.lastError).toBeNull(); // no stale error while healthy

    // The UI WebSocket must have seen the CONNECTED push.
    await poll(async () => hasEvent(events, 'brain-status', (d) => d.state === 'CONNECTED' && d.brainId === pair.brainId), 5_000, 'UI brain-status CONNECTED push');

    // ── Drop the Brain → honest RECONNECTING on REST + UI push ────
    await kill(brainProc);
    children.splice(children.indexOf(brainProc), 1);
    await poll(async () => {
      const s = await getJson(`${bodyBase}/api/brain/status`);
      return s.brain?.state === 'RECONNECTING';
    }, 20_000, 'REST RECONNECTING after brain drop');
    await poll(async () => hasEvent(events, 'brain-status', (d) => d.state === 'RECONNECTING'), 10_000, 'UI brain-status RECONNECTING push');

    // ── Restart the Brain → auto-reconnect (identity, same dir) ───
    brainProc = spawnProc('brain', 'src/brain-main.ts', brainEnv);
    await waitForHttp(`${brainBase}/health`, 20_000);
    await poll(async () => {
      const s = await getJson(`${bodyBase}/api/brain/status`);
      return s.brain?.state === 'CONNECTED' && s.brain?.brainId === pair.brainId;
    }, 30_000, 'REST CONNECTED after brain restart');
    const back = await getJson(`${bodyBase}/api/brain/status`);
    expect(back.brain?.lastError).toBeNull();
    await poll(async () => hasEvent(events, 'brain-status', (d) => d.state === 'CONNECTED'), 10_000, 'UI brain-status CONNECTED after restart');

    // ── Revoke → terminal REVOKED everywhere, survives reconnect ──
    const bodyId = connected.bodyId as string;
    await postJson(`${brainBase}/devices/${bodyId}/revoke`, {});
    await poll(async () => {
      const s = await getJson(`${bodyBase}/api/brain/status`);
      return s.brain?.state === 'REVOKED';
    }, 15_000, 'REST REVOKED');
    const revoked = await getJson(`${bodyBase}/api/brain/status`);
    expect(String(revoked.brain?.lastError || '')).toMatch(/revok/i);
    await poll(async () => hasEvent(events, 'brain-status', (d) => d.state === 'REVOKED'), 10_000, 'UI brain-status REVOKED push');

    // A reconnect request must NOT flip REVOKED back to healthy.
    await postJson(`${bodyBase}/api/brain/reconnect`, {});
    await poll(async () => {
      const s = await getJson(`${bodyBase}/api/brain/status`);
      return s.brain?.state === 'REVOKED';
    }, 15_000, 'revoked survives reconnect');
    closeWs(ws);

    // A freshly opened UI session starts from the authoritative snapshot:
    // still REVOKED — never healthy/disconnected.
    const { ws: ws2, events: events2 } = await openUiSocket(bodyBase);
    await poll(async () => hasEvent(events2, 'connected'), 5_000, 'second connected event');
    const secondConnected = events2.find((e) => e.event === 'connected')?.data ?? {};
    expect(secondConnected.mode).toBe('external');
    expect(secondConnected.brain?.state).toBe('REVOKED');
    closeWs(ws2);
  }, 180_000);
});
