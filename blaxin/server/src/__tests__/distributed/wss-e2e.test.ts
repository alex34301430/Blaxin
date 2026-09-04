// BLAXIN distributed E2E over WSS — TWO REAL PROCESSES, REAL TLS
// =============================================================
// "Two machines" exercise on loopback hardware:
//
//   Process A = BLAXIN Brain (brain-main.ts) serving WSS with a real
//               TLS certificate (throwaway test CA), bound to all
//               interfaces. Admin control plane over https.
//   Process B = BLAXIN Body (index.ts, external mode) connecting to the
//               Brain at this machine's NON-loopback LAN address over
//               wss:// — the same path a Brain on another physical
//               machine would use. The Body trusts the test CA through
//               NODE_EXTRA_CA_CERTS (equivalent to installing a private
//               CA root or BLAXIN_BRAIN_CA_FILE).
//
// Flow: generate pairing code over https → pair over WSS → run a real
// filesystem task over WSS → restart the Body (identity reconnect over
// WSS, no code) → revoke over https → rejection persists. A Body that
// does NOT trust the CA is refused (proves certificate validation is on
// by default — the documented MITM fix).
// =============================================================

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'net';
import { request as httpsRequest } from 'https';
import WebSocket from 'ws';
import { generateTestTls, localIpv4Addresses } from '../helpers/test-tls.js';

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

/** HTTPS admin call that VALIDATES the Brain certificate against the CA. */
async function httpsJson(url: string, options: { method?: string; body?: unknown; ca: string }): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpsRequest({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: options.method || 'GET',
      ca: options.ca,
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      timeout: 10_000,
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d.toString(); });
      res.on('end', () => {
        let json: any = {};
        try { json = JSON.parse(text); } catch { json = { raw: text }; }
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTPS ${options.method || 'GET'} ${url} → ${res.statusCode}: ${text.slice(0, 300)}`));
        } else {
          resolve(json);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
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

describe('distributed E2E over WSS (two real processes, real TLS)', () => {
  it('pairs over WSS, runs a real task, survives a Body restart, and enforces revocation + cert validation', async () => {
    const brainDir = tmpDir('wss-e2e-brain-');
    const bodyDir = tmpDir('wss-e2e-body-');
    const marker = join(brainDir, 'marker.txt');
    const markerContent = 'wss-e2e-marker-content';
    writeFileSync(marker, markerContent);

    // Real TLS: throwaway CA + server cert covering localhost, loopback
    // aliases and this machine's LAN address.
    const tls = await generateTestTls(brainDir, { ips: localIpv4Addresses() });

    // The Brain is reached at a NON-loopback address (its LAN IP when one
    // exists, else the 127.0.0.2 loopback alias) — the "other machine".
    const lanIp = localIpv4Addresses()[0];
    const targetHost = lanIp ?? '127.0.0.2';
    const brainBindHost = lanIp ? '0.0.0.0' : '127.0.0.1';
    const brainPort = await freePort();
    const bodyPort = await freePort();

    // ── 1. Start the Brain with TLS (WSS only) ───────────────────
    const brainEnv = {
      BLAXIN_BRAIN_HOST: brainBindHost,
      BLAXIN_BRAIN_PORT: String(brainPort),
      BLAXIN_DATA_DIR: brainDir,
      BLAXIN_BRAIN_TLS_KEY: tls.serverKeyPath,
      BLAXIN_BRAIN_TLS_CERT: tls.serverCertPath,
      BLAXIN_BRAIN_DEFAULT_DRIVER: 'deterministic',
      BLAXIN_BRAIN_DETERMINISTIC_STEPS: JSON.stringify([
        { tool: 'filesystem', args: { operation: 'read', path: marker }, description: 'read the marker file' },
      ]),
      // Both child processes validate the Brain cert against the test CA.
      NODE_EXTRA_CA_CERTS: tls.caCertPath,
    };
    const brainProc = spawnProc('brain', 'src/brain-main.ts', brainEnv);
    const brainHttps = `https://127.0.0.1:${brainPort}`;

    // Admin control plane is TLS too — wait with cert validation.
    const start = Date.now();
    for (;;) {
      try {
        const health = await httpsJson(`${brainHttps}/health`, { ca: tls.caCert });
        if (health.status === 'ok') break;
      } catch { /* not up yet */ }
      if (Date.now() - start > 20_000) throw new Error(`Brain https not up\n--- logs ---\n${dumpLogs()}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const health = await httpsJson(`${brainHttps}/health`, { ca: tls.caCert });
    expect(health.role).toBe('brain');
    expect(health.transport).toBe('wss'); // the Brain only speaks WSS

    // ── 2. Pairing UX: generate a one-time code over https ───────
    const pair = await httpsJson(`${brainHttps}/pairing/start`, { method: 'POST', body: {}, ca: tls.caCert });
    const code = pair.code as string;
    const brainId = pair.brainId as string;

    // ── 3. Start the Body, connecting over WSS to the LAN address ─
    const bodyEnv = {
      BLAXIN_HOST: '127.0.0.1',
      PORT: String(bodyPort),
      BLAXIN_DATA_DIR: bodyDir,
      BLAXIN_BRAIN_MODE: 'external',
      BLAXIN_BRAIN_URL: `wss://${targetHost}:${brainPort}/ws/brain`,
      BLAXIN_BODY_NAME: 'WSS E2E Body',
      NODE_EXTRA_CA_CERTS: tls.caCertPath,
    };
    let bodyProc = spawnProc('body', 'src/index.ts', bodyEnv);
    const bodyBase = `http://127.0.0.1:${bodyPort}`;
    await waitForHttp(`${bodyBase}/api/health`, 20_000);

    // The Body's own policy permits wss:// to a non-loopback Brain; pair
    // with the one-time code.
    await postJson(`${bodyBase}/api/brain/connect`, {
      url: `wss://${targetHost}:${brainPort}/ws/brain`,
      code,
    });
    await poll(async () => {
      const status = await getJson(`${bodyBase}/api/brain/status`);
      return status.brain?.state === 'CONNECTED';
    }, 15_000, 'body CONNECTED to brain over WSS');
    const connected = await getJson(`${bodyBase}/api/brain/status`);
    expect(connected.bodyId).toMatch(/^BLX-BODY-/);
    expect(connected.brain?.brainId).toBe(brainId);
    expect(connected.brain?.transport).toBe('wss'); // the wire is TLS
    // The UI derives the Brain admin base from this URL — it must be
    // present and reflect the actual (TLS) transport.
    expect(connected.brain?.url).toBe(`wss://${targetHost}:${brainPort}/ws/brain`);
    const bodyId = connected.bodyId as string;

    // ── 4. Real task over WSS: body UI → brain → filesystem → back ─
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

    await poll(async () => events.some((e) => e.event === 'agent-message'), 15_000, 'final agent message over WSS');
    const finalMsg = events.find((e) => e.event === 'agent-message');
    expect(JSON.stringify(finalMsg?.data)).toContain(markerContent);
    expect(events.some((e) => e.event === 'task-complete')).toBe(true);

    // ── 5. Restart the Body → identity reconnect over WSS, no code ─
    ws.close();
    await kill(bodyProc);
    children.splice(children.indexOf(bodyProc), 1);
    bodyProc = spawnProc('body', 'src/index.ts', bodyEnv);
    await waitForHttp(`${bodyBase}/api/health`, 20_000);
    await poll(async () => {
      const status = await getJson(`${bodyBase}/api/brain/status`);
      return status.brain?.state === 'CONNECTED';
    }, 20_000, 'body reconnected over WSS after restart');
    const restarted = await getJson(`${bodyBase}/api/brain/status`);
    expect(restarted.bodyId).toBe(bodyId); // identity persisted
    expect(restarted.brain?.transport).toBe('wss');

    // ── 6. Revoke over https — the old credentials never work again ─
    const revoke = await httpsJson(`${brainHttps}/devices/${bodyId}/revoke`, { method: 'POST', body: {}, ca: tls.caCert });
    expect(revoke.success).toBe(true);
    await poll(async () => {
      const status = await getJson(`${bodyBase}/api/brain/status`);
      return status.brain?.state === 'REVOKED';
    }, 15_000, 'body sees REVOKED over WSS');
    await postJson(`${bodyBase}/api/brain/reconnect`, {});
    await poll(async () => {
      const status = await getJson(`${bodyBase}/api/brain/status`);
      return status.brain?.state === 'REVOKED';
    }, 15_000, 'revoked body cannot reconnect');

    // ── 7. Certificate validation is enforced (the MITM fix): a Body
    // that does NOT trust the test CA must be refused at the TLS layer ─
    const nocaDir = tmpDir('wss-e2e-noca-');
    const nocaPort = await freePort();
    const nocaProc = spawnProc('body-noca', 'src/index.ts', {
      BLAXIN_HOST: '127.0.0.1',
      PORT: String(nocaPort),
      BLAXIN_DATA_DIR: nocaDir,
      BLAXIN_BRAIN_MODE: 'external',
      BLAXIN_BRAIN_URL: `wss://${targetHost}:${brainPort}/ws/brain`,
      BLAXIN_BODY_NAME: 'Untrusted Body',
      // NOTE: no NODE_EXTRA_CA_CERTS — this Body must refuse the cert.
    });
    const nocaBase = `http://127.0.0.1:${nocaPort}`;
    await waitForHttp(`${nocaBase}/api/health`, 20_000);
    await poll(async () => {
      const status = await getJson(`${nocaBase}/api/brain/status`);
      return status.brain?.state === 'ERROR';
    }, 20_000, 'untrusted Body refuses the Brain certificate');
    const nocaStatus = await getJson(`${nocaBase}/api/brain/status`);
    expect(String(nocaStatus.brain?.lastError || '')).toMatch(/certificate|CA|TLS/i);
    expect(nocaStatus.brain?.state).toBe('ERROR');
    // The Brain never paired the untrusted Body.
    const devices = await httpsJson(`${brainHttps}/devices`, { ca: tls.caCert });
    expect(devices.devices.find((d: any) => d.bodyId === nocaStatus.bodyId)).toBeUndefined();
  }, 120_000);
});
