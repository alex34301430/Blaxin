import { describe, it, expect, beforeEach } from 'vitest';
import { AgentOrchestrator } from '../orchestrator/index.js';
import { permissionKey, PermissionGrants } from '../utils/permission.js';
import { telemetry } from '../utils/telemetry.js';
import {
  buildFakes, FakeProvider, StubTool, makeToolCall, sleep, makeConfig,
} from './helpers/orchestrator-fakes.js';

interface Ev { event: string; data: any }

beforeEach(() => {
  telemetry.reset();
});

// ── permissionKey + PermissionGrants (pure unit) ───────────────

describe('permissionKey', () => {
  it('scopes filesystem grants to the operation', () => {
    expect(permissionKey('filesystem', { operation: 'delete', path: '/tmp/a' })).toBe('filesystem:delete');
    expect(permissionKey('filesystem', { operation: 'write', path: '/tmp/a' })).toBe('filesystem:write');
  });

  it('uses the tool name for everything else', () => {
    expect(permissionKey('terminal', { command: 'rm -rf /' })).toBe('terminal');
    expect(permissionKey('browser', {})).toBe('browser');
  });
});

describe('PermissionGrants', () => {
  it('ignores one-shot approvals', () => {
    const g = new PermissionGrants();
    g.grant('terminal', 'once');
    expect(g.effectiveFor('terminal')).toBeNull();
  });

  it('honors session grants across tasks', () => {
    const g = new PermissionGrants();
    g.grant('terminal', 'session');
    expect(g.effectiveFor('terminal', 'task-a')).toBe('ALLOW_SESSION');
    expect(g.effectiveFor('terminal', 'task-b')).toBe('ALLOW_SESSION');
  });

  it('only honors task grants for their owning task', () => {
    const g = new PermissionGrants();
    g.grant('filesystem:delete', 'task', 'task-1');
    expect(g.effectiveFor('filesystem:delete', 'task-1')).toBe('ALLOW_TASK');
    expect(g.effectiveFor('filesystem:delete', 'task-2')).toBeNull();
  });

  it('clears task grants without touching session grants', () => {
    const g = new PermissionGrants();
    g.grant('terminal', 'task', 'task-1');
    g.grant('browser', 'session');
    g.clearTask('task-1');
    expect(g.effectiveFor('terminal', 'task-1')).toBeNull();
    expect(g.effectiveFor('browser')).toBe('ALLOW_SESSION');
  });

  it('clearAll forgets everything', () => {
    const g = new PermissionGrants();
    g.grant('terminal', 'session');
    g.clearAll();
    expect(g.effectiveFor('terminal')).toBeNull();
    expect(g.size()).toBe(0);
  });
});

// ── Orchestrator confirmation-gate integration ─────────────────

function makeOrchestrator(fakes: ReturnType<typeof buildFakes>, events: Ev[]) {
  const orch = new AgentOrchestrator({
    providers: fakes.providers,
    toolRegistry: fakes.tools,
    sessionState: fakes.session,
    memoryStore: fakes.memory,
    getConfig: () => fakes.config,
  });
  orch.setEventCallback((event, data) => events.push({ event, data }));
  return orch;
}

/** Answer the Nth (0-based) confirmation request with a scope choice. */
async function respondToConfirmation(
  orch: AgentOrchestrator, events: Ev[], n: number, approved: boolean, scope: 'once' | 'task' | 'session' = 'once',
): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const pending = events.filter((e) => e.event === 'confirmation-required');
    const ev = pending[n];
    if (ev) {
      orch.respondToConfirmation(ev.data.stepId, approved, scope);
      return;
    }
    await sleep(10);
  }
  throw new Error(`No confirmation-required event #${n} was emitted`);
}

function confirmationCount(events: Ev[]): number {
  return events.filter((e) => e.event === 'confirmation-required').length;
}

function lastProgressSteps(events: Ev[]): any[] {
  const progress = events.filter((e) => e.event === 'task-progress');
  return progress[progress.length - 1]?.data?.steps ?? [];
}

function scriptTerminalRm(provider: FakeProvider, times: number): void {
  for (let i = 0; i < times; i++) {
    provider.script.push({ toolCalls: [makeToolCall('terminal', { command: 'rm -rf /tmp/x' })] });
  }
  provider.script.push({ content: 'Done.' });
}

describe('confirmation gate scopes (embedded)', () => {
  it('approve-once: each identical action is asked again (ALLOW_ONCE)', async () => {
    const fakes = buildFakes();
    fakes.tools.register(new StubTool('terminal', { executionMode: 'serial' }));
    scriptTerminalRm(fakes.providers.getProvider() as FakeProvider, 2);

    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);
    const run = orch.processMessage('please handle this task');
    await respondToConfirmation(orch, events, 0, true, 'once');
    await respondToConfirmation(orch, events, 1, true, 'once');
    await run;

    const steps = lastProgressSteps(events);
    expect(confirmationCount(events)).toBe(2);
    expect(steps.map((s) => s.permissionScope)).toEqual(['ALLOW_ONCE', 'ALLOW_ONCE']);
  });

  it('approve-task: the rest of the same task auto-proceeds (ALLOW_TASK)', async () => {
    const fakes = buildFakes();
    fakes.tools.register(new StubTool('terminal', { executionMode: 'serial' }));
    scriptTerminalRm(fakes.providers.getProvider() as FakeProvider, 2);

    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);
    const run = orch.processMessage('please handle this task');
    await respondToConfirmation(orch, events, 0, true, 'task');
    await run;

    const steps = lastProgressSteps(events);
    expect(confirmationCount(events)).toBe(1);
    expect(steps.map((s) => s.permissionScope)).toEqual(['ALLOW_TASK', 'ALLOW_TASK']);
  });

  it('task grants expire when the task ends: the next task asks again', async () => {
    const fakes = buildFakes();
    fakes.tools.register(new StubTool('terminal', { executionMode: 'serial' }));
    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);

    // Task 1: approve with task scope.
    scriptTerminalRm(fakes.providers.getProvider() as FakeProvider, 1);
    const run1 = orch.processMessage('please handle task one');
    await respondToConfirmation(orch, events, 0, true, 'task');
    await run1;

    // Task 2: the same action must be asked about again.
    scriptTerminalRm(fakes.providers.getProvider() as FakeProvider, 1);
    const run2 = orch.processMessage('please handle task two');
    await respondToConfirmation(orch, events, 1, true, 'once');
    await run2;

    expect(confirmationCount(events)).toBe(2);
  });

  it('approve-session: later tasks auto-proceed without asking (ALLOW_SESSION)', async () => {
    const fakes = buildFakes();
    fakes.tools.register(new StubTool('terminal', { executionMode: 'serial' }));
    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);

    // Task 1: approve with session scope.
    scriptTerminalRm(fakes.providers.getProvider() as FakeProvider, 1);
    const run1 = orch.processMessage('please handle task one');
    await respondToConfirmation(orch, events, 0, true, 'session');
    await run1;

    // Task 2: the same action runs without any confirmation prompt.
    scriptTerminalRm(fakes.providers.getProvider() as FakeProvider, 1);
    const run2 = orch.processMessage('please handle task two');
    await run2;

    expect(confirmationCount(events)).toBe(1);
    const steps = lastProgressSteps(events);
    expect(steps[0]?.permissionScope).toBe('ALLOW_SESSION');
  });

  it('clearHistory forgets session grants', async () => {
    const fakes = buildFakes();
    fakes.tools.register(new StubTool('terminal', { executionMode: 'serial' }));
    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);

    scriptTerminalRm(fakes.providers.getProvider() as FakeProvider, 1);
    const run1 = orch.processMessage('please handle task one');
    await respondToConfirmation(orch, events, 0, true, 'session');
    await run1;

    orch.clearHistory();

    scriptTerminalRm(fakes.providers.getProvider() as FakeProvider, 1);
    const run2 = orch.processMessage('please handle task two');
    await respondToConfirmation(orch, events, 1, true, 'once');
    await run2;

    expect(confirmationCount(events)).toBe(2);
  });
});

describe('fast path honors grants too', () => {
  it('a session grant applies to direct (router) actions', async () => {
    const fakes = buildFakes({ requireConfirmation: true });
    // browser needs confirmation in the fake registry and is direct-routable
    // via "open <url>".
    fakes.tools.register(new StubTool('browser', { needsConfirmation: true, executionMode: 'serial' }));
    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);

    const run1 = orch.processMessage('open https://example.com');
    await respondToConfirmation(orch, events, 0, true, 'session');
    await run1;

    // Second direct request: same key (browser) → grant applies.
    const run2 = orch.processMessage('open https://example.org');
    await run2;

    expect(confirmationCount(events)).toBe(1);
  });
});