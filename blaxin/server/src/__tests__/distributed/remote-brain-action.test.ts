import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RemoteBrainDriver } from '../../distributed/remote-brain.js';
import { BodyState } from '../../distributed/body-state.js';
import { loadOrCreateIdentity } from '../../distributed/identity.js';
import { FileSystemTool } from '../../tools/filesystem.js';
import { makeConfig } from '../helpers/orchestrator-fakes.js';
import type { Tool, ToolDefinition, ToolResult } from '../../types.js';

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** Minimal tool registry over the REAL filesystem tool (with counters). */
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

interface ActionRequest {
  taskId: string; actionId: string; requestId: string;
  action: { tool: string; args: Record<string, unknown> };
  idempotent: boolean; description: string;
}

interface ActionResultShape {
  outcome: string; executed: boolean; replay: boolean; success?: boolean;
  output?: string; error?: string;
}

/** Public surface the tests drive (evaluateAndExecute is private on the
 * driver; the tests reach it through this structural view). */
interface Exec {
  evaluateAndExecute(req: ActionRequest): Promise<ActionResultShape>;
  respondToConfirmation(stepId: string | undefined, approved: boolean): void;
}

function makeDriver(dir: string): { driver: Exec; registry: MiniRegistry; fsCalls: { total: number }; state: BodyState } {
  const registry = new MiniRegistry();
  const fsTool = new FileSystemTool();
  const fsCalls = registry.register(fsTool);
  const identity = loadOrCreateIdentity({ filePath: join(dir, 'body-identity.json'), role: 'body', name: 'Test Body' });
  const state = new BodyState(dir);
  const driver = new RemoteBrainDriver({
    identity,
    url: 'ws://127.0.0.1:1/ws/brain', // never connected in this unit test
    state,
    toolRegistry: registry,
    getConfig: () => makeConfig({ requireConfirmation: true, maxRetries: 2 }),
    autoReconnect: false,
  }) as unknown as Exec;
  return { driver, registry, fsCalls, state };
}

function req(tool: string, args: Record<string, unknown>, actionId = `act_${Math.random().toString(36).slice(2)}`): ActionRequest {
  return { taskId: 'task-1', actionId, requestId: actionId, action: { tool, args }, idempotent: true, description: `${tool} test` };
}

describe('body action gate (capability + policy + replay safety)', () => {
  it('executes an allowed filesystem read and returns its output', async () => {
    const dir = tmpDir('blaxin-gate-');
    const target = join(dir, 'notes.txt');
    writeFileSync(target, 'gate-test-content');
    const { driver, fsCalls } = makeDriver(dir);

    const result = await driver.evaluateAndExecute(req('filesystem', { operation: 'read', path: target }));
    expect(result.outcome).toBe('allowed');
    expect(result.success).toBe(true);
    expect(result.output).toContain('gate-test-content');
    expect(result.executed).toBe(true);
    expect(fsCalls.total).toBe(1);
  });

  it('rejects a tool the Body does not have', async () => {
    const dir = tmpDir('blaxin-gate-');
    const { driver } = makeDriver(dir);
    const result = await driver.evaluateAndExecute(req('computer-control', { action: 'key_press', key: 'x' }));
    expect(result.outcome).toBe('rejected');
    expect(result.error).toContain('UNKNOWN_TOOL');
  });

  it('never executes a denied high-impact action (confirmation gate)', async () => {
    const dir = tmpDir('blaxin-gate-');
    const target = join(dir, 'secret.txt');
    const { driver } = makeDriver(dir);
    const actionId = 'act_deny_1';

    const pending = driver.evaluateAndExecute(req('filesystem', { operation: 'write', path: target, content: 'x' }, actionId));
    // The gate waits for the user; deny it.
    setTimeout(() => driver.respondToConfirmation(actionId, false), 10);
    const result = await pending;

    expect(result.outcome).toBe('denied');
    expect(result.executed).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it('executes after explicit approval', async () => {
    const dir = tmpDir('blaxin-gate-');
    const target = join(dir, 'approved.txt');
    const { driver } = makeDriver(dir);
    const actionId = 'act_approve_1';

    const pending = driver.evaluateAndExecute(req('filesystem', { operation: 'write', path: target, content: 'y' }, actionId));
    setTimeout(() => driver.respondToConfirmation(actionId, true), 10);
    const result = await pending;

    expect(result.outcome).toBe('allowed');
    expect(existsSync(target)).toBe(true);
  });

  it('prevents duplicate execution: a resent action is answered from the ledger', async () => {
    const dir = tmpDir('blaxin-gate-');
    const target = join(dir, 'notes.txt');
    writeFileSync(target, 'once');
    const { driver, fsCalls } = makeDriver(dir);

    const first = await driver.evaluateAndExecute(req('filesystem', { operation: 'read', path: target }, 'act_dup_1'));
    expect(first.outcome).toBe('allowed');
    expect(fsCalls.total).toBe(1);

    // Same actionId arrives again (post-reconnect resend): cached replay.
    const second = await driver.evaluateAndExecute(req('filesystem', { operation: 'read', path: target }, 'act_dup_1'));
    expect(second.replay).toBe(true);
    expect(second.executed).toBe(false);
    expect(second.success).toBe(true);
    expect(fsCalls.total).toBe(1); // tool did NOT run again
  });

  it('refuses blind replay of a non-idempotent action with an unresolved ledger entry', async () => {
    const dir = tmpDir('blaxin-gate-');
    const target = join(dir, 'fragile.txt');
    const { driver, state } = makeDriver(dir);
    const actionId = 'act_nonidem_1';

    // Simulate a crash after the request arrived but before the tool
    // finished: the ledger holds a 'received' entry with no final verdict.
    state.markActionReceived({
      actionId, taskId: 'task-1', tool: 'filesystem', idempotent: false,
    });

    const result = await driver.evaluateAndExecute({
      taskId: 'task-1', actionId, requestId: actionId,
      action: { tool: 'filesystem', args: { operation: 'delete', path: target } },
      idempotent: false,
      description: 'non-idempotent delete',
    });
    expect(result.outcome).toBe('rejected');
    expect(result.error).toContain('NON_IDEMPOTENT_UNKNOWN_STATE');
    expect(existsSync(target)).toBe(false); // nothing was deleted
  });

  it('runs an idempotent action again when the ledger shows it was interrupted', async () => {
    const dir = tmpDir('blaxin-gate-');
    const target = join(dir, 'notes.txt');
    writeFileSync(target, 'hello');
    const { driver, state, fsCalls } = makeDriver(dir);
    const actionId = 'act_idem_1';

    state.markActionReceived({
      actionId, taskId: 'task-1', tool: 'filesystem', idempotent: true,
    });

    const result = await driver.evaluateAndExecute(req('filesystem', { operation: 'read', path: target }, actionId));
    expect(result.outcome).toBe('allowed');
    expect(result.replay).toBe(false);
    expect(fsCalls.total).toBe(1); // safe to re-run: reads are idempotent
  });
});
