import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskQueue } from '../utils/task-queue.js';
import { MissionStore } from '../utils/missions.js';
import { JarvisScheduler, SchedulerOrchestratorLike } from '../utils/scheduler.js';

/** Fake orchestrator that records what it is asked to run and lets the
 * test drive real completion events through the scheduler. */
class FakeOrchestrator implements SchedulerOrchestratorLike {
  ran: string[] = [];
  running = false;
  isBusy(): boolean { return this.running; }
  async processMessage(message: string): Promise<void> {
    this.running = true;
    this.ran.push(message);
  }
  stop(): void { this.running = false; }
  clearHistory(): void { /* no-op */ }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blaxin-scheduler-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const queue = new TaskQueue({ file: join(dir, 'q.json') });
  const missions = new MissionStore({ file: join(dir, 'm.json') });
  const orchestrator = new FakeOrchestrator();
  const events: Array<{ event: string; data: unknown }> = [];
  const scheduler = new JarvisScheduler({
    queue,
    missions,
    orchestrator,
    emit: (event, data) => events.push({ event, data }),
  });
  return { queue, missions, orchestrator, scheduler, events };
}

/** Simulate the orchestrator finishing the current run with a real
 * terminal agent-state + task-complete pair (what index.ts wires). */
function finishRun(scheduler: JarvisScheduler, orchestrator: FakeOrchestrator, state: 'completed' | 'error' | 'idle') {
  orchestrator.running = false;
  scheduler.onOrchestratorEvent('agent-state', { state });
  scheduler.onOrchestratorEvent('task-complete', { kind: 'direct', totalMs: 5, modelCalls: 0, toolCalls: 1 });
}

describe('scheduler: queue execution', () => {
  it('runs the first queued message and settles it on completion', () => {
    const { queue, orchestrator, scheduler } = setup();
    const task = scheduler.enqueueUserMessage('list /tmp');
    expect(orchestrator.ran).toEqual(['list /tmp']);
    expect(queue.get(task.id)?.status).toBe('running');

    finishRun(scheduler, orchestrator, 'completed');
    expect(queue.get(task.id)?.status).toBe('completed');
    expect(queue.get(task.id)?.result).toContain('Fast-path task done');
  });

  it('runs queued messages sequentially, one at a time', () => {
    const { queue, orchestrator, scheduler } = setup();
    const a = scheduler.enqueueUserMessage('task a');
    const b = scheduler.enqueueUserMessage('task b');
    // Only the first runs; b waits in the queue.
    expect(orchestrator.ran).toEqual(['task a']);
    expect(queue.get(b.id)?.status).toBe('queued');

    finishRun(scheduler, orchestrator, 'completed');
    expect(orchestrator.ran).toEqual(['task a', 'task b']);
    expect(queue.get(a.id)?.status).toBe('completed');
    expect(queue.get(b.id)?.status).toBe('running');
  });

  it('marks a task failed when the agent ends in error state', () => {
    const { queue, orchestrator, scheduler } = setup();
    const task = scheduler.enqueueUserMessage('risky');
    finishRun(scheduler, orchestrator, 'error');
    expect(queue.get(task.id)?.status).toBe('failed');
  });

  it('cancels the task when the user stops the agent', () => {
    const { queue, orchestrator, scheduler } = setup();
    const task = scheduler.enqueueUserMessage('long run');
    scheduler.stop(); // orchestrator.stop() → agent ends idle
    finishRun(scheduler, orchestrator, 'idle');
    expect(queue.get(task.id)?.status).toBe('cancelled');
  });

  it('emits real queue-updated events', () => {
    const { scheduler, events } = setup();
    scheduler.enqueueUserMessage('hello');
    expect(events.some((e) => e.event === 'queue-updated')).toBe(true);
  });
});

describe('scheduler: missions', () => {
  it('executes every mission step in order with checkpoints', () => {
    const { queue, missions, orchestrator, scheduler } = setup();
    const m = missions.create({ objective: 'Fix build', steps: ['run tests', 'fix failures', 're-run tests'] });

    scheduler.pump();
    expect(orchestrator.ran).toEqual(['run tests']);
    const t1 = queue.list().find((t) => t.missionId === m.id)!;
    expect(t1.status).toBe('running');

    finishRun(scheduler, orchestrator, 'completed');
    expect(queue.get(t1.id)?.status).toBe('completed');
    expect(missions.get(m.id)!.steps[0].status).toBe('completed');
    expect(missions.get(m.id)!.steps[0].checkpoint?.summary).toBeTruthy();

    // step 2 runs next automatically
    expect(orchestrator.ran).toEqual(['run tests', 'fix failures']);
    const t2 = queue.list().find((t) => t.missionId === m.id && t.id !== t1.id)!;
    finishRun(scheduler, orchestrator, 'completed');
    expect(missions.get(m.id)!.steps[1].status).toBe('completed');

    expect(orchestrator.ran).toEqual(['run tests', 'fix failures', 're-run tests']);
    const t3 = queue.list().find((t) => t.missionId === m.id && t.id !== t1.id && t.id !== t2.id)!;
    finishRun(scheduler, orchestrator, 'completed');

    const done = missions.get(m.id)!;
    expect(done.status).toBe('completed');
    expect(done.progress).toBe(1);
    expect(done.steps.every((s) => s.status === 'completed')).toBe(true);
  });

  it('a failed step ends the mission failed; retry requeues only it', () => {
    const { queue, missions, orchestrator, scheduler } = setup();
    const m = missions.create({ objective: 'o', steps: ['good', 'bad'] });
    scheduler.pump();
    const t1 = queue.list().find((t) => t.missionId === m.id)!;
    finishRun(scheduler, orchestrator, 'completed');

    const t2 = queue.list().find((t) => t.missionId === m.id && t.id !== t1.id)!;
    finishRun(scheduler, orchestrator, 'error');

    const failed = missions.get(m.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.steps[0].status).toBe('completed');
    expect(failed.steps[1].status).toBe('failed');

    expect(missions.retry(m.id)).toBe(true);
    scheduler.pump();
    // Only the failed step is re-executed, from a fresh queue task.
    const retriedTasks = queue.list().filter((t) => t.missionId === m.id && t.status === 'running');
    expect(retriedTasks).toHaveLength(1);
    expect(orchestrator.ran).toContain('bad');
  });

  it('pause stops the mission at its checkpoint; resume continues after it', () => {
    const { queue, missions, orchestrator, scheduler } = setup();
    const m = missions.create({ objective: 'o', steps: ['s1', 's2', 's3'] });

    scheduler.pump();
    const t1 = queue.list().find((t) => t.missionId === m.id)!;
    finishRun(scheduler, orchestrator, 'completed');
    // s2 auto-started by the pump right after s1 completed
    expect(orchestrator.ran).toEqual(['s1', 's2']);
    const t2 = queue.list().find((t) => t.missionId === m.id && t.id !== t1.id)!;

    missions.pause(m.id);
    finishRun(scheduler, orchestrator, 'completed');
    // while paused, the mission must NOT advance to s3
    expect(queue.list().filter((t) => t.missionId === m.id)).toHaveLength(2);
    expect(orchestrator.ran).toEqual(['s1', 's2']);

    missions.resume(m.id);
    scheduler.pump();
    // resumes from the last checkpoint: s3, never s1 again
    const t3 = queue.list().find((t) => t.missionId === m.id && t.id !== t1.id && t.id !== t2.id);
    expect(t3).toBeDefined();
    expect(t3!.objective).toBe('s3');
    finishRun(scheduler, orchestrator, 'completed');
    expect(missions.get(m.id)!.status).toBe('completed');
    expect(missions.get(m.id)!.steps[0].status).toBe('completed'); // checkpoint survived
  });
});