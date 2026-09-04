// BLAXIN distributed E2E — TWO REAL PROCESSES
// =============================================================
// Process A = a standalone BLAXIN Brain (brain-main.ts, its own data dir)
// Process B = a full BLAXIN Body server (index.ts, external mode)
//
// The test drives both over real HTTP + WebSocket:
//   1. Start the Brain and generate a pairing code (POST /pairing/start)
//   2. Start the Body in external mode pointing at the Brain URL
//   3. Pair the Body (POST /api/brain/connect with the one-time code)
//   4. Wait for CONNECTED (identity auth + protocol negotiation + caps)
//   5. Send a real task over the Body UI WebSocket
//   6. Brain requests an allowed deterministic action → Body executes the
//      real filesystem tool → Brain verifies → task completes
//   7. Restart the Body → it reconnects with identity auth (no code)
//   8. Restart the Brain → the Body auto-reconnects and state reconciles
//   9. Revoke the Body → reconnect is permanently rejected
// =============================================================

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
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
      // Clean vitest-specific state vars so children use their own dirs.
      BLAXIN_MEMORY_FILE: undefined,
      BLAXIN_TELEMETRY_FILE: undefined,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  logs.set(name, '');
  const origPush = (chunk: string) => { logs.set(name, (logs.get(name) || '') + chunk); };
  child.stdout.on('data', (d) => origPush(d.toString()));
  child.stderr.on('data', (d) => origPush(d.toString()));
  child.on('exit', (code) => {
    // Keep the last log around for failure diagnostics.
    if (log) logs.set(name, (logs.get(name) || '') + `\n[exit ${code}]\n`);
  });
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

afterAll(async () => {
  for (const child of children.splice(0)) await kill(child);
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}, 30_000);

describe('distributed E2E (two real processes)', () => {
  it('pairs, runs a real task, survives Body + Brain restarts, and rejects revoked devices', async () => {
    const brainDir = tmpDir('e2e-brain-');
    const bodyDir = tmpDir('e2e-body-');
    const marker = join(brainDir, 'marker.txt');
    writeFileSync(marker, 'two-process-e2e-marker');

    const brainPort = await freePort();
    const bodyPort = await freePort();

    // ── 1. Start the Brain ──────────────────────────────────────
    const brainEnv = {
      BLAXIN_BRAIN_HOST: '127.0.0.1',
      BLAXIN_BRAIN_PORT: String(brainPort),
      BLAXIN_DATA_DIR: brainDir,
      BLAXIN_BRAIN_DEFAULT_DRIVER: 'deterministic',
      BLAXIN_BRAIN_DETERMINISTIC_STEPS: JSON.stringify([
        { tool: 'filesystem', args: { operation: 'read', path: marker }, description: 'read the marker file' },
      ]),
    };
    let brainProc = spawnProc('brain', 'src/brain-main.ts', brainEnv);
    const brainBase = `http://127.0.0.1:${brainPort}`;
    await waitForHttp(`${brainBase}/health`, 20_000);

    // Health endpoints of the standalone Brain runtime.
    const health = await getJson(`${brainBase}/health`);
    expect(health.role).toBe('brain');
    const version = await getJson(`${brainBase}/version`);
    expect(version.brainId).toMatch(/^BLX-BRAIN-/);
    const proto = await getJson(`${brainBase}/protocol`);
    expect(proto.version).toBe(1);

    // 2. Generate a one-time pairing code (loopback admin endpoint).
    const pair = await postJson(`${brainBase}/pairing/start`, {});
    const code = pair.code as string;
    const brainId = pair.brainId as string;
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // ── 3. Start the Body (external mode, pointing at the Brain) ──
    const bodyEnv = {
      BLAXIN_HOST: '127.0.0.1',
      PORT: String(bodyPort),
      BLAXIN_DATA_DIR: bodyDir,
      BLAXIN_BRAIN_MODE: 'external',
      BLAXIN_BRAIN_URL: `ws://127.0.0.1:${brainPort}/ws/brain`,
      BLAXIN_BODY_NAME: 'E2E Test Body',
    };
    let bodyProc = spawnProc('body', 'src/index.ts', bodyEnv);
    const bodyBase = `http://127.0.0.1:${bodyPort}`;
    await waitForHttp(`${bodyBase}/api/health`, 20_000);

    // ── 4. Pair the Body with the one-time code ─────────────────
    await postJson(`${bodyBase}/api/brain/connect`, {
      url: `ws://127.0.0.1:${brainPort}/ws/brain`,
      code,
    });
    await poll(async () => {
      const status = await getJson(`${bodyBase}/api/brain/status`);
      return status.brain?.state === 'CONNECTED';
    }, 15_000, 'body CONNECTED to brain');
    let bodyId = (await getJson(`${bodyBase}/api/brain/status`)).bodyId as string;
    expect(bodyId).toMatch(/^BLX-BODY-/);
    expect((await getJson(`${bodyBase}/api/brain/status`)).brain?.brainId).toBe(brainId);

    // ── 5+6. Send a real task via the UI WebSocket ──────────────
    const events: Array<{ event: string; data: any }> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${bodyPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.on('message', (data) => {
      try { events.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    ws.send(JSON.stringify({ type: 'user-message', data: { content: 'read the marker file for me' } }));

    await poll(async () => events.some((e) => e.event === 'agent-message'), 15_000, 'final agent message');
    const finalMsg = events.find((e) => e.event === 'agent-message');
    expect(JSON.stringify(finalMsg?.data)).toContain('two-process-e2e-marker');
    const taskComplete = events.some((e) => e.event === 'task-complete');
    expect(taskComplete).toBe(true);

    // ── 7. Restart the Body — reconnect with identity, no code ──
    ws.close();
    await kill(bodyProc);
    children.splice(children.indexOf(bodyProc), 1);

    bodyProc = spawnProc('body', 'src/index.ts', bodyEnv);
    await waitForHttp(`${bodyBase}/api/health`, 20_000);
    await poll(async () => {
      const status = await getJson(`${bodyBase}/api/brain/status`);
      return status.brain?.state === 'CONNECTED';
    }, 15_000, 'body reconnected after restart');
    const bodyStatus = await getJson(`${bodyBase}/api/brain/status`);
    expect(bodyStatus.bodyId).toBe(bodyId); // identity persisted across restart
    expect(bodyStatus.brain?.brainId).toBe(brainId);

    // ── 8. Restart the Brain — the Body auto-reconnects ─────────
    await kill(brainProc);
    children.splice(children.indexOf(brainProc), 1);
    brainProc = spawnProc('brain', 'src/brain-main.ts', brainEnv);
    await waitForHttp(`${brainBase}/health`, 20_000);
    // The Body's link auto-reconnects with backoff and identity auth.
    await poll(async () => {
      const status = await getJson(`${bodyBase}/api/brain/status`);
      return status.brain?.state === 'CONNECTED' && status.brain?.brainId === brainId;
    }, 30_000, 'body auto-reconnected to restarted brain');

    // ── 9. Revoke the Body — old credentials must never work again ──
    const revoke = await postJson(`${brainBase}/devices/${bodyId}/revoke`, {});
    expect(revoke.success).toBe(true);
    await poll(async () => {
      const status = await getJson(`${bodyBase}/api/brain/status`);
      return status.brain?.state === 'REVOKED';
    }, 15_000, 'body sees REVOKED');
    // Attempt a reconnect: must stay rejected.
    await postJson(`${bodyBase}/api/brain/reconnect`, {});
    await poll(async () => {
      const status = await getJson(`${bodyBase}/api/brain/status`);
      return status.brain?.state === 'REVOKED';
    }, 15_000, 'revoked body cannot reconnect');
    expect(existsSync(marker)).toBe(true);
  }, 120_000);
});
