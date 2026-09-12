// BLAXIN WSS transport — in-process integration tests
// =============================================================
// A real BrainRuntime serving real TLS (throwaway test CA) and a real
// RemoteBrainDriver Body connecting over wss://:
//   - a certificate signed by the trusted CA pairs + authenticates +
//     reconnects by identity (no pairing code) over WSS
//   - a certificate the Body does not trust FAILS CLOSED with guidance
//     (no silent downgrade, no reconnect storm)
//   - plaintext ws:// to a non-loopback Brain is refused before any
//     bytes are sent — the documented MITM fix
//   - the explicit BLAXIN_BRAIN_ALLOW_INSECURE-style override re-enables
//     it for development only
// =============================================================

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BrainRuntime } from '../../distributed/brain-runtime.js';
import { DeterministicDriver } from '../../distributed/brain-drivers.js';
import { RemoteBrainDriver } from '../../distributed/remote-brain.js';
import { BodyState } from '../../distributed/body-state.js';
import { loadOrCreateIdentity } from '../../distributed/identity.js';
import { generateTestTls, localIpv4Addresses } from '../helpers/test-tls.js';

const tmpDirs: string[] = [];
const runtimes: BrainRuntime[] = [];
const drivers: RemoteBrainDriver[] = [];

let tlsA: Awaited<ReturnType<typeof generateTestTls>>;
let caB: string; // a DIFFERENT root CA (untrusted)

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  const dirA = tmpDir('wss-tls-a-');
  tlsA = await generateTestTls(dirA);
  const dirB = tmpDir('wss-tls-b-');
  caB = (await generateTestTls(dirB)).caCert;
}, 60_000);

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

afterEach(async () => {
  for (const d of drivers.splice(0)) d.disconnect();
  for (const r of runtimes.splice(0)) await r.stop();
});

async function makeBrainTls(host = '127.0.0.1'): Promise<{ runtime: BrainRuntime; wsUrl: string }> {
  const dir = tmpDir('wss-brain-');
  const runtime = new BrainRuntime({
    host,
    port: 0,
    tls: { key: tlsA.serverKey, cert: tlsA.serverCert },
    identityFile: join(dir, 'brain-identity.json'),
    registryFile: join(dir, 'devices.json'),
    drivers: new Map([['deterministic', new DeterministicDriver({ steps: [] })]]),
    defaultDriverId: 'deterministic',
  });
  runtimes.push(runtime);
  const info = await runtime.start();
  return { runtime, wsUrl: info.wsUrl };
}

async function makeBrainPlain(host: string): Promise<{ runtime: BrainRuntime; wsUrl: string }> {
  const dir = tmpDir('plain-brain-');
  const runtime = new BrainRuntime({
    host,
    port: 0,
    identityFile: join(dir, 'brain-identity.json'),
    registryFile: join(dir, 'devices.json'),
    drivers: new Map([['deterministic', new DeterministicDriver({ steps: [] })]]),
    defaultDriverId: 'deterministic',
  });
  runtimes.push(runtime);
  const info = await runtime.start();
  return { runtime, wsUrl: info.wsUrl };
}

async function makeBody(dir: string, url: string, extra: { ca?: string; allowInsecure?: boolean } = {}): Promise<{ driver: RemoteBrainDriver; events: Array<{ event: string; data: any }> }> {
  const identity = loadOrCreateIdentity({ filePath: join(dir, 'body-identity.json'), role: 'body', name: 'WSS Test Body' });
  const events: Array<{ event: string; data: any }> = [];
  const driver = new RemoteBrainDriver({
    identity,
    url,
    state: new BodyState(dir),
    ca: extra.ca,
    allowInsecure: extra.allowInsecure,
    onEvent: (event, data) => { events.push({ event, data }); },
    autoReconnect: true,
  });
  drivers.push(driver);
  return { driver, events };
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('brain ↔ body over WSS (real TLS)', () => {
  it('pairs, authenticates and reconnects by identity over a VALIDATED certificate', async () => {
    const dir = tmpDir('wss-body-');
    const { runtime, wsUrl } = await makeBrainTls();
    expect(wsUrl.startsWith('wss://')).toBe(true);
    expect(runtime.healthPayload().transport).toBe('wss');

    const { driver } = await makeBody(dir, wsUrl, { ca: tlsA.caCert });
    const code = runtime.generatePairingCode()?.code;
    expect(code).toBeTruthy();

    driver.connect(code);
    // 25s budget: under full-suite parallel load real TLS handshakes can
    // take many seconds; vitest's ceiling is 30s (see vitest.config.ts).
    // 40s: real-TLS handshake + Ed25519 chain under a loaded machine can
    // legitimately approach 30s wall-clock (observed at 25.3s); still bounded
    // — a genuine hang fails, just slower.
    await waitFor(() => driver.isReady(), 40_000, 'CONNECTED over WSS');
    expect((driver.status().brain as { transport?: string }).transport).toBe('wss');
    expect((driver.status().brain as { brainId?: string }).brainId).toBe(runtime.identity.id);
    expect(runtime.isBodyConnected(driver.status().bodyId as string)).toBe(true);

    // Reconnect over WSS using identity auth only (no pairing code).
    driver.disconnect();
    await waitFor(() => !driver.isReady(), 5_000, 'disconnected');
    driver.connect();
    await waitFor(() => driver.isReady(), 40_000, 'reconnected by identity over WSS');
    // Explicit per-test budget (overrides the 30s global): two real-TLS
    // handshakes under load legitimately exceed 30s combined (observed
    // 25.3s for one). Still bounded — a genuine hang fails, just slower.
  }, 90_000);

  it('FAILS CLOSED when the certificate is signed by an untrusted CA', async () => {
    const dir = tmpDir('wss-body-badca-');
    const { runtime, wsUrl } = await makeBrainTls();
    const { driver } = await makeBody(dir, wsUrl, { ca: caB }); // wrong root CA

    driver.connect();
    await waitFor(() => driver.getState() === 'ERROR', 8_000, 'certificate failure → ERROR');
    const status = driver.status().brain as { lastError?: string; state?: string };
    expect(status.state).toBe('ERROR');
    expect(String(status.lastError || '')).toMatch(/certificate|CA/i);
    // Terminal: NO reconnect storm after a cert failure.
    const saw = driver.getState();
    await new Promise((r) => setTimeout(r, 600));
    expect(driver.getState()).toBe(saw === 'ERROR' ? 'ERROR' : saw);
    expect(driver.isReady()).toBe(false);
    // The Brain never saw a pair request (TLS failed first).
    expect(runtime.listDevices()).toHaveLength(0);
  });

  it('REFUSES plaintext ws:// to a non-loopback Brain before dialing', async () => {
    const dir = tmpDir('plain-body-');
    const lanIp = localIpv4Addresses()[0];
    if (!lanIp) return; // no non-loopback interface on this machine — nothing to refuse
    const { runtime, wsUrl } = await makeBrainPlain('0.0.0.0');
    const port = new URL(wsUrl).port;
    const plainUrl = `ws://${lanIp}:${port}/ws/brain`;

    const { driver } = await makeBody(dir, plainUrl);
    driver.connect();
    await waitFor(() => driver.getState() === 'ERROR', 5_000, 'plaintext-to-remote refusal');
    const status = driver.status().brain as { lastError?: string };
    expect(String(status.lastError || '')).toContain('wss://');
    expect(runtime.isBodyConnected(driver.status().bodyId as string)).toBe(false);
  });

  it('allows plaintext ws:// to a non-loopback Brain only with the explicit dev override', async () => {
    const lanIp = localIpv4Addresses()[0];
    if (!lanIp) return; // no non-loopback interface available
    const dir = tmpDir('plain-body-override-');
    const { runtime, wsUrl } = await makeBrainPlain('0.0.0.0');
    const port = new URL(wsUrl).port;
    const plainUrl = `ws://${lanIp}:${port}/ws/brain`;

    const { driver } = await makeBody(dir, plainUrl, { allowInsecure: true });
    const code = runtime.generatePairingCode()?.code;
    driver.connect(code);
    await waitFor(() => driver.isReady(), 25_000, 'CONNECTED with explicit insecure override');
    expect((driver.status().brain as { transport?: string }).transport).toBe('ws');
  });
});
