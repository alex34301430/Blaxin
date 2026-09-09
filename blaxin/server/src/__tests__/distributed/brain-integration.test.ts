import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { BrainRuntime } from '../../distributed/brain-runtime.js';
import { DeterministicDriver } from '../../distributed/brain-drivers.js';
import { RemoteBrainDriver } from '../../distributed/remote-brain.js';
import { BodyState } from '../../distributed/body-state.js';
import { loadOrCreateIdentity } from '../../distributed/identity.js';
import { FileSystemTool } from '../../tools/filesystem.js';
import type { Tool, ToolDefinition, ToolResult } from '../../types.js';

const tmpDirs: string[] = [];
const runtimes: BrainRuntime[] = [];
const drivers: RemoteBrainDriver[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const d of drivers.splice(0)) d.disconnect();
  for (const r of runtimes.splice(0)) await r.stop();
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** A registry exposing ONLY the filesystem tool (real implementation). */
function filesystemOnlyRegistry() {
  const fsTool = new FileSystemTool();
  const tools = new Map<string, Tool>([['filesystem', fsTool]]);
  return {
    getTool(name: string): Tool | undefined { return tools.get(name); },
    getToolDefinitions(): ToolDefinition[] { return [...tools.values()].map((t) => t.definition); },
    async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const tool = tools.get(name);
      if (!tool) return { success: false, output: '', error: `Unknown tool: ${name}` };
      return tool.execute(args);
    },
    requiresConfirmation(name: string, args: Record<string, unknown>): boolean {
      return tools.get(name)?.requiresConfirmation?.(args) ?? false;
    },
  };
}

async function makeBrain(steps: Array<{ tool: string; args: Record<string, unknown>; description: string }>): Promise<{ runtime: BrainRuntime; wsUrl: string }> {
  const dir = tmpDir('blaxin-brain-');
  const runtime = new BrainRuntime({
    host: '127.0.0.1',
    port: 0,
    identityFile: join(dir, 'brain-identity.json'),
    registryFile: join(dir, 'devices.json'),
    drivers: new Map([['deterministic', new DeterministicDriver({ steps })]]),
    defaultDriverId: 'deterministic',
  });
  runtimes.push(runtime);
  const info = await runtime.start();
  return { runtime, wsUrl: info.wsUrl };
}

interface TestBody {
  identityId: string;
  driver: RemoteBrainDriver;
  events: Array<{ event: string; data: any }>;
}

async function makeBody(dir: string, wsUrl: string, registry?: ReturnType<typeof filesystemOnlyRegistry>): Promise<TestBody> {
  const identity = loadOrCreateIdentity({ filePath: join(dir, 'body-identity.json'), role: 'body', name: 'Test Body' });
  const events: Array<{ event: string; data: any }> = [];
  const driver = new RemoteBrainDriver({
    identity,
    url: wsUrl,
    state: new BodyState(dir),
    ...(registry ? { toolRegistry: registry } : {}),
    onEvent: (event, data) => { events.push({ event, data }); },
    autoReconnect: true,
  });
  drivers.push(driver);
  return { identityId: identity.id, driver, events };
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

describe('brain ↔ body integration (real sockets)', () => {
  it('pairs, authenticates, exchanges capabilities and runs a real task', async () => {
    const dir = tmpDir('blaxin-body-');
    const target = join(dir, 'marker.txt');
    writeFileSync(target, 'integration-marker-42');
    const { runtime, wsUrl } = await makeBrain([
      { tool: 'filesystem', args: { operation: 'read', path: target }, description: 'read the marker file' },
    ]);
    const { identityId, driver, events } = await makeBody(dir, wsUrl);

    const code = runtime.generatePairingCode()?.code;
    expect(code).toBeTruthy();

    driver.connect(code);
    await waitFor(() => driver.isReady(), 10_000, 'body connected to brain');
    const brainInfo = driver.status().brain as { brainId?: string; protocol?: number } | null;
    expect(brainInfo?.brainId).toBe(runtime.identity.id);
    expect(driver.status().bodyId).toBe(identityId);
    expect(brainInfo?.protocol).toBe(1);
    // Clean handshake: no pairing/error events.
    expect(hasEvent(events, 'error')).toBe(false);

    driver.sendUserMessage('please read the marker file');
    await waitFor(() => hasEvent(events, 'agent-message'), 10_000, 'final agent message');
    const final = events.find((e) => e.event === 'agent-message');
    expect(JSON.stringify(final?.data)).toContain('integration-marker-42');
    expect(hasEvent(events, 'agent-state', (d) => d.state === 'completed')).toBe(true);
  });

  it('rejects an invalid pairing code', async () => {
    const dir = tmpDir('blaxin-body-');
    const { runtime, wsUrl } = await makeBrain([]);
    runtime.generatePairingCode(); // real code exists but is NOT used
    const { driver, events } = await makeBody(dir, wsUrl);

    driver.connect('ZZZZ-ZZZZ');
    await waitFor(() => hasEvent(events, 'error', (d) => d.code === 'PAIR_REJECTED'), 10_000, 'pair rejection');
    await new Promise((r) => setTimeout(r, 150));
    expect(driver.isReady()).toBe(false);
    expect(runtime.listDevices()).toHaveLength(0); // nothing was paired
  });

  it('reconnects after a drop using identity authentication (no code)', async () => {
    const dir = tmpDir('blaxin-body-');
    const { runtime, wsUrl } = await makeBrain([]);
    const { driver, events } = await makeBody(dir, wsUrl);
    const code = runtime.generatePairingCode()?.code;

    driver.connect(code);
    // 20s: under full-suite parallel load the Ed25519 handshake chain can
    // legitimately exceed 10s wall-clock (observed once); the wait stays
    // bounded — a real hang still fails, just slower.
    await waitFor(() => driver.isReady(), 20_000, 'first connect');

    driver.disconnect();
    await waitFor(() => !driver.isReady(), 5_000, 'disconnect');
    driver.connect(); // NO pairing code: identity auth must suffice
    await waitFor(() => driver.isReady(), 20_000, 'reconnect via identity auth');
    expect(hasEvent(events, 'error', (d) => d.code === 'PAIRING_REQUIRED')).toBe(false);
  });

  it('revokes a body and rejects every further connection', async () => {
    const dir = tmpDir('blaxin-body-');
    const { runtime, wsUrl } = await makeBrain([]);
    const { driver } = await makeBody(dir, wsUrl);
    const code = runtime.generatePairingCode()?.code;

    driver.connect(code);
    await waitFor(() => driver.isReady(), 10_000, 'connected before revoke');
    const bodyId = driver.status().bodyId as string;

    expect(runtime.revokeBody(bodyId)).toBe(true);
    await waitFor(() => driver.getState() === 'REVOKED', 10_000, 'body sees REVOKED');

    // Explicit reconnect attempts keep failing — a revoked device must not
    // come back with its old credentials.
    driver.connect();
    await waitFor(() => driver.getState() === 'REVOKED', 8_000, 'revoked stays revoked');
    expect(runtime.isBodyConnected(bodyId)).toBe(false);
  });

  it('never lets the brain request a tool the body did not advertise', async () => {
    const dir = tmpDir('blaxin-body-');
    const { runtime, wsUrl } = await makeBrain([
      { tool: 'computer-control', args: { action: 'key_press', key: 'x' }, description: 'press key' },
    ]);
    const { driver, events } = await makeBody(dir, wsUrl, filesystemOnlyRegistry());
    const code = runtime.generatePairingCode()?.code;

    driver.connect(code);
    await waitFor(() => driver.isReady(), 10_000, 'connected');
    // The body advertised only [filesystem]; the brain must detect that
    // before requesting anything.
    const caps = driver.status().capabilities as string[];
    expect(caps).toEqual(['filesystem']);

    driver.sendUserMessage('press a key for me');
    await waitFor(() => hasEvent(events, 'error', (d) => d.code === 'UNSUPPORTED_CAPABILITY'), 10_000, 'capability rejection');
    // The task failed honestly: it is surfaced as an error, NOT completed,
    // and no fake "done" message was produced.
    const task = driver.status().task as { state: string } | null;
    expect(task?.state).toBe('error');
    expect(hasEvent(events, 'agent-state', (d) => d.state === 'completed')).toBe(false);
    expect(hasEvent(events, 'agent-message')).toBe(false);
  });

  it('closes the connection on garbage and oversized frames', async () => {
    const { wsUrl } = await makeBrain([]);

    const garbageClose = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => ws.send('{not json'));
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => resolve(-1));
    });
    expect(garbageClose).toBe(4400); // MALFORMED

    // Oversized frame → rejected. Two layers enforce the same 512KB cap:
    // 1009 = the ws library's maxPayload guard (transport level, fires
    // before our handler), 4400 = our application FRAME_TOO_LARGE close.
    const oversizeClose = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => ws.send(Buffer.alloc(600 * 1024, 0x61)));
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => resolve(-1));
    });
    expect([4400, 1009]).toContain(oversizeClose);
  });

  it('rejects an incompatible protocol version before anything else runs', async () => {
    const { wsUrl } = await makeBrain([]);

    const outcome = await new Promise<{ code: string }>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => {
        // Claim protocol range [2,3] — this Brain only supports [1,1].
        ws.send(JSON.stringify({
          v: 1, type: 'hello', id: 'x1', ts: Date.now(), from: 'body',
          deviceId: 'BLX-BODY-1234',
          payload: { deviceId: 'BLX-BODY-1234', protocolMin: 2, protocolMax: 3, capabilities: ['filesystem'] },
        }));
      });
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'error') resolve({ code: String(msg.payload?.code ?? '') });
      });
      ws.on('close', (code) => resolve({ code: String(code) }));
      ws.on('error', () => resolve({ code: 'socket-error' }));
    });
    expect(outcome.code).toBe('INCOMPATIBLE');
  });
});
