import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskQueue } from '../utils/task-queue.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blaxin-queue-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('task queue: core semantics', () => {
  it('enqueues tasks as queued with defaults', () => {
    const q = new TaskQueue({ file: join(dir, 'q.json') });
    const task = q.enqueue({ objective: 'list /tmp' });
    expect(task.status).toBe('queued');
    expect(task.priority).toBe(3);
    expect(q.list()).toHaveLength(1);
  });

  it('rejects empty objectives', () => {
    const q = new TaskQueue({ file: join(dir, 'q.json') });
    expect(() => q.enqueue({ objective: '  ' })).toThrow();
  });

  it('picks highest priority first, FIFO within a priority', () => {
    const q = new TaskQueue({ file: join(dir, 'q.json') });
    const low = q.enqueue({ objective: 'low', priority: 1 });
    const high = q.enqueue({ objective: 'high', priority: 5 });
    const mid = q.enqueue({ objective: 'mid', priority: 3 });
    expect(q.nextEligible()?.id).toBe(high.id);
    q.markCompleted(high.id);
    expect(q.nextEligible()?.id).toBe(mid.id);
    q.markCompleted(mid.id);
    expect(q.nextEligible()?.id).toBe(low.id);
  });

  it('respects dependencies: a task waits for its dependsOn to finish', () => {
    const q = new TaskQueue({ file: join(dir, 'q.json') });
    const a = q.enqueue({ objective: 'a', priority: 5 });
    const b = q.enqueue({ objective: 'b', priority: 5, dependsOn: [a.id] });
    // a runs first despite equal priority (FIFO) — but b must not run
    // before a reaches a terminal state even if a is paused.
    q.pause(a.id);
    expect(q.nextEligible()).toBeNull();
    q.resume(a.id);
    expect(q.nextEligible()?.id).toBe(a.id);
    q.markFailed(a.id); // terminal — dependency satisfied
    expect(q.nextEligible()?.id).toBe(b.id);
  });

  it('pause/resume/cancel lifecycle', () => {
    const q = new TaskQueue({ file: join(dir, 'q.json') });
    const t = q.enqueue({ objective: 'x' });
    expect(q.pause(t.id)).toBe(true);
    expect(q.get(t.id)?.status).toBe('paused');
    expect(q.nextEligible()).toBeNull();
    expect(q.resume(t.id)).toBe(true);
    expect(q.nextEligible()?.id).toBe(t.id);
    expect(q.cancel(t.id)).toBe(true);
    expect(q.get(t.id)?.status).toBe('cancelled');
    expect(q.nextEligible()).toBeNull();
    // terminal tasks cannot be paused/cancelled again
    expect(q.pause(t.id)).toBe(false);
    expect(q.cancel(t.id)).toBe(false);
  });

  it('markRunning/completed/failed set honest state and timestamps', () => {
    const q = new TaskQueue({ file: join(dir, 'q.json') });
    const t = q.enqueue({ objective: 'run' });
    q.markRunning(t.id);
    expect(q.get(t.id)?.startedAt).toBeDefined();
    q.markCompleted(t.id, 'done');
    const done = q.get(t.id)!;
    expect(done.status).toBe('completed');
    expect(done.result).toBe('done');
    expect(done.endedAt).toBeDefined();
  });

  it('notifies the change listener on every mutation', () => {
    const q = new TaskQueue({ file: join(dir, 'q.json') });
    let seen = 0;
    q.onChange((tasks) => { seen = tasks.length; });
    q.enqueue({ objective: 'a' });
    expect(seen).toBe(1);
    q.enqueue({ objective: 'b' });
    expect(seen).toBe(2);
    q.clear();
    expect(seen).toBe(0);
  });

  it('remove drops only existing tasks', () => {
    const q = new TaskQueue({ file: join(dir, 'q.json') });
    const t = q.enqueue({ objective: 'a' });
    expect(q.remove(t.id)).toBe(true);
    expect(q.remove('nope')).toBe(false);
    expect(q.list()).toHaveLength(0);
  });
});

describe('task queue: persistence', () => {
  it('survives a restart and requeues in-flight tasks honestly', () => {
    const file = join(dir, 'q.json');
    const q1 = new TaskQueue({ file });
    const queued = q1.enqueue({ objective: 'queued task' });
    const running = q1.enqueue({ objective: 'running task' });
    q1.markRunning(running.id);
    const completed = q1.enqueue({ objective: 'done task' });
    q1.markCompleted(completed.id, 'ok');

    const q2 = new TaskQueue({ file });
    expect(q2.list()).toHaveLength(3);
    expect(q2.get(queued.id)?.status).toBe('queued');
    // a task that was running when the process died is requeued, not
    // reported as running forever
    expect(q2.get(running.id)?.status).toBe('queued');
    expect(q2.get(completed.id)?.status).toBe('completed');
    expect(q2.get(completed.id)?.result).toBe('ok');
    expect(existsSync(file)).toBe(true);
  });
});