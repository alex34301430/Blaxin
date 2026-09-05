// BLAXIN multi-body registry — deterministic tests, real sockets
// =============================================================
// One Brain, several Bodies. The Brain's device registry is the single
// source of truth; this suite proves the B4 guarantees with REAL Brain
// + Body processes inside one test process (no mocks of the protocol):
//
//   - multiple simultaneous Bodies with distinct identities
//   - actions route ONLY to the Body that owns the task (never cross)
//   - Brain-side capability pre-check (a body that never advertised a
//     capability is refused before a frame leaves the Brain)
//   - cross-body action-result integrity (Body B cannot resolve Body A's
//     pending action)
//   - disconnect / reconnect with the same identity
//   - revoked bodies stay revoked and cannot rejoin as trusted
//   - duplicate body identity keeps a single registry record + one peer
//   - concurrent tasks on different Bodies
//   - no-target safety: a dropped Body fails its task with
//     CONNECTION_LOST — it is never rerouted to another Body
//   - registry realtime events (admin WebSocket) with monotonic versions
//   - REST snapshot recovery after the admin channel reconnects, and the
//     guarantee that a snapshot is never older than prior events
// =============================================================

import { describe, it, expect, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';
import { BrainRuntime } from '../../distributed/brain-runtime.js';
import { RemoteBrainDriver } from '../../distributed/remote-brain.js';
import { BodyState } from '../../distributed/body-state.js';
import { loadOrCreateIdentity } from '../../distributed/identity.js';
import { FileSystemTool } from '../../tools/filesystem.js';
import { makeConfig } from '../helpers/orchestrator-fakes.js';
import type { BrainTaskDriver, BrainTaskContext, DriverOutcome } from '../../distributed/brain-drivers.js';
import type { TaskActionRequest, ActionResult } from '../../distributed/types.js';
import type { Tool, ToolDefinition, ToolResult } from '../../types.js';
import type { DeviceIdentity } from '../../distributed/identity.js';

const tmpDirs: string[] = [];
const runtimes: BrainRuntime[] = [];
const drivers: RemoteBrainDriver[] = [];
const sockets: WebSocket[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try { s.terminate(); } catch { /* ignore */ }
  }
  for (const d of drivers.splice(0)) d.disconnect();
  for (const r of runtimes.splice(0)) await r.stop();
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** Minimal tool registry over the REAL filesystem tool (with counters),
 * so tasks in these tests execute real tools end to end. */
class MiniRegistry {
  private tools = new Map<string, { tool: Tool; calls: { total: number } }>();
  register(tool: Tool): { total: number } {
    const calls = { total: 0 };
    this.tools.set(tool.name, { tool, calls });
    return calls;
  }
  getTool(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }
  getToolDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.tool.definition);
  }
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) return { success: false, output: '', error: `Unknown tool: ${name}` };
    entry.calls.total++;
    return entry.tool.execute(args);
  }
  requiresConfirmation(name: string, args: Record<string, unknown>): boolean {
    return this.tools.get(name)?.tool.requiresConfirmation?.(args) ?? false;
  }
}

/** Records every requestAction call (which Body, which tool) — the
 * observable proof of routing isolation. Steps are chosen per Body so
 * each task exercises its own marker. */
class RecordingDriver implements BrainTaskDriver {
  readonly id = 'recording';
  readonly name = 'Recording driver';
  requests: Array<{ bodyId: string; tool: string; taskId: string }> = [];
  /** The most recent action the driver requested (observed by tests
   * before its result can possibly return — no race on pending state). */
  lastRequest: { actionId: string; taskId: string; requestId: string } | null = null;

  constructor(
    private stepsFor: (bodyId: string) => Array<{ tool: string; args: Record<string, unknown>; description?: string }>,
  ) {}

  async run(ctx: BrainTaskContext): Promise<DriverOutcome> {
    const summary: string[] = [];
    for (const step of this.stepsFor(ctx.bodyId)) {
      this.requests.push({ bodyId: ctx.bodyId, tool: step.tool, taskId: ctx.taskId });
      const req: TaskActionRequest = {
        taskId: ctx.taskId,
        actionId: uuidv4(),
        requestId: uuidv4(),
        action: { tool: step.tool, args: step.args },
        idempotent: true,
        description: step.description ?? step.tool,
      };
      this.lastRequest = { actionId: req.actionId, taskId: req.taskId, requestId: req.requestId };
      const result = await ctx.requestAction(req);
      if (result.outcome !== 'allowed' || !result.success) {
        return { kind: 'failed', error: result.error || `Action rejected: ${step.tool}`, code: result.outcome === 'denied' ? 'DENIED' : 'REJECTED' };
      }
      summary.push(`${step.description ?? step.tool}: ${(result.output || '').slice(0, 300)}`);
    }
    return { kind: 'completed', summary: summary.join('\n') };
  }
}

/** A driver whose first action is gated behind a promise the test
 * controls — used to hold a task open while a Body drops. Records the
 * action verdict so the test can observe CONNECTION_LOST on the Brain
 * side (the Body that dropped cannot receive events anymore). */
class GateDriver implements BrainTaskDriver {
  readonly id = 'gate';
  readonly name = 'Gate driver';
  requests: Array<{ bodyId: string; tool: string }> = [];
  lastError: string | null = null;
  private openers: Array<() => void> = [];

  constructor(private step: { tool: string; args: Record<string, unknown>; description?: string }) {}

  release(): void {
    for (const open of this.openers.splice(0)) open();
  }

  async run(ctx: BrainTaskContext): Promise<DriverOutcome> {
    await new Promise<void>((resolve) => this.openers.push(resolve));
    this.requests.push({ bodyId: ctx.bodyId, tool: this.step.tool });
    const req: TaskActionRequest = {
      taskId: ctx.taskId,
      actionId: uuidv4(),
      requestId: uuidv4(),
      action: { tool: this.step.tool, args: this.step.args },
      idempotent: true,
      description: this.step.description ?? this.step.tool,
    };
    const result = await ctx.requestAction(req);
    if (result.outcome !== 'allowed' || !result.success) {
      this.lastError = result.error || 'Action rejected';
      return { kind: 'failed', error: this.lastError, code: 'REJECTED' };
    }
    return { kind: 'completed', summary: (result.output || '').slice(0, 300) };
  }
}

interface TestBody {
  identity: DeviceIdentity;
  driver: RemoteBrainDriver;
  events: Array<{ event: string; data: any }>;
  fsCalls: { total: number };
}

async function makeBrain(opts: {
  dir?: string;
  drivers?: Map<string, BrainTaskDriver>;
  defaultDriverId?: string;
} = {}): Promise<{ runtime: BrainRuntime; wsUrl: string; adminUrl: string; adminHttp: string }> {
  const dir = opts.dir ?? tmpDir('blaxin-brain-');
  const runtime = new BrainRuntime({
    host: '127.0.0.1',
    port: 0,
    identityFile: join(dir, 'brain-identity.json'),
    registryFile: join(dir, 'devices.json'),
    drivers: opts.drivers ?? new Map(),
    defaultDriverId: opts.defaultDriverId ?? 'recording',
  });
  runtimes.push(runtime);
  const info = await runtime.start();
  return {
    runtime,
    wsUrl: info.wsUrl,
    adminUrl: `ws://127.0.0.1:${info.port}/ws/admin`,
    adminHttp: `http://127.0.0.1:${info.port}`,
  };
}

async function makeBody(
  dir: string,
  url: string,
  opts: { autoReconnect?: boolean; name?: string } = {},
): Promise<TestBody> {
  const registry = new MiniRegistry();
  const fsTool = new FileSystemTool();
  const fsCalls = registry.register(fsTool);
  const identity = loadOrCreateIdentity({
    filePath: join(dir, 'body-identity.json'),
    role: 'body',
    name: opts.name ?? 'Multi-Body Test Body',
  });
  const events: Array<{ event: string; data: any }> = [];
  const driver = new RemoteBrainDriver({
    identity,
    url,
    state: new BodyState(dir),
    toolRegistry: registry,
    getConfig: () => makeConfig({ requireConfirmation: false }),
    onEvent: (event, data) => { events.push({ event, data }); },
    autoReconnect: opts.autoReconnect ?? true,
  });
  drivers.push(driver);
  return { identity, driver, events, fsCalls };
}

async function pairAndReady(body: TestBody, code: string, label: string): Promise<void> {
  body.driver.connect(code);
  await waitFor(() => body.driver.isReady(), 15_000, `${label} CONNECTED after pairing`);
}

function taskStep(tool: string, args: Record<string, unknown>, description: string) {
  return { tool, args, description };
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

function lastMsg(events: Array<{ event: string; data: any }>, event: string): any {
  return [...events].reverse().find((e) => e.event === event)?.data ?? null;
}

interface AdminFrame {
  type: string;
  version: number;
  bodyId?: string;
  body?: any;
  bodies?: any[];
}

async function openAdminSocket(adminUrl: string): Promise<{ ws: WebSocket; frames: AdminFrame[] }> {
  const frames: AdminFrame[] = [];
  const ws = new WebSocket(adminUrl);
  sockets.push(ws);
  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed && typeof parsed.type === 'string') frames.push(parsed);
    } catch { /* ignore */ }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  return { ws, frames };
}

describe('multi-body registry (deterministic, real sockets)', () => {
  it('pairs TWO Bodies simultaneously and lists them distinctly in the registry', async () => {
    const dirA = tmpDir('blaxin-bodyA-');
    const dirB = tmpDir('blaxin-bodyB-');
    const brainDir = tmpDir('blaxin-brain-');
    const { runtime, wsUrl } = await makeBrain({ dir: brainDir });
    const a = await makeBody(dirA, wsUrl, { name: 'Body A' });
    const b = await makeBody(dirB, wsUrl, { name: 'Body B' });

    const code = runtime.generatePairingCode()?.code as string;
    await pairAndReady(a, code, 'Body A');
    const code2 = runtime.generatePairingCode()?.code as string;
    await pairAndReady(b, code2, 'Body B');

    // Distinct identities, both registered.
    expect(a.identity.id).not.toBe(b.identity.id);
    const list = runtime.listDevices();
    expect(list).toHaveLength(2);
    const ids = list.map((d) => d.bodyId).sort();
    expect(ids).toEqual([a.identity.id, b.identity.id].sort());
    for (const d of list) {
      expect(d.status).toBe('online');
      expect(d.capabilities).toContain('filesystem');
      expect(d.pairedAt).toBeGreaterThan(0);
      expect(d.publicKey).toBeTruthy();
    }
    // REST details for each body.
    const online = new Set(runtime['peers'].keys());
    const pubA = runtime['toPublicBody'](runtime.registry.get(a.identity.id)!, online);
    expect(pubA.bodyId).toBe(a.identity.id);
    expect(pubA.name).toBe('Body A');
  }, 60_000);

  it('routes actions ONLY to the Body that owns the task (Body B never receives Body A action)', async () => {
    const brainDir = tmpDir('blaxin-brain-');
    const dirA = tmpDir('blaxin-bodyA-');
    const dirB = tmpDir('blaxin-bodyB-');
    const markerA = join(brainDir, 'marker-a.txt');
    const markerB = join(brainDir, 'marker-b.txt');
    writeFileSync(markerA, 'ROUTED-TO-A');
    writeFileSync(markerB, 'ROUTED-TO-B');
    // Each Body's task reads ITS OWN marker (populated once identities exist).
    const markerFor = new Map<string, string>();
    const recording = new RecordingDriver((bodyId) => [
      taskStep('filesystem', {
        operation: 'read',
        path: markerFor.get(bodyId) ?? markerA,
      }, 'read marker'),
    ]);
    const { runtime, wsUrl } = await makeBrain({
      dir: brainDir,
      drivers: new Map([['recording', recording]]),
      defaultDriverId: 'recording',
    });
    const a = await makeBody(dirA, wsUrl, { name: 'Body A' });
    const b = await makeBody(dirB, wsUrl, { name: 'Body B' });
    const code = runtime.generatePairingCode()?.code as string;
    await pairAndReady(a, code, 'Body A');
    const code2 = runtime.generatePairingCode()?.code as string;
    await pairAndReady(b, code2, 'Body B');
    markerFor.set(a.identity.id, markerA);
    markerFor.set(b.identity.id, markerB);

    // Both Bodies send a task at the same time.
    a.driver.sendUserMessage('read marker A for me');
    b.driver.sendUserMessage('read marker B for me');

    await waitFor(() => hasEvent(a.events, 'agent-message'), 15_000, 'Body A final message');
    await waitFor(() => hasEvent(b.events, 'agent-message'), 15_000, 'Body B final message');

    const aMsg = String((lastMsg(a.events, 'agent-message') || {}).content || '');
    const bMsg = String((lastMsg(b.events, 'agent-message') || {}).content || '');
    expect(aMsg).toContain('ROUTED-TO-A');
    expect(bMsg).toContain('ROUTED-TO-B');
    expect(aMsg).not.toContain('ROUTED-TO-B');
    expect(bMsg).not.toContain('ROUTED-TO-A');

    // Every action the Brain requested was addressed to exactly one Body
    // and never crossed: one request per task, each to its owner.
    expect(recording.requests).toHaveLength(2);
    const forA = recording.requests.filter((r) => r.bodyId === a.identity.id);
    const forB = recording.requests.filter((r) => r.bodyId === b.identity.id);
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    // Each Body executed exactly its own action (real tool counters).
    expect(a.fsCalls.total).toBe(1);
    expect(b.fsCalls.total).toBe(1);
  }, 60_000);

  it('concurrent tasks on different Bodies complete independently', async () => {
    const brainDir = tmpDir('blaxin-brain-');
    const dirA = tmpDir('blaxin-bodyA-');
    const dirB = tmpDir('blaxin-bodyB-');
    const markerA = join(brainDir, 'concurrent-a.txt');
    const markerB = join(brainDir, 'concurrent-b.txt');
    writeFileSync(markerA, 'CONCURRENT-A');
    writeFileSync(markerB, 'CONCURRENT-B');
    const recording = new RecordingDriver(() => [
      taskStep('filesystem', { operation: 'read', path: markerA }, 'read A'),
      taskStep('filesystem', { operation: 'read', path: markerB }, 'read B'),
    ]);
    const { runtime, wsUrl } = await makeBrain({
      dir: brainDir,
      drivers: new Map([['recording', recording]]),
      defaultDriverId: 'recording',
    });
    const a = await makeBody(dirA, wsUrl, { name: 'Body A' });
    const b = await makeBody(dirB, wsUrl, { name: 'Body B' });
    const code = runtime.generatePairingCode()?.code as string;
    await pairAndReady(a, code, 'Body A');
    const code2 = runtime.generatePairingCode()?.code as string;
    await pairAndReady(b, code2, 'Body B');

    a.driver.sendUserMessage('run both');
    b.driver.sendUserMessage('run both');
    await waitFor(() => hasEvent(a.events, 'agent-message'), 15_000, 'Body A done');
    await waitFor(() => hasEvent(b.events, 'agent-message'), 15_000, 'Body B done');

    // Both bodies executed two actions each; no action crossed bodies.
    expect(a.fsCalls.total).toBe(2);
    expect(b.fsCalls.total).toBe(2);
    for (const r of recording.requests) {
      expect(r.bodyId === a.identity.id || r.bodyId === b.identity.id).toBe(true);
    }
    const aIds = new Set(recording.requests.filter((r) => r.bodyId === a.identity.id).map((r) => r.taskId));
    const bIds = new Set(recording.requests.filter((r) => r.bodyId === b.identity.id).map((r) => r.taskId));
    // Each task stayed on its own Body: no task id appears on both.
    for (const t of aIds) expect(bIds.has(t)).toBe(false);
  }, 60_000);

  it('refuses to route an action for a capability the Body never advertised (Brain pre-check)', async () => {
    const brainDir = tmpDir('blaxin-brain-');
    const dirA = tmpDir('blaxin-bodyA-');
    const recording = new RecordingDriver(() => [
      taskStep('browser', { url: 'https://example.com' }, 'open browser'),
    ]);
    const { runtime, wsUrl } = await makeBrain({
      dir: brainDir,
      drivers: new Map([['recording', recording]]),
      defaultDriverId: 'recording',
    });
    // Body A only advertises filesystem (its registry has one tool).
    const a = await makeBody(dirA, wsUrl, { name: 'Body A' });
    const code = runtime.generatePairingCode()?.code as string;
    await pairAndReady(a, code, 'Body A');

    a.driver.sendUserMessage('open the browser');
    await waitFor(() => hasEvent(a.events, 'error') || hasEvent(a.events, 'agent-message'), 10_000, 'task verdict');

    // The Brain-side capability gate refused the action BEFORE any frame
    // left the Brain: the task fails with the Brain's own wording, and
    // the Body's filesystem tool was never touched (nothing executed).
    const err = hasEvent(a.events, 'error') ? a.events.find((e) => e.event === 'error')?.data : null;
    const msg = JSON.stringify(err || '') + JSON.stringify(lastMsg(a.events, 'agent-message') || '');
    expect(msg).toMatch(/does not advertise/i);
    expect(recording.requests).toHaveLength(1); // the driver asked; the Brain refused
    expect(a.fsCalls.total).toBe(0);
    // The Body never went offline and remains connected.
    expect(a.driver.isReady()).toBe(true);
  }, 60_000);

  it('drops a cross-body action_result: Body B cannot satisfy Body A pending action', async () => {
    const brainDir = tmpDir('blaxin-brain-');
    const dirA = tmpDir('blaxin-bodyA-');
    const dirB = tmpDir('blaxin-bodyB-');
    const marker = join(brainDir, 'marker.txt');
    writeFileSync(marker, 'CROSS-BODY-GUARD');
    const recording = new RecordingDriver(() => [
      taskStep('filesystem', { operation: 'read', path: marker }, 'read marker'),
    ]);
    const { runtime, wsUrl } = await makeBrain({
      dir: brainDir,
      drivers: new Map([['recording', recording]]),
      defaultDriverId: 'recording',
    });
    const a = await makeBody(dirA, wsUrl, { name: 'Body A' });
    const b = await makeBody(dirB, wsUrl, { name: 'Body B' });
    const code = runtime.generatePairingCode()?.code as string;
    await pairAndReady(a, code, 'Body A');
    const code2 = runtime.generatePairingCode()?.code as string;
    await pairAndReady(b, code2, 'Body B');

    // Start A's task and capture the action id the moment the driver
    // requests it (recorded BEFORE the request, so the frame that follows
    // can never outrun the test's observation).
    a.driver.sendUserMessage('read the marker');
    await waitFor(() => recording.lastRequest !== null, 10_000, 'action requested');
    const pendingAction = recording.lastRequest as { actionId: string; taskId: string; requestId: string };
    const forged = {
      v: 1,
      type: 'action_result',
      id: uuidv4(),
      ts: Date.now(),
      from: 'body',
      deviceId: b.identity.id,
      payload: {
        taskId: pendingAction.taskId,
        actionId: pendingAction.actionId,
        requestId: pendingAction.actionId,
        outcome: 'allowed',
        executed: true,
        replay: false,
        success: true,
        output: 'FORGED-BY-B',
      },
    };
    // Send it over B's real connection using B's link. If the Brain ever
    // accepted a result for A's action from Body B, the forged output
    // would satisfy A's pending action — the assertions below prove it
    // cannot (the pending is owned by Body A).
    (b.driver as any).link.send(forged as never);

    // B's forged result must be ignored: A's real execution still lands.
    await waitFor(() => hasEvent(a.events, 'agent-message'), 15_000, 'A final message (real result)');
    const aMsg = String((lastMsg(a.events, 'agent-message') || {}).content || '');
    expect(aMsg).toContain('CROSS-BODY-GUARD');
    expect(aMsg).not.toContain('FORGED-BY-B');
    expect(a.fsCalls.total).toBe(1);
  }, 60_000);

  it('Body disconnect marks it offline; reconnect with the SAME identity comes back online', async () => {
    const brainDir = tmpDir('blaxin-brain-');
    const dirA = tmpDir('blaxin-bodyA-');
    const { runtime, wsUrl } = await makeBrain({ dir: brainDir });
    const a = await makeBody(dirA, wsUrl, { name: 'Body A' });
    const code = runtime.generatePairingCode()?.code as string;
    await pairAndReady(a, code, 'Body A');

    a.driver.disconnect();
    await waitFor(() => runtime.registry.get(a.identity.id)?.status === 'offline', 8_000, 'Body A offline');
    expect(runtime.isBodyConnected(a.identity.id)).toBe(false);

    // Reconnect with identity only (no pairing code).
    a.driver.connect();
    await waitFor(() => a.driver.isReady(), 15_000, 'Body A reconnected');
    expect(runtime.registry.get(a.identity.id)?.status).toBe('online');
    expect(runtime.isBodyConnected(a.identity.id)).toBe(true);
  }, 60_000);

  it('a revoked Body stays revoked and cannot reconnect as trusted', async () => {
    const brainDir = tmpDir('blaxin-brain-');
    const dirA = tmpDir('blaxin-bodyA-');
    const dirB = tmpDir('blaxin-bodyB-');
    const { runtime, wsUrl } = await makeBrain({ dir: brainDir });
    const a = await makeBody(dirA, wsUrl, { name: 'Body A' });
    const b = await makeBody(dirB, wsUrl, { name: 'Body B' });
    const code = runtime.generatePairingCode()?.code as string;
    await pairAndReady(a, code, 'Body A');
    const code2 = runtime.generatePairingCode()?.code as string;
    await pairAndReady(b, code2, 'Body B');

    expect(runtime.revokeBody(a.identity.id)).toBe(true);
    await waitFor(() => !a.driver.isReady(), 10_000, 'Body A dropped by revocation');
    expect(runtime.registry.get(a.identity.id)?.status).toBe('revoked');
    expect(runtime.registry.get(a.identity.id)?.revokedAt).toBeGreaterThan(0);

    // A reconnect attempt must fail closed and keep the revoked state.
    a.driver.connect();
    await waitFor(() => runtime.registry.get(a.identity.id)?.status === 'revoked', 8_000, 'revoked stays revoked');
    expect(runtime.isBodyConnected(a.identity.id)).toBe(false);
    // Body B is untouched by A's revocation.
    expect(b.driver.isReady()).toBe(true);
    expect(runtime.registry.get(b.identity.id)?.status).toBe('online');
  }, 60_000);

  it('duplicate body identity keeps one registry record and one live connection', async () => {
    const brainDir = tmpDir('blaxin-brain-');
    const dirA = tmpDir('blaxin-bodyA-');
    const { runtime, wsUrl } = await makeBrain({ dir: brainDir });
    const a = await makeBody(dirA, wsUrl, { name: 'Body A', autoReconnect: false });
    const code = runtime.generatePairingCode()?.code as string;
    await pairAndReady(a, code, 'Body A');

    // A second driver with the SAME identity (same key) connects: the new
    // connection replaces the old one; the registry keeps a single record.
    const events2: Array<{ event: string; data: any }> = [];
    const registry2 = new MiniRegistry();
    const fs2 = new FileSystemTool();
    registry2.register(fs2);
    const driver2 = new RemoteBrainDriver({
      identity: a.identity,
      url: wsUrl,
      state: new BodyState(dirA),
      toolRegistry: registry2,
      getConfig: () => makeConfig({ requireConfirmation: false }),
      onEvent: (event, data) => { events2.push({ event, data }); },
      autoReconnect: false,
    });
    drivers.push(driver2);
    driver2.connect();
    await waitFor(() => driver2.isReady(), 15_000, 'second connection ready');

    // Exactly one registry record; the replaced socket did not flip it offline.
    expect(runtime.listDevices()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300)); // let the old socket's close land
    expect(runtime.registry.get(a.identity.id)?.status).toBe('online');
    expect(runtime.isBodyConnected(a.identity.id)).toBe(true);
    expect(a.driver.isReady()).toBe(false); // the original connection was replaced
  }, 60_000);

  it('no-target safety: a dropped Body fails its task with CONNECTION_LOST and it is never rerouted', async () => {
    const brainDir = tmpDir('blaxin-brain-');
    const dirA = tmpDir('blaxin-bodyA-');
    const dirB = tmpDir('blaxin-bodyB-');
    const marker = join(brainDir, 'marker.txt');
    writeFileSync(marker, 'NEVER-REROUTED');
    const gate = new GateDriver(taskStep('filesystem', { operation: 'read', path: marker }, 'read marker'));
    const { runtime, wsUrl } = await makeBrain({
      dir: brainDir,
      drivers: new Map([['gate', gate]]),
      defaultDriverId: 'gate',
    });
    const a = await makeBody(dirA, wsUrl, { name: 'Body A' });
    const b = await makeBody(dirB, wsUrl, { name: 'Body B' });
    const code = runtime.generatePairingCode()?.code as string;
    await pairAndReady(a, code, 'Body A');
    const code2 = runtime.generatePairingCode()?.code as string;
    await pairAndReady(b, code2, 'Body B');

    // A starts a task; the driver is held open by the gate.
    a.driver.sendUserMessage('read the marker');
    await waitFor(() => runtime['activeTasks'].has(a.identity.id), 10_000, 'task active on A');

    // A drops mid-task.
    a.driver.disconnect();
    await waitFor(() => runtime.registry.get(a.identity.id)?.status === 'offline', 8_000, 'A offline');

    // Release the gate: the Brain must fail A's action with CONNECTION_LOST,
    // never route it to Body B. A is disconnected, so the verdict is
    // observed on the Brain side (the driver's recorded result).
    gate.release();
    await waitFor(() => gate.lastError !== null && gate.requests.length === 1, 10_000, 'A task verdict');
    expect(gate.lastError).toMatch(/CONNECTION_LOST/i);
    expect(runtime['activeTasks'].size).toBe(0); // the task terminated, never rerouted
    // Body B was never asked to run A's action and never executed anything.
    expect(gate.requests.every((r) => r.bodyId === a.identity.id)).toBe(true);
    expect(b.fsCalls.total).toBe(0);
    expect(b.driver.isReady()).toBe(true);
  }, 60_000);

  it('registry realtime events: add/status/offline/revoked/removed with monotonic versions', async () => {
    const brainDir = tmpDir('blaxin-brain-');
    const dirA = tmpDir('blaxin-bodyA-');
    const { runtime, wsUrl, adminUrl } = await makeBrain({ dir: brainDir });
    const { ws, frames } = await openAdminSocket(adminUrl);

    // Initial snapshot is authoritative and carries the current version.
    await waitFor(() => frames.length > 0 && frames[0].type === 'snapshot', 5_000, 'admin snapshot');
    const snapshot = frames[0];
    expect(Array.isArray(snapshot.bodies)).toBe(true);

    const a = await makeBody(dirA, wsUrl, { name: 'Body A' });
    const code = runtime.generatePairingCode()?.code as string;
    a.driver.connect(code);
    await waitFor(() => a.driver.isReady(), 15_000, 'Body A ready');

    // body-added then body-status online then capabilities refresh.
    await waitFor(() => frames.some((f) => f.type === 'body-added' && f.bodyId === a.identity.id), 5_000, 'body-added event');
    await waitFor(() => frames.some((f) => f.type === 'body-status' && f.bodyId === a.identity.id && f.body?.status === 'online'), 5_000, 'body-status online');
    await waitFor(() => frames.some((f) => f.type === 'body-capabilities-updated' && f.bodyId === a.identity.id), 5_000, 'capabilities event');

    // Every event version is strictly increasing (monotonic ordering).
    let lastVersion = snapshot.version;
    const mutations = frames.filter((f) => f.type !== 'snapshot');
    for (const f of mutations) {
      expect(f.version).toBeGreaterThan(lastVersion);
      lastVersion = f.version;
    }

    // Disconnect → body-status offline.
    a.driver.disconnect();
    await waitFor(() => frames.some((f) => f.type === 'body-status' && f.bodyId === a.identity.id && f.body?.status === 'offline'), 8_000, 'body-status offline');
    const offline = [...frames].reverse().find((f) => f.type === 'body-status' && f.body?.status === 'offline')!;
    expect(offline.version).toBeGreaterThan(snapshot.version);

    // Revoke → body-revoked; remove → body-removed.
    a.driver.connect();
    await waitFor(() => a.driver.isReady(), 15_000, 'A back online');
    runtime.revokeBody(a.identity.id);
    await waitFor(() => frames.some((f) => f.type === 'body-revoked' && f.bodyId === a.identity.id), 8_000, 'body-revoked event');
    const revokedFrame = [...frames].reverse().find((f) => f.type === 'body-revoked')!;
    expect(revokedFrame.body?.status).toBe('revoked');

    runtime.removeBody(a.identity.id);
    await waitFor(() => frames.some((f) => f.type === 'body-removed' && f.bodyId === a.identity.id), 8_000, 'body-removed event');

    // The final snapshot a fresh client receives is NEVER older than any
    // event we already saw (recovery property).
    const { frames: frames2 } = await openAdminSocket(adminUrl);
    await waitFor(() => frames2.length > 0 && frames2[0].type === 'snapshot', 5_000, 'second snapshot');
    expect(frames2[0].version).toBeGreaterThanOrEqual(lastVersion);
    expect((frames2[0].bodies || []).some((b: any) => b.bodyId === a.identity.id)).toBe(false);
    ws.terminate();
  }, 60_000);

  it('REST snapshot recovery: after the admin channel reconnects, the snapshot reflects the latest state', async () => {
    const brainDir = tmpDir('blaxin-brain-');
    const dirA = tmpDir('blaxin-bodyA-');
    const { runtime, wsUrl, adminUrl, adminHttp } = await makeBrain({ dir: brainDir });
    const a = await makeBody(dirA, wsUrl, { name: 'Body A' });
    const code = runtime.generatePairingCode()?.code as string;
    await pairAndReady(a, code, 'Body A');

    // Open an admin channel, then lose it (simulated disconnect).
    const { ws, frames } = await openAdminSocket(adminUrl);
    await waitFor(() => frames.length > 0, 5_000, 'first snapshot');
    const v1 = frames[0].version;

    // While the channel is down, revoke the body (state moves on).
    runtime.revokeBody(a.identity.id);
    await waitFor(() => runtime.registry.get(a.identity.id)?.status === 'revoked', 8_000, 'revoked');
    ws.terminate();

    // Reconnect: the authoritative REST snapshot reflects the REVOKED
    // state with a higher version than the old channel ever saw.
    const res = await fetch(`${adminHttp}/devices`);
    const snapshot = await res.json();
    expect(snapshot.version).toBeGreaterThan(v1);
    const record = snapshot.devices.find((d: any) => d.bodyId === a.identity.id);
    expect(record.status).toBe('revoked');
  }, 60_000);
});