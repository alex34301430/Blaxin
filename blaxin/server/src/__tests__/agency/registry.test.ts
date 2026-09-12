// Agency registry tests (directive §5–§11, §30)
// =============================================================
// Every lifecycle transition in these tests is driven by REAL event
// payloads (exactly the shapes the orchestrator emits). The suite also
// pins the no-fake guarantees: unknown events never create workers,
// uncorrelatable settles are ignored, and a real stop settles workers
// as cancelled.
// =============================================================

import { describe, it, expect, vi } from 'vitest';
import {
  AgencyRegistry, roleForTool, describeToolAction,
} from '../../agency/registry.js';

/** Drive the registry with real event names, exactly like index.ts. */
function feed(reg: AgencyRegistry, event: string, data: any): void {
  switch (event) {
    case 'agent-state':           reg.onAgentState(data); break;
    case 'tool-execution':        reg.onToolExecution(data); break;
    case 'confirmation-required': reg.onConfirmationRequired(data); break;
    case 'task-progress':         reg.onTaskProgress(data); break;
    case 'task-complete':         reg.onTaskComplete(data); break;
    case 'queue-updated':         reg.onQueueUpdated(data?.tasks ?? []); break;
  }
}

describe('roleForTool', () => {
  it('derives the specialist role from the actual tool', () => {
    expect(roleForTool('browser')).toBe('BROWSER');
    expect(roleForTool('computer-control')).toBe('COMPUTER');
    expect(roleForTool('filesystem')).toBe('FILES');
    expect(roleForTool('search')).toBe('RESEARCH');
    expect(roleForTool('terminal')).toBe('TERMINAL');
    expect(roleForTool('vision')).toBe('VISION');
    // Unknown tools stay GENERAL — never a fabricated specialist.
    expect(roleForTool('something-else')).toBe('GENERAL');
  });
});

describe('describeToolAction', () => {
  it('renders a human description from real args', () => {
    expect(describeToolAction('browser', { url: 'https://youtube.com' })).toContain('youtube.com');
    expect(describeToolAction('filesystem', { operation: 'list', path: '/tmp' })).toContain('/tmp');
    expect(describeToolAction('computer-control', { action: 'mouse_click', x: 10, y: 20 })).toContain('10');
    expect(describeToolAction('mystery-tool')).toBe('Tool action');
  });
});

describe('AgencyRegistry lifecycle (real events only)', () => {
  it('creates a running worker from a real executing event and settles it', () => {
    const reg = new AgencyRegistry();
    feed(reg, 'task-progress', { id: 'task-1', state: 'executing' });
    feed(reg, 'tool-execution', {
      toolName: 'filesystem', args: { operation: 'list', path: '/tmp' },
      state: 'executing', stepId: 'step-1',
    });

    let snap = reg.snapshot();
    expect(snap.activeCount).toBe(1);
    expect(snap.workers).toHaveLength(1);
    expect(snap.workers[0]).toMatchObject({
      id: 'step-1', role: 'FILES', tool: 'filesystem', state: 'running', taskId: 'task-1',
    });
    expect(snap.workers[0].startedAt).toBeGreaterThan(0);

    feed(reg, 'tool-execution', {
      toolName: 'filesystem', state: 'completed', stepId: 'step-1', result: '3 entries',
    });
    snap = reg.snapshot();
    expect(snap.activeCount).toBe(0);
    expect(snap.workers[0].state).toBe('completed');
    expect(snap.workers[0].result).toBe('3 entries');
    expect(snap.workers[0].endedAt).toBeGreaterThan(0);
  });

  it('shows WAITING only from a real confirmation-required event', () => {
    const reg = new AgencyRegistry();
    feed(reg, 'confirmation-required', {
      taskId: 'task-9', stepId: 'call-1', runtimeStepId: 'step-9',
      description: 'Execute browser: open https://example.com',
      action: JSON.stringify({ tool: 'browser', args: { url: 'https://example.com/' } }),
    });

    const snap = reg.snapshot();
    expect(snap.taskWaiting).toBe(true);
    expect(snap.workers[0]).toMatchObject({
      id: 'step-9', state: 'waiting', tool: 'browser', toolKnown: true, role: 'BROWSER',
    });
    // Tool + description come from the REAL gate action payload.
    expect(snap.workers[0].description).toContain('example.com');
  });

  it('degrades honestly when the gate action payload is malformed', () => {
    const reg = new AgencyRegistry();
    feed(reg, 'confirmation-required', { stepId: 'call-2', runtimeStepId: 'step-2', action: '{not json' });
    const w = reg.snapshot().workers[0];
    expect(w.state).toBe('waiting');
    expect(w.tool).toBe('unknown');
    expect(w.toolKnown).toBe(false);
  });

  it('binds a pending approval to the later execution of the same step', () => {
    const reg = new AgencyRegistry();
    feed(reg, 'confirmation-required', { stepId: 'call-1', runtimeStepId: 'step-5', taskId: 't' });
    feed(reg, 'tool-execution', {
      toolName: 'terminal', args: { command: 'ls' }, state: 'executing', stepId: 'step-5',
    });
    const snap = reg.snapshot();
    expect(snap.workers[0]).toMatchObject({
      id: 'step-5', state: 'running', tool: 'terminal', toolKnown: true, role: 'TERMINAL',
    });
  });

  it('marks failed/skipped outcomes honestly', () => {
    const reg = new AgencyRegistry();
    feed(reg, 'tool-execution', { toolName: 'browser', state: 'executing', stepId: 's1', args: { url: 'https://x' } });
    feed(reg, 'tool-execution', { toolName: 'browser', state: 'failed', stepId: 's1', error: 'browser crashed' });
    feed(reg, 'tool-execution', { toolName: 'filesystem', state: 'executing', stepId: 's2', args: { operation: 'delete' } });
    feed(reg, 'tool-execution', { toolName: 'filesystem', state: 'skipped', stepId: 's2', result: 'Denied by user' });

    const [b, f] = reg.snapshot().workers;
    expect(b.state).toBe('failed');
    expect(b.error).toBe('browser crashed');
    expect(f.state).toBe('skipped');
  });

  it('counts real retry events', () => {
    const reg = new AgencyRegistry();
    feed(reg, 'tool-execution', { toolName: 'search', state: 'executing', stepId: 'r1', args: { query: 'q' } });
    feed(reg, 'tool-execution', { toolName: 'search', state: 'retrying', stepId: 'r1' });
    feed(reg, 'tool-execution', { toolName: 'search', state: 'retrying', stepId: 'r1' });
    feed(reg, 'tool-execution', { toolName: 'search', state: 'completed', stepId: 'r1' });
    expect(reg.snapshot().workers[0]).toMatchObject({ state: 'completed', attempts: 2 });
  });

  it('settles still-active workers as cancelled on a real stop (agent idle)', () => {
    const reg = new AgencyRegistry();
    feed(reg, 'tool-execution', { toolName: 'browser', state: 'executing', stepId: 'live-1', args: {} });
    feed(reg, 'tool-execution', { toolName: 'terminal', state: 'executing', stepId: 'live-2', args: {} });
    feed(reg, 'agent-state', { state: 'idle', description: null });

    const snap = reg.snapshot();
    expect(snap.agentState).toBe('idle');
    expect(snap.activeCount).toBe(0);
    expect(snap.workers.map((w) => w.state).sort()).toEqual(['cancelled', 'cancelled']);
  });

  it('reflects real queue state in queueWaiting', () => {
    const reg = new AgencyRegistry();
    feed(reg, 'queue-updated', { tasks: [
      { id: 'q1', status: 'queued', objective: 'A' },
      { id: 'q2', status: 'running', objective: 'B' },
      { id: 'q3', status: 'queued', objective: 'C' },
    ] });
    const snap = reg.snapshot();
    expect(snap.queueWaiting).toBe(2);
    expect(snap.queuedTasks).toHaveLength(3);
  });

  it('notifies subscribers with the snapshot on every change', () => {
    const onChange = vi.fn();
    const reg = new AgencyRegistry(onChange);
    feed(reg, 'agent-state', { state: 'executing', description: 'Working' });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.agentState).toBe('executing');
    expect(last.agentDescription).toBe('Working');
  });
});

describe('no-fake guarantees (directive §5/§7/§29)', () => {
  it('never creates a worker from an event it cannot correlate', () => {
    const reg = new AgencyRegistry();
    // Settled event without a stepId — no honest identity → no record.
    feed(reg, 'tool-execution', { toolName: 'browser', state: 'completed', result: 'x' });
    // Unknown executing payload without a stepId.
    feed(reg, 'tool-execution', { toolName: 'browser', state: 'executing' });
    // Events the registry does not model at all.
    feed(reg, 'activity', { type: 'executing', content: 'whatever' });
    feed(reg, 'agent-message', { role: 'assistant', content: 'hello' });

    const snap = reg.snapshot();
    expect(snap.workers).toHaveLength(0);
    expect(snap.activeCount).toBe(0);
  });

  it('never invents tool names or roles for a pending approval', () => {
    const reg = new AgencyRegistry();
    feed(reg, 'confirmation-required', { stepId: 'call-only' });
    const w = reg.snapshot().workers[0];
    expect(w.tool).toBe('unknown');
    expect(w.toolKnown).toBe(false);
    expect(w.role).toBe('GENERAL');
  });

  it('drops an unknown tool-execution state instead of guessing', () => {
    const reg = new AgencyRegistry();
    feed(reg, 'tool-execution', { toolName: 'browser', state: 'weird-state', stepId: 's' });
    expect(reg.snapshot().workers).toHaveLength(0);
  });

  it('stays bounded: 150 settled workers do not grow memory unboundedly', () => {
    const reg = new AgencyRegistry();
    for (let i = 0; i < 150; i++) {
      feed(reg, 'tool-execution', { toolName: 'filesystem', state: 'executing', stepId: `s${i}`, args: { operation: 'list' } });
      feed(reg, 'tool-execution', { toolName: 'filesystem', state: 'completed', stepId: `s${i}` });
    }
    const snap = reg.snapshot();
    expect(snap.workers.length).toBeLessThanOrEqual(20); // snapshot cap
    expect(snap.activeCount).toBe(0);
  });
});
