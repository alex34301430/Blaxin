import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MissionStore } from '../utils/missions.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blaxin-missions-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('missions: lifecycle', () => {
  it('creates a mission with pending steps', () => {
    const store = new MissionStore({ file: join(dir, 'm.json') });
    const m = store.create({ objective: 'Fix the build', steps: ['Run tests', 'Fix failures', 'Re-run tests'] });
    expect(m.status).toBe('queued');
    expect(m.progress).toBe(0);
    expect(m.steps).toHaveLength(3);
    expect(m.steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('creates a single auto step when no decomposition is given', () => {
    const store = new MissionStore({ file: join(dir, 'm.json') });
    const m = store.create({ objective: 'Do the thing' });
    expect(m.steps).toHaveLength(1);
    expect(m.steps[0].description).toBe('Do the thing');
  });

  it('startOrResume marks the first step running and advances', () => {
    const store = new MissionStore({ file: join(dir, 'm.json') });
    const m = store.create({ objective: 'o', steps: ['s1', 's2'] });
    const started = store.startOrResume(m.id)!;
    expect(started.step.description).toBe('s1');
    expect(store.get(m.id)!.status).toBe('running');
    expect(store.get(m.id)!.steps[0].status).toBe('running');
  });

  it('settles a step with a real checkpoint and never re-runs it', () => {
    const store = new MissionStore({ file: join(dir, 'm.json') });
    const m = store.create({ objective: 'o', steps: ['s1', 's2'] });
    const { step } = store.startOrResume(m.id)!;
    store.settleStep(m.id, step.id, { success: true, result: 'tests pass' });

    const after = store.get(m.id)!;
    expect(after.steps[0].status).toBe('completed');
    expect(after.steps[0].checkpoint?.summary).toBe('tests pass');
    expect(after.steps[0].checkpoint?.completedAt).toBeDefined();
    expect(after.progress).toBe(0.5);
    // next step becomes eligible
    const next = store.startOrResume(m.id)!;
    expect(next.step.description).toBe('s2');
    expect(after.steps[0].status).toBe('completed'); // untouched
  });

  it('completes the mission when every step is done', () => {
    const store = new MissionStore({ file: join(dir, 'm.json') });
    const m = store.create({ objective: 'o', steps: ['s1'] });
    const { step } = store.startOrResume(m.id)!;
    store.settleStep(m.id, step.id, { success: true, result: 'ok' });
    const done = store.get(m.id)!;
    expect(done.status).toBe('completed');
    expect(done.progress).toBe(1);
    expect(done.completedAt).toBeDefined();
    expect(store.startOrResume(m.id)).toBeNull();
  });

  it('marks failed steps and ends the mission failed with errors logged', () => {
    const store = new MissionStore({ file: join(dir, 'm.json') });
    const m = store.create({ objective: 'o', steps: ['s1'] });
    const { step } = store.startOrResume(m.id)!;
    store.settleStep(m.id, step.id, { success: false, error: 'boom' });
    const failed = store.get(m.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.steps[0].status).toBe('failed');
    expect(failed.errors.length).toBeGreaterThan(0);
  });

  it('retry resets only failed steps and requeues the mission', () => {
    const store = new MissionStore({ file: join(dir, 'm.json') });
    const m = store.create({ objective: 'o', steps: ['good', 'bad'] });
    const s1 = store.startOrResume(m.id)!;
    store.settleStep(m.id, s1.step.id, { success: true, result: 'ok' });
    const s2 = store.startOrResume(m.id)!;
    store.settleStep(m.id, s2.step.id, { success: false, error: 'boom' });

    expect(store.get(m.id)!.status).toBe('failed');
    expect(store.retry(m.id)).toBe(true);
    const retried = store.get(m.id)!;
    expect(retried.status).toBe('queued');
    expect(retried.steps[0].status).toBe('completed'); // untouched
    expect(retried.steps[1].status).toBe('pending');   // reset
  });

  it('pause blocks startOrResume; resume continues from the last checkpoint', () => {
    const store = new MissionStore({ file: join(dir, 'm.json') });
    const m = store.create({ objective: 'o', steps: ['s1', 's2', 's3'] });
    const s1 = store.startOrResume(m.id)!;
    store.settleStep(m.id, s1.step.id, { success: true, result: 'done' });
    store.pause(m.id);
    expect(store.get(m.id)!.status).toBe('paused');
    expect(store.startOrResume(m.id)).toBeNull();
    expect(store.resume(m.id)).toBe(true);
    const resumed = store.startOrResume(m.id)!;
    expect(resumed.step.description).toBe('s2'); // NOT s1 — checkpoint honored
  });

  it('cancel is terminal and cannot be resumed', () => {
    const store = new MissionStore({ file: join(dir, 'm.json') });
    const m = store.create({ objective: 'o', steps: ['s1'] });
    expect(store.cancel(m.id)).toBe(true);
    expect(store.get(m.id)!.status).toBe('cancelled');
    expect(store.resume(m.id)).toBe(false);
    expect(store.startOrResume(m.id)).toBeNull();
  });
});

describe('missions: persistence', () => {
  it('survives a restart with checkpoints intact', () => {
    const file = join(dir, 'm.json');
    const store1 = new MissionStore({ file });
    const m = store1.create({ objective: 'o', steps: ['s1', 's2'] });
    const { step } = store1.startOrResume(m.id)!;
    store1.settleStep(m.id, step.id, { success: true, result: 'checkpointed' });

    const store2 = new MissionStore({ file });
    const reloaded = store2.get(m.id)!;
    expect(reloaded.steps[0].status).toBe('completed');
    expect(reloaded.steps[0].checkpoint?.summary).toBe('checkpointed');
    expect(reloaded.progress).toBe(0.5);
  });

  it('re-pauses missions that were running when the process died', () => {
    const file = join(dir, 'm.json');
    const store1 = new MissionStore({ file });
    const m = store1.create({ objective: 'o', steps: ['s1'] });
    store1.startOrResume(m.id);

    const store2 = new MissionStore({ file });
    // a mid-flight mission must not claim to be running after restart
    expect(store2.get(m.id)!.status).toBe('paused');
  });
});