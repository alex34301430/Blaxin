// BLAXIN Brain-status lifecycle — deterministic state-machine tests
// =============================================================
// The UI is a thin mirror of the server-owned connection state machine:
//   - REST /api/brain/status serializes RemoteBrainDriver.status()
//   - WebSocket 'brain-status' pushes are RemoteBrainDriver's onEvent
// So the honest, deterministic place to test the states the UI renders
// (CONNECTED / DISCONNECTED / RECONNECTING / DEGRADED / REVOKED /
// INCOMPATIBLE / ERROR + stale-error clearing) is right here against
// real sockets — no credentials, no faked status.
//
// Fake servers in this file speak just enough of Brain Protocol v1 to
// exercise a specific failure (a mute server for heartbeat DEGRADED, an
// incompatible-protocol brain, and a non-brain endpoint).
// =============================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { BrainRuntime } from '../../distributed/brain-runtime.js';
import { DeterministicDriver } from '../../distributed/brain-drivers.js';
import { RemoteBrainDriver } from '../../distributed/remote-brain.js';
import { BodyState } from '../../distributed/body-state.js';
import { loadOrCreateIdentity } from '../../distributed/identity.js';
import { createMessage } from '../../distributed/protocol.js';
import type { DeviceIdentity } from '../../distributed/identity.js';

const tmpDirs: string[] = [];
const runtimes: BrainRuntime[] = [];
const drivers: RemoteBrainDriver[] = [];
const fakeServers: WebSocketServer[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const s of fakeServers.splice(0)) {
    try { await new Promise<void>((r) => s.close(() => r())); } catch { /* ignore */ }
  }
  for (const d of drivers.splice(0)) d.disconnect();
  for (const r of runtimes.splice(0)) await r.stop();
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

interface BrainHandle { runtime: BrainRuntime; wsUrl: string }

async function makeBrain(opts: { port?: number; dir?: string; steps?: Array<{ tool: string; args: Record<string, unknown>; description: string }> } = {}): Promise<BrainHandle> {
  const dir = opts.dir ?? tmpDir('blaxin-brain-');
  const runtime = new BrainRuntime({
    host: '127.0.0.1',
    port: opts.port ?? 0,
    identityFile: join(dir, 'brain-identity.json'),
    registryFile: join(dir, 'devices.json'),
    drivers: new Map([['deterministic', new DeterministicDriver({ steps: opts.steps ?? [] })]]),
    defaultDriverId: 'deterministic',
  });
  runtimes.push(runtime);
  const info = await runtime.start();
  return { runtime, wsUrl: info.wsUrl };
}

interface TestBody {
  identity: DeviceIdentity;
  driver: RemoteBrainDriver;
  events: Array<{ event: string; data: any }>;
}

async function makeBody(
  dir: string,
  url: string,
  extra: { heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number; autoReconnect?: boolean } = {},
): Promise<TestBody> {
  const identity = loadOrCreateIdentity({ filePath: join(dir, 'body-identity.json'), role: 'body', name: 'Status Test Body' });
  const events: Array<{ event: string; data: any }> = [];
  const driver = new RemoteBrainDriver({
    identity,
    url,
    state: new BodyState(dir),
    onEvent: (event, data) => { events.push({ event, data }); },
    autoReconnect: extra.autoReconnect ?? true,
    heartbeatIntervalMs: extra.heartbeatIntervalMs,
    heartbeatTimeoutMs: extra.heartbeatTimeoutMs,
  });
  drivers.push(driver);
  return { identity, driver, events };
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function hasEvent(events: Array<{ event: string; data: any }>, event: string, predicate?: (d: any) => boolean): boolean {
  return events.some((e) => e.event === event && (!predicate || predicate(e.data)));
}

function lastStatus(driver: RemoteBrainDriver): any {
  return driver.status().brain as any;
}

/** Raw fake Brain that answers a Body hello with ONE canned hello frame.
 * The envelope deviceId must satisfy wire validation (BLX-BRAIN-*); the
 * payload deviceId is what the driver's protocol layer inspects, so it
 * can be made invalid to exercise the "not a BLAXIN Brain" rejection. */
function startFakeBrain(reply: (bodyHello: any) => {
  id: string; name: string; protocolMin: number; protocolMax: number; mode: string; payloadDeviceId?: string;
} | null): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const srv = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    fakeServers.push(srv);
    srv.on('listening', () => {
      const actualPort = (srv.address() as { port: number }).port;
      resolve({ url: `ws://127.0.0.1:${actualPort}/ws/brain` });
    });
    srv.on('connection', (ws: WebSocket, req) => {
      let pathname = '';
      try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { pathname = ''; }
      if (pathname !== '/ws/brain') { ws.close(); return; }
      ws.on('message', (data) => {
        let msg: any = null;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg?.type !== 'hello') return; // pairing/auth chatter is irrelevant to these failure modes
        const r = reply(msg);
        if (!r) return;
        ws.send(JSON.stringify(createMessage('brain', r.id, 'hello', {
          deviceId: r.payloadDeviceId ?? r.id,
          name: r.name,
          protocolMin: r.protocolMin,
          protocolMax: r.protocolMax,
          mode: r.mode,
        })));
      });
    });
  });
}

/** A Brain that accepts the socket but never sends a frame (silent peer). */
function startMuteServer(): Promise<{ url: string; server: WebSocketServer }> {
  return new Promise((resolve) => {
    const srv = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    fakeServers.push(srv);
    srv.on('listening', () => {
      const actualPort = (srv.address() as { port: number }).port;
      resolve({ url: `ws://127.0.0.1:${actualPort}/ws/brain`, server: srv });
    });
    srv.on('connection', () => { /* intentionally silent */ });
  });
}

describe('brain status lifecycle (deterministic, real sockets)', () => {
  it('CONNECTED: fresh pairing mirrors into status + brain-status events with no stale error', async () => {
    const dir = tmpDir('blaxin-body-');
    const { runtime, wsUrl } = await makeBrain();
    const { identity, driver, events } = await makeBody(dir, wsUrl);
    const code = runtime.generatePairingCode()?.code as string;

    driver.connect(code);
    await waitFor(() => driver.isReady(), 10_000, 'CONNECTED after pairing');

    // API snapshot mirror (this is what /api/brain/status serializes).
    const s = lastStatus(driver);
    expect(driver.status().mode).toBe('external');
    expect(driver.status().bodyId).toBe(identity.id);
    expect(s.state).toBe('CONNECTED');
    expect(s.brainId).toBe(runtime.identity.id);
    expect(s.protocol).toBe(1);
    expect(s.transport).toBe('ws');
    expect(s.url).toBe(wsUrl);
    expect(s.connectedAt).toBeGreaterThan(0);
    expect(typeof s.sessionId).toBe('string');
    expect(s.lastError).toBeNull();

    // The exact event the UI WebSocket receives.
    expect(hasEvent(events, 'brain-status', (d) => d.state === 'CONNECTED' && d.brainId === runtime.identity.id)).toBe(true);
    // Clean handshake — nothing failed, nothing faked.
    expect(hasEvent(events, 'error')).toBe(false);
    expect(driver.getState()).toBe('CONNECTED');
  });

  it('DISCONNECTED: a manual disconnect reports an honest offline state, and identity auth reconnects', async () => {
    const dir = tmpDir('blaxin-body-');
    const { runtime, wsUrl } = await makeBrain();
    const { driver } = await makeBody(dir, wsUrl);
    const code = runtime.generatePairingCode()?.code as string;

    driver.connect(code);
    await waitFor(() => driver.isReady(), 10_000, 'first CONNECTED');

    driver.disconnect();
    await waitFor(() => driver.getState() === 'DISCONNECTED', 5_000, 'DISCONNECTED after manual disconnect');
    expect(lastStatus(driver).state).toBe('DISCONNECTED');
    expect(driver.isReady()).toBe(false);

    // Let the old socket's close event fully settle so a fast reconnect
    // can never race the stale close into a duplicate reconnect.
    await new Promise((r) => setTimeout(r, 200));

    // Reconnect with identity only — no pairing code.
    driver.connect();
    await waitFor(() => driver.isReady(), 10_000, 'reconnected by identity');
    expect(lastStatus(driver).state).toBe('CONNECTED');
  });

  it('clears stale errors when a connection is established again after re-pairing', async () => {
    const dir = tmpDir('blaxin-body-');
    const { runtime, wsUrl } = await makeBrain();
    const { driver } = await makeBody(dir, wsUrl);
    const code1 = runtime.generatePairingCode()?.code as string;

    driver.connect(code1);
    await waitFor(() => driver.isReady(), 10_000, 'CONNECTED');
    expect(lastStatus(driver).lastError).toBeNull();

    // Unpair on the Body: DISCONNECTED with an explanatory note surfaced
    // as lastError (server-owned snapshot, shown in the UI error banner).
    driver.forgetPairing();
    expect(driver.getState()).toBe('DISCONNECTED');
    expect(String(lastStatus(driver).lastError || '')).toMatch(/pairing cleared/i);

    // The Brain must also forget the device before a fresh code works.
    runtime.registry.remove(driver.status().bodyId as string);
    const code2 = runtime.generatePairingCode()?.code as string;
    driver.connect(code2);
    await waitFor(() => driver.isReady(), 10_000, 're-paired with a fresh code');
    // A successful connection MUST clear the stale error.
    expect(lastStatus(driver).state).toBe('CONNECTED');
    expect(lastStatus(driver).lastError).toBeNull();
  });

  it('RECONNECTING while the Brain is down, then CONNECTED after it restarts (same identity, same URL)', async () => {
    const port = await freePort();
    const brainDir = tmpDir('blaxin-brain-restart-');
    const bodyDir = tmpDir('blaxin-body-');
    const { runtime, wsUrl } = await makeBrain({ port, dir: brainDir });
    const { driver, events } = await makeBody(bodyDir, wsUrl);
    const code = runtime.generatePairingCode()?.code as string;

    driver.connect(code);
    await waitFor(() => driver.isReady(), 10_000, 'CONNECTED before drop');
    const brainId = runtime.identity.id;

    // Drop the Brain: the link must honestly report RECONNECTING (never a
    // fake healthy state).
    await runtime.stop();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await waitFor(() => lastStatus(driver).state === 'RECONNECTING', 15_000, 'RECONNECTING after brain drop');
    expect(hasEvent(events, 'brain-status', (d) => d.state === 'RECONNECTING')).toBe(true);
    expect(driver.status().bodyId).toMatch(/^BLX-BODY-/);

    // Restart the Brain on the same port with the same persisted identity
    // + device registry — the Body auto-reconnects by identity, no code.
    const restarted = await makeBrain({ port, dir: brainDir });
    await waitFor(() => lastStatus(driver).state === 'CONNECTED' && lastStatus(driver).brainId === brainId, 20_000, 'auto-reconnect after brain restart');
    expect(restarted.runtime.identity.id).toBe(brainId); // persisted identity survived
    expect(lastStatus(driver).lastError).toBeNull();
  });

  it('DEGRADED: a silent peer is marked degraded and dropped (honest state, no fake CONNECTED)', async () => {
    const dir = tmpDir('blaxin-body-');
    const { url } = await startMuteServer();
    // Shortened heartbeat cadence keeps the test fast; semantics unchanged.
    // We assert on the recorded event (atomic at the instant DEGRADED was
    // set) rather than racing the transient status: the link immediately
    // tears down and auto-reconnects, so polling can miss the window.
    const { driver, events } = await makeBody(dir, url, { heartbeatIntervalMs: 50, heartbeatTimeoutMs: 200 });

    driver.connect();
    await waitFor(() => hasEvent(events, 'brain-status', (d) => d.state === 'DEGRADED'), 12_000, 'DEGRADED after heartbeat timeout');
    const degraded = events.find((e) => e.event === 'brain-status' && (e.data as any)?.state === 'DEGRADED');
    expect(String((degraded?.data as any)?.reason || '')).toMatch(/heartbeat/i);
    // Honest: the link never reported CONNECTED and is not ready.
    expect(hasEvent(events, 'brain-status', (d) => d.state === 'CONNECTED')).toBe(false);
    expect(driver.isReady()).toBe(false);
    expect(lastStatus(driver).lastError).toBeNull(); // DEGRADED is transient — not an error banner
  }, 20_000);

  it('REVOKED is terminal and keeps its error — it never falls back to disconnected/healthy', async () => {
    const dir = tmpDir('blaxin-body-');
    const { runtime, wsUrl } = await makeBrain();
    const { driver, events } = await makeBody(dir, wsUrl);
    const code = runtime.generatePairingCode()?.code as string;

    driver.connect(code);
    await waitFor(() => driver.isReady(), 10_000, 'CONNECTED before revoke');
    const bodyId = driver.status().bodyId as string;

    expect(runtime.revokeBody(bodyId)).toBe(true);
    await waitFor(() => lastStatus(driver).state === 'REVOKED', 10_000, 'REVOKED surfaced');
    expect(String(lastStatus(driver).lastError || '')).toMatch(/revok/i);
    expect(hasEvent(events, 'brain-status', (d) => d.state === 'REVOKED')).toBe(true);

    // Explicit reconnect attempts must keep it REVOKED (sticky terminal).
    driver.connect();
    await waitFor(() => lastStatus(driver).state === 'REVOKED', 8_000, 'revoked stays revoked');
    expect(lastStatus(driver).state).toBe('REVOKED');
    expect(String(lastStatus(driver).lastError || '')).toMatch(/revok/i);
    expect(runtime.isBodyConnected(bodyId)).toBe(false);
  });

  it('INCOMPATIBLE is terminal and explains the protocol mismatch — no reconnect storm', async () => {
    const dir = tmpDir('blaxin-body-');
    const fake = await startFakeBrain(() => ({
      id: 'BLX-BRAIN-FAKE', name: 'Too-New Brain', protocolMin: 2, protocolMax: 3, mode: 'auth',
    }));
    const { driver, events } = await makeBody(dir, fake.url);

    driver.connect();
    await waitFor(() => lastStatus(driver).state === 'INCOMPATIBLE', 8_000, 'INCOMPATIBLE after protocol mismatch');
    expect(hasEvent(events, 'error', (d) => d.code === 'INCOMPATIBLE')).toBe(true);
    expect(String(events.find((e) => e.event === 'error')?.data?.message || '')).toMatch(/protocol/i);

    // Retrying must stay INCOMPATIBLE (never reconnect into the mismatch).
    driver.connect();
    await waitFor(() => lastStatus(driver).state === 'INCOMPATIBLE', 5_000, 'incompatible stays incompatible');
    expect(driver.isReady()).toBe(false);
  });

  it('ERROR handling: an endpoint that is not a BLAXIN Brain is refused with a clear, safe message', async () => {
    const dir = tmpDir('blaxin-body-');
    const fake = await startFakeBrain(() => ({
      id: 'BLX-BRAIN-FAKE',
      payloadDeviceId: 'not-a-blaxin-brain', // spoofed payload identity fails the brain check
      name: 'Web Server', protocolMin: 1, protocolMax: 1, mode: 'pair',
    }));
    const { driver, events } = await makeBody(dir, fake.url);

    driver.connect();
    await waitFor(() => hasEvent(events, 'error', (d) => d.code === 'NOT_A_BRAIN'), 8_000, 'NOT_A_BRAIN error');
    expect(String(lastStatus(driver).lastError || '')).toMatch(/not a BLAXIN Brain/i);
    expect(driver.isReady()).toBe(false);
    // The identity was never stored as a Brain pairing.
    expect(driver.status().bodyId).toMatch(/^BLX-BODY-/);
    expect(hasEvent(events, 'brain-status', (d) => d.state === 'CONNECTED')).toBe(false);
  });
});

