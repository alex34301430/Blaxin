import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BrainRuntime } from '../../distributed/brain-runtime.js';
import { DeterministicDriver, LLMTaskDriver } from '../../distributed/brain-drivers.js';
import { RemoteBrainDriver } from '../../distributed/remote-brain.js';
import { BodyState } from '../../distributed/body-state.js';
import { loadOrCreateIdentity } from '../../distributed/identity.js';
import { taskLifecycleOf, isTerminalLifecycle, MESSAGE_TYPES } from '../../distributed/types.js';
import { FileSystemTool } from '../../tools/filesystem.js';
import type { Tool, ToolDefinition, ToolResult, ProviderId } from '../../types.js';

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

// ── Lifecycle mapping (pure) ──────────────────────────────────────

describe('task lifecycle mapping', () => {
  it('maps driver states onto canonical lifecycle states', () => {
    expect(taskLifecycleOf('queued')).toBe('QUEUED');
    expect(taskLifecycleOf('planning')).toBe('RUNNING');
    expect(taskLifecycleOf('thinking')).toBe('RUNNING');
    expect(taskLifecycleOf('executing')).toBe('RUNNING');
    expect(taskLifecycleOf('observing')).toBe('RUNNING');
    expect(taskLifecycleOf('completed')).toBe('COMPLETED');
    expect(taskLifecycleOf('failed')).toBe('FAILED');
    expect(taskLifecycleOf('cancelled')).toBe('CANCELLED');
    expect(taskLifecycleOf('interrupted')).toBe('CONNECTION_LOST');
    expect(taskLifecycleOf('unknown-outcome')).toBe('UNKNOWN_OUTCOME');
    expect(taskLifecycleOf('recovering')).toBe('RECOVERING');
    expect(taskLifecycleOf('anything-else')).toBe('RUNNING');
  });

  it('treats only the five honest end states as terminal', () => {
    expect(isTerminalLifecycle('COMPLETED')).toBe(true);
    expect(isTerminalLifecycle('FAILED')).toBe(true);
    expect(isTerminalLifecycle('CANCELLED')).toBe(true);
    expect(isTerminalLifecycle('CONNECTION_LOST')).toBe(true);
    expect(isTerminalLifecycle('UNKNOWN_OUTCOME')).toBe(true);
    expect(isTerminalLifecycle('RUNNING')).toBe(false);
    expect(isTerminalLifecycle('QUEUED')).toBe(false);
    expect(isTerminalLifecycle('RECOVERING')).toBe(false);
  });

  it('exposes task_cancel on the wire', () => {
    expect(MESSAGE_TYPES).toContain('task_cancel');
  });
});

// ── Driver-level cancellation (pure) ──────────────────────────────

const FILESYSTEM_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'filesystem',
    description: 'Filesystem access',
    parameters: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'] },
  },
};

function makeCtx(overrides: Partial<Parameters<DeterministicDriver['run']>[0]> = {}): Parameters<DeterministicDriver['run']>[0] {
  return {
    taskId: 't1',
    text: 'x',
    bodyId: 'BLX-BODY-1',
    bodyName: 'b',
    capabilities: ['filesystem'],
    tools: [FILESYSTEM_DEF],
    update: () => {},
    requestAction: async (req) => ({
      taskId: req.taskId, actionId: req.actionId, requestId: req.requestId,
      outcome: 'allowed', executed: true, replay: false, success: true, output: 'ok',
    }),
    note: () => {},
    isCancelled: () => false,
    ...overrides,
  } as Parameters<DeterministicDriver['run']>[0];
}

describe('driver cancellation', () => {
  it('DeterministicDriver finishes the step in flight, then reports CANCELLED', async () => {
    const executed: string[] = [];
    let cancelled = false;
    const driver = new DeterministicDriver({
      steps: [
        { tool: 'filesystem', args: { operation: 'read', path: '/tmp/a' }, description: 'read a' },
        { tool: 'filesystem', args: { operation: 'read', path: '/tmp/b' }, description: 'read b' },
      ],
    });
    const ctx = makeCtx({
      requestAction: async (req) => {
        executed.push(req.actionId);
        cancelled = true; // the user presses stop while action 1 runs
        return {
          taskId: req.taskId, actionId: req.actionId, requestId: req.requestId,
          outcome: 'allowed', executed: true, replay: false, success: true, output: 'ok',
        };
      },
      isCancelled: () => cancelled,
    });
    const outcome = await driver.run(ctx);
    expect(outcome).toEqual({ kind: 'failed', error: 'The task was cancelled by the user.', code: 'CANCELLED' });
    expect(executed.length).toBe(1); // step 2 never ran
  });

  it('LLMTaskDriver aborts an in-flight provider call when cancelled', async () => {
    let cancelHook: (() => void) | undefined;
    const hangingProvider = {
      id: 'openrouter' as ProviderId,
      name: 'OpenRouter',
      apiKeyRequired: false,
      hasApiKey: () => true,
      chat: () => new Promise<never>(() => {}), // never resolves
    };
    const driver = new LLMTaskDriver({
      providers: {
        getActiveProvider: () => 'openrouter',
        getActiveModel: () => 'm',
        getProvider: () => hangingProvider,
      },
      maxActionWaitMs: 1000,
    });
    const outcomePromise = driver.run(makeCtx({
      requestAction: async () => { throw new Error('should not request actions'); },
      onCancel: (hook) => { cancelHook = hook; },
    }));
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelHook).toBeTypeOf('function');
    cancelHook!();
    const outcome = await outcomePromise;
    expect(outcome).toEqual({ kind: 'failed', error: 'The task was cancelled by the user.', code: 'CANCELLED' });
  });
});

// ── task_cancel over the wire (real sockets) ──────────────────────

describe('task_cancel over the wire', () => {
  it('stops a running task with a clean CANCELLED outcome', async () => {
    const dir = tmpDir('blaxin-cancel-');
    const target = join(dir, 'slow.txt');
    writeFileSync(target, 'x'.repeat(10));

    // A real filesystem tool, but wrap execute for a specific path so the
    // action is slow enough to cancel mid-flight.
    const fsTool = new FileSystemTool();
    const registry = {
      getTool(name: string): Tool | undefined { return name === 'filesystem' ? fsTool : undefined; },
      getToolDefinitions(): ToolDefinition[] { return [fsTool.definition]; },
      async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        if (name === 'filesystem' && String(args.path || '') === target) {
          await new Promise((r) => setTimeout(r, 800)); // slow read
        }
        return fsTool.execute(args);
      },
      requiresConfirmation(name: string, args: Record<string, unknown>): boolean {
        return fsTool.requiresConfirmation?.(args) ?? false;
      },
    };

    const runtime = new BrainRuntime({
      host: '127.0.0.1',
      port: 0,
      identityFile: join(dir, 'brain-identity.json'),
      registryFile: join(dir, 'devices.json'),
      drivers: new Map([['deterministic', new DeterministicDriver({
        steps: [
          { tool: 'filesystem', args: { operation: 'read', path: target }, description: 'slow read' },
          { tool: 'filesystem', args: { operation: 'read', path: join(dir, 'never.txt') }, description: 'never runs' },
        ],
      })]]),
      defaultDriverId: 'deterministic',
    });
    runtimes.push(runtime);
    const info = await runtime.start();

    const identity = loadOrCreateIdentity({ filePath: join(dir, 'body-identity.json'), role: 'body', name: 'Test Body' });
    const events: Array<{ event: string; data: any }> = [];
    const driver = new RemoteBrainDriver({
      identity,
      url: info.wsUrl,
      state: new BodyState(dir),
      toolRegistry: registry,
      onEvent: (event, data) => { events.push({ event, data }); },
      autoReconnect: false,
    });
    drivers.push(driver);

    const code = runtime.generatePairingCode()?.code;
    expect(code).toBeTruthy();
    driver.connect(code);
    await waitFor(() => driver.isReady(), 10_000, 'body connected');

    driver.sendUserMessage('please read the slow file');
    await waitFor(() => hasEvent(events, 'tool-execution'), 10_000, 'action in flight');
    const connectIdleCount = events.filter(
      (e) => e.event === 'agent-state' && e.data.state === 'idle',
    ).length;

    // Cancel while the slow action is running.
    driver.stopTask();

    // The Brain resolves pending actions, fails the task CANCELLED and the
    // Body surfaces a clean stop (idle) instead of a fake error.
    await waitFor(
      () => events.filter((e) => e.event === 'agent-state' && e.data.state === 'idle').length > connectIdleCount,
      10_000,
      'clean stop after cancel',
    );
    expect(hasEvent(events, 'error')).toBe(false);

    // The Brain's task session ended (removed from activeTasks).
    await waitFor(() => {
      const active = (runtime as unknown as { activeTasks: Map<string, unknown> }).activeTasks;
      return active.size === 0;
    }, 5_000, 'brain task session cleaned up');
  });

  it('task_cancel for an unknown/finished task is ignored idempotently', async () => {
    const dir = tmpDir('blaxin-cancel2-');
    const runtime = new BrainRuntime({
      host: '127.0.0.1',
      port: 0,
      identityFile: join(dir, 'brain-identity.json'),
      registryFile: join(dir, 'devices.json'),
      drivers: new Map([['deterministic', new DeterministicDriver({ steps: [] })]]),
      defaultDriverId: 'deterministic',
    });
    runtimes.push(runtime);
    const info = await runtime.start();

    const identity = loadOrCreateIdentity({ filePath: join(dir, 'body-identity.json'), role: 'body', name: 'Test Body' });
    const events: Array<{ event: string; data: any }> = [];
    const driver = new RemoteBrainDriver({
      identity,
      url: info.wsUrl,
      state: new BodyState(dir),
      onEvent: (event, data) => { events.push({ event, data }); },
      autoReconnect: false,
    });
    drivers.push(driver);

    const code = runtime.generatePairingCode()?.code;
    driver.connect(code);
    await waitFor(() => driver.isReady(), 10_000, 'body connected');

    // No task is running; stopping must be a no-op, not a crash.
    expect(() => driver.stopTask()).not.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(driver.isReady()).toBe(true);
  });
});

// Guard against unused imports in strict configs.
void readFileSync; void unlinkSync;
