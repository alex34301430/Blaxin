// BLAXIN multi-body E2E — THREE REAL PROCESSES
// =============================================================
// Process 1 = a standalone BLAXIN Brain (brain-main.ts)
// Process 2 = a full BLAXIN Body server (index.ts, external mode) "Body A"
// Process 3 = a second BLAXIN Body server "Body B"
//
// The test drives everything over real HTTP + WebSocket:
//   1. Both Bodies pair with the same Brain (distinct identities)
//   2. The Brain registry lists BOTH bodies (REST snapshot + admin WS)
//   3. Each Body runs a real task on ITS OWN connection and completes
//   4. Realtime registry events (body-added / body-status / body-revoked)
//      are pushed to the management WebSocket with monotonic versions
//   5. Revoking Body A does NOT affect Body B: B stays CONNECTED and can
//      still run tasks; A is terminal REVOKED and cannot reconnect
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
    out.push(`===== ${name} logs =====\n${log.slice(-3000)}`);
  }
  return out.join('\n');
}

function openSocket(url: string): Promise<{ ws: WebSocket; events: Array<{ event: string; data: any }> }> {
  return new Promise((resolve, reject) => {
    const events: Array<{ event: string; data: any }> = [];
    const ws = new WebSocket(url);
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

/** Brain admin WebSocket: frames carry { type, version, bodyId?, body? }
 * (registry realtime channel), unlike the body UI channel's {event,data}. */
interface AdminFrame {
  type: string;
  version?: number;
  bodyId?: string;
  body?: any;
  bodies?: any[];
}

function openAdminSocket(base: string): Promise<{ ws: WebSocket; frames: AdminFrame[] }> {
  return new Promise((resolve, reject) => {
    const frames: AdminFrame[] = [];
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/admin`);
    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed && typeof parsed.type === 'string') frames.push(parsed);
      } catch { /* ignore */ }
    });
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
  });
}

function hasAdminFrame(frames: AdminFrame[], type: string, predicate?: (f: AdminFrame) => boolean): boolean {
  return frames.some((f) => f.type === type && (!predicate || predicate(f)));
}

afterAll(async () => {
  for (const child of children.splice(0)) await kill(child);
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}, 30_000);

describe('multi-body E2E (one Brain, two real Body processes)', () => {
  it('pairs two Bodies, routes tasks per Body, and revokes one without touching the other', async () => {
    const brainDir = tmpDir('e2e-mb-brain-');
    const bodyADir = tmpDir('e2e-mb-bodyA-');
    const bodyBDir = tmpDir('e2e-mb-bodyB-');
    const marker = join(brainDir, 'marker.txt');
    writeFileSync(marker, 'multi-body-e2e-marker');

    const brainPort = await freePort();
    const bodyAPort = await freePort();
    const bodyBPort = await freePort();
    const brainUrl = `ws://127.0.0.1:${brainPort}/ws/brain`;
    const brainBase = `http://127.0.0.1:${brainPort}`;

    // ── 1. Brain (deterministic driver — one read step per task) ──
    const brainEnv = {
      BLAXIN_BRAIN_HOST: '127.0.0.1',
      BLAXIN_BRAIN_PORT: String(brainPort),
      BLAXIN_DATA_DIR: brainDir,
      BLAXIN_BRAIN_DEFAULT_DRIVER: 'deterministic',
      BLAXIN_BRAIN_DETERMINISTIC_STEPS: JSON.stringify([
        { tool: 'filesystem', args: { operation: 'read', path: marker }, description: 'read the marker file' },
      ]),
    };
    spawnProc('brain', 'src/brain-main.ts', brainEnv);
    await waitForHttp(`${brainBase}/health`, 20_000);

    // ── 2+3. Two Body processes (external mode) ───────────────────
    const bodyAEnv = {
      BLAXIN_HOST: '127.0.0.1',
      PORT: String(bodyAPort),
      BLAXIN_DATA_DIR: bodyADir,
      BLAXIN_BRAIN_MODE: 'external',
      BLAXIN_BRAIN_URL: brainUrl,
      BLAXIN_BODY_NAME: 'E2E Body A',
    };
    const bodyBEnv = {
      BLAXIN_HOST: '127.0.0.1',
      PORT: String(bodyBPort),
      BLAXIN_DATA_DIR: bodyBDir,
      BLAXIN_BRAIN_MODE: 'external',
      BLAXIN_BRAIN_URL: brainUrl,
      BLAXIN_BODY_NAME: 'E2E Body B',
    };
    spawnProc('body-a', 'src/index.ts', bodyAEnv);
    spawnProc('body-b', 'src/index.ts', bodyBEnv);
    const bodyABase = `http://127.0.0.1:${bodyAPort}`;
    const bodyBBase = `http://127.0.0.1:${bodyBPort}`;
    await waitForHttp(`${bodyABase}/api/health`, 20_000);
    await waitForHttp(`${bodyBBase}/api/health`, 20_000);

    // ── Management WebSocket BEFORE any pairing: the realtime channel
    // must push body-added live for BOTH bodies (not only via snapshot). ──
    const admin = await openAdminSocket(brainBase);
    await poll(async () => hasAdminFrame(admin.frames, 'snapshot'), 5_000, 'admin snapshot');

    // ── Pair both Bodies with one-time codes ──────────────────────
    const pairA = await postJson(`${brainBase}/pairing/start`, {});
    await postJson(`${bodyABase}/api/brain/connect`, { url: brainUrl, code: pairA.code });
    await poll(async () => {
      const s = await getJson(`${bodyABase}/api/brain/status`);
      return s.brain?.state === 'CONNECTED';
    }, 15_000, 'Body A CONNECTED');
    const bodyAId = (await getJson(`${bodyABase}/api/brain/status`)).bodyId as string;
    expect(bodyAId).toMatch(/^BLX-BODY-/);
    await poll(async () => hasAdminFrame(admin.frames, 'body-added', (f) => f.bodyId === bodyAId), 5_000, 'body-added A');

    const pairB = await postJson(`${brainBase}/pairing/start`, {});
    await postJson(`${bodyBBase}/api/brain/connect`, { url: brainUrl, code: pairB.code });
    await poll(async () => {
      const s = await getJson(`${bodyBBase}/api/brain/status`);
      return s.brain?.state === 'CONNECTED';
    }, 15_000, 'Body B CONNECTED');
    const bodyBId = (await getJson(`${bodyBBase}/api/brain/status`)).bodyId as string;
    expect(bodyBId).toMatch(/^BLX-BODY-/);
    expect(bodyBId).not.toBe(bodyAId);
    await poll(async () => hasAdminFrame(admin.frames, 'body-added', (f) => f.bodyId === bodyBId), 5_000, 'body-added B');

    const versions = admin.frames.map((f) => f.version ?? 0).filter((v) => v > 0);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThanOrEqual(versions[i - 1]);
    }

    // ── Registry snapshot: both Bodies present, both online ───────
    const registry = await getJson(`${brainBase}/devices`);
    expect(registry.version).toBeGreaterThan(0);
    const ids = registry.devices.map((d: any) => d.bodyId).sort();
    expect(ids).toEqual([bodyAId, bodyBId].sort());
    expect(registry.devices.every((d: any) => d.status === 'online')).toBe(true);
    const status = await getJson(`${brainBase}/registry/status`);
    expect(status.total).toBe(2);
    expect(status.online).toBe(2);
    expect(status.revoked).toBe(0);

    // ── Each Body runs a real task on ITS OWN connection ──────────
    const uiA = await openSocket(`${bodyABase.replace(/^http/, 'ws')}/ws`);
    const uiB = await openSocket(`${bodyBBase.replace(/^http/, 'ws')}/ws`);
    uiA.ws.send(JSON.stringify({ type: 'user-message', data: { content: 'read the marker for me' } }));
    await poll(async () => hasEvent(uiA.events, 'agent-message'), 20_000, 'Body A task completes');
    const msgA = JSON.stringify(uiA.events.find((e) => e.event === 'agent-message')?.data || '');
    expect(msgA).toContain('multi-body-e2e-marker');
    expect(hasEvent(uiA.events, 'task-complete')).toBe(true);

    uiB.ws.send(JSON.stringify({ type: 'user-message', data: { content: 'read the marker for me' } }));
    await poll(async () => hasEvent(uiB.events, 'agent-message'), 20_000, 'Body B task completes');
    const msgB = JSON.stringify(uiB.events.find((e) => e.event === 'agent-message')?.data || '');
    expect(msgB).toContain('multi-body-e2e-marker');
    expect(hasEvent(uiB.events, 'task-complete')).toBe(true);

    // ── Revoke Body A only: B stays CONNECTED and fully functional ──
    const revoke = await postJson(`${brainBase}/devices/${bodyAId}/revoke`, {});
    expect(revoke.success).toBe(true);
    await poll(async () => hasEvent(uiA.events, 'brain-status', (d) => d.state === 'REVOKED'), 15_000, 'Body A sees REVOKED');

    // Realtime: the admin channel saw body-revoked with a fresh version.
    await poll(async () => hasAdminFrame(admin.frames, 'body-revoked', (f) => f.bodyId === bodyAId && f.body?.status === 'revoked'), 10_000, 'admin body-revoked event');

    // REST: A revoked, B still online.
    await poll(async () => {
      const r = await getJson(`${brainBase}/devices`);
      const a = r.devices.find((d: any) => d.bodyId === bodyAId);
      const b = r.devices.find((d: any) => d.bodyId === bodyBId);
      return a?.status === 'revoked' && b?.status === 'online';
    }, 15_000, 'registry: A revoked, B online');
    const st = await getJson(`${brainBase}/registry/status`);
    expect(st.total).toBe(2);
    expect(st.revoked).toBe(1);
    expect(st.online).toBe(1);

    // A reconnect attempt must stay REVOKED (terminal).
    await postJson(`${bodyABase}/api/brain/reconnect`, {});
    await poll(async () => {
      const s = await getJson(`${bodyABase}/api/brain/status`);
      return s.brain?.state === 'REVOKED';
    }, 15_000, 'Body A stays REVOKED after reconnect attempt');

    // Body B is untouched: it can run another task after A's revocation.
    uiB.ws.send(JSON.stringify({ type: 'user-message', data: { content: 'read the marker again' } }));
    await poll(async () => {
      const tail = uiB.events.filter((e) => e.event === 'agent-message');
      return tail.length >= 2;
    }, 20_000, 'Body B runs a task after A revocation');
    const bStatus = await getJson(`${bodyBBase}/api/brain/status`);
    expect(bStatus.brain?.state).toBe('CONNECTED');

    // A fresh admin snapshot reflects the terminal revocation (recovery).
    const admin2 = await openAdminSocket(brainBase);
    await poll(async () => hasAdminFrame(admin2.frames, 'snapshot'), 5_000, 'fresh admin snapshot');
    const snap2 = admin2.frames.find((f) => f.type === 'snapshot')!;
    const a2 = (snap2.bodies || []).find((b: any) => b.bodyId === bodyAId);
    const b2 = (snap2.bodies || []).find((b: any) => b.bodyId === bodyBId);
    expect(a2.status).toBe('revoked');
    expect(b2.status).toBe('online');

    closeWs(uiA.ws);
    closeWs(uiB.ws);
    closeWs(admin.ws);
    closeWs(admin2.ws);
  }, 180_000);
});