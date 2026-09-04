import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync, statSync } from 'fs';
import { rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TelemetryStore, toPersistedTask } from '../utils/telemetry-store.js';
import { telemetry, parseMetricsLimit, TaskMetrics } from '../utils/telemetry.js';

function makeTask(overrides: Partial<TaskMetrics> = {}): TaskMetrics {
  return {
    taskId: `task_${Math.random().toString(36).slice(2, 10)}`,
    kind: 'direct',
    message: 'take a screenshot',
    startedAt: Date.now(),
    queueWaitMs: 0,
    totalMs: 42,
    modelCalls: 0,
    modelMs: 0,
    toolCalls: 1,
    waves: 1,
    parallelWaves: 0,
    tools: [{ name: 'screenshot', ms: 40, attempts: 1, state: 'completed' }],
    result: 'completed',
    ...overrides,
  };
}

describe('telemetry persistence', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'blaxin-telemetry-'));
    file = join(dir, 'telemetry.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('survives a restart: records flushed to disk are reloaded', async () => {
    const a = new TelemetryStore({ filePath: file, flushMs: 1 });
    a.record(makeTask({ taskId: 't1', kind: 'direct', totalMs: 10 }));
    a.record(makeTask({ taskId: 't2', kind: 'llm', totalMs: 250 }));
    a.record(makeTask({ taskId: 't3', kind: 'llm', totalMs: 620 }));
    await a.flush();

    // New store instance over the same file == process restart.
    const b = new TelemetryStore({ filePath: file, flushMs: 1 });
    const loaded = b.latest(10);
    expect(loaded.map((t) => t.taskId)).toEqual(['t1', 't2', 't3']);
    expect(loaded[1].kind).toBe('llm');
    expect(loaded[2].totalMs).toBe(620);
  });

  it('persists the summary-relevant fields without user prompts or secrets', async () => {
    const a = new TelemetryStore({ filePath: file, flushMs: 1 });
    a.record(makeTask({
      taskId: 'secret-task',
      message: 'delete /home/user/.ssh/id_rsa with sk-or-abcdef1234567890',
      kind: 'llm',
      totalMs: 900,
      modelCalls: 2,
      modelMs: 500,
      tools: [{ name: 'filesystem', ms: 120, attempts: 1, state: 'completed' }],
    }));
    await a.flush();

    const raw = readFileSync(file, 'utf-8');
    expect(raw).not.toContain('sk-or-');
    expect(raw).not.toContain('delete /home');
    expect(raw).not.toContain('"message"');
    expect(raw).toContain('secret-task'); // taskId itself is safe metadata

    const persisted = JSON.parse(raw)[0];
    expect(persisted.message).toBeUndefined();
    expect(persisted.kind).toBe('llm');
    expect(persisted.modelMs).toBe(500);
    expect(persisted.tools[0].name).toBe('filesystem');
  });

  it('rejects unknown or junk fields on load (hostile/corrupt file)', async () => {
    writeFileSync(file, JSON.stringify([
      { taskId: 'ok', kind: 'llm', startedAt: 1, totalMs: 10, tools: [], result: 'completed', apiKey: 'sk-leak', message: 'prompt' },
      { junk: true },
      'not-an-object',
      42,
      { taskId: 7, kind: 'llm', startedAt: 1, totalMs: 10 },
    ]));
    const store = new TelemetryStore({ filePath: file, flushMs: 1 });
    const loaded = store.latest(10);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].taskId).toBe('ok');
    // allowlisted shape only — injected fields must not survive into memory
    const loadedAny = loaded[0] as unknown as Record<string, unknown>;
    expect(loadedAny.apiKey).toBeUndefined();
    expect(loadedAny.message).toBe(''); // prompts are never persisted
  });

  it('recovers gracefully from a malformed file, backing it up', async () => {
    writeFileSync(file, '{"not": "json" {{{');
    const store = new TelemetryStore({ filePath: file, flushMs: 1 });
    expect(store.latest(10)).toEqual([]); // no crash, clean ring

    // The corrupt file was preserved for inspection, not silently deleted.
    const files = readdirSync(dir);
    expect(files.some((f) => f.includes('.corrupt.'))).toBe(true);
    expect(existsSync(file)).toBe(false);

    // And the store keeps working afterwards.
    store.record(makeTask({ taskId: 'after-corruption' }));
    await store.flush();
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toHaveLength(1);
  });

  it('enforces the retention limit in memory and on disk', async () => {
    const store = new TelemetryStore({ filePath: file, maxRecords: 10, flushMs: 1 });
    for (let i = 0; i < 15; i++) {
      store.record(makeTask({ taskId: `t${i}`, startedAt: i }));
    }
    expect(store.latest(100)).toHaveLength(10);
    await store.flush();

    const persisted = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ taskId: string }>;
    expect(persisted).toHaveLength(10);
    expect(persisted[0].taskId).toBe('t5'); // oldest 5 dropped
    expect(persisted[9].taskId).toBe('t14'); // newest kept

    // Reload also respects the cap.
    const reloaded = new TelemetryStore({ filePath: file, maxRecords: 10, flushMs: 1 });
    expect(reloaded.latest(100)).toHaveLength(10);
  });

  it('handles rapid/concurrent recording without losing records', async () => {
    const store = new TelemetryStore({ filePath: file, maxRecords: 500, flushMs: 1 });
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        Promise.resolve().then(() => store.record(makeTask({ taskId: `burst-${i}`, startedAt: i }))),
      ),
    );
    await store.flush();

    const persisted = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ taskId: string }>;
    expect(persisted).toHaveLength(200);
    const ids = new Set(persisted.map((t) => t.taskId));
    expect(ids.size).toBe(200);

    const reloaded = new TelemetryStore({ filePath: file, maxRecords: 500, flushMs: 1 });
    expect(reloaded.latest(500)).toHaveLength(200);
  });

  it('never performs synchronous disk I/O on the recording path', async () => {
    const store = new TelemetryStore({ filePath: file, flushMs: 60_000 }); // long debounce
    store.record(makeTask({ taskId: 'hot-path' }));
    store.record(makeTask({ taskId: 'hot-path-2' }));
    // Recording alone must not have touched the disk yet.
    expect(existsSync(file)).toBe(false);
    // ...and only an explicit flush materializes the file.
    await store.flush();
    expect(existsSync(file)).toBe(true);
  });

  it('a persistence failure never breaks task execution', async () => {
    // Block the write by placing a regular FILE where the directory
    // should be — mkdir/write will fail, but record/flush must not throw.
    const blocker = join(dir, 'blocked');
    writeFileSync(blocker, 'i am a file');
    const store = new TelemetryStore({ filePath: join(blocker, 'telemetry.json'), flushMs: 1 });

    expect(() => store.record(makeTask({ taskId: 'still-works' }))).not.toThrow();
    // In-memory ring is unaffected by the doomed persistence attempt.
    expect(store.latest(10)).toHaveLength(1);

    let flushResolved = false;
    const p = store.flush().then(() => { flushResolved = true; });
    await p;
    expect(flushResolved).toBe(true); // flush resolves instead of rejecting
    expect(store.latest(10)).toHaveLength(1); // agent data still intact
  });

  it('toPersistedTask only ever emits allowlisted fields', () => {
    const out = toPersistedTask(makeTask({
      message: 'secret prompt content',
      taskId: 't',
      totalMs: 5,
    }));
    expect(out.message).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual([
      'kind', 'modelCalls', 'modelMs', 'parallelWaves', 'queueWaitMs',
      'result', 'startedAt', 'taskId', 'toolCalls', 'tools', 'totalMs', 'waves',
    ]);
  });
});

describe('metrics query parsing', () => {
  it('clamps ?n= to a bounded window', () => {
    expect(parseMetricsLimit(undefined)).toBe(50);
    expect(parseMetricsLimit('100')).toBe(100);
    expect(parseMetricsLimit('10000')).toBe(200); // hard cap
    expect(parseMetricsLimit('0')).toBe(1);
    expect(parseMetricsLimit('-5')).toBe(1);
    expect(parseMetricsLimit('abc')).toBe(50);
    expect(parseMetricsLimit(null)).toBe(50);
  });
});

describe('telemetry singleton summary', () => {
  beforeEach(() => {
    telemetry.reset();
  });

  it('exposes by-kind latency breakdown and totals', () => {
    telemetry.record(makeTask({ taskId: 'd1', kind: 'direct', totalMs: 30, modelMs: 0, tools: [{ name: 'screenshot', ms: 28, attempts: 1, state: 'completed' }] }));
    telemetry.record(makeTask({ taskId: 'l1', kind: 'llm', totalMs: 250, modelMs: 250, modelCalls: 1, toolCalls: 0, tools: [] }));
    telemetry.record(makeTask({ taskId: 'l2', kind: 'llm', totalMs: 620, modelMs: 500, modelCalls: 2, toolCalls: 3, waves: 2, parallelWaves: 1, tools: [] }));

    const s = telemetry.summary(10);
    expect(s.samples).toBe(3);
    expect((s.byKind as any).direct.count).toBe(1);
    expect((s.byKind as any).direct.medianMs).toBe(30);
    expect((s.byKind as any).llm.count).toBe(2);
    expect((s.byKind as any).llm.medianMs).toBe(435);
    expect(s.modelCalls).toBe(3);
    expect(s.totalModelMs).toBe(750);
    expect(s.totalToolMs).toBe(28);
    expect((s.totalMs as any).min).toBe(30);
    expect((s.totalMs as any).max).toBe(620);
  });

  it('slowest() returns the top tasks by duration', () => {
    for (let i = 1; i <= 10; i++) {
      telemetry.record(makeTask({ taskId: `t${i}`, totalMs: i * 100 }));
    }
    const slow = telemetry.slowest(3);
    expect(slow.map((t) => t.taskId)).toEqual(['t10', 't9', 't8']);
  });

  it('empty summary is well-formed', () => {
    const s = telemetry.summary(10);
    expect(s).toEqual({ samples: 0 });
  });
});