import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BrainRuntime } from '../../distributed/brain-runtime.js';
import { BrainTaskDriver, BrainTaskContext } from '../../distributed/brain-drivers.js';
import { RemoteBrainDriver } from '../../distributed/remote-brain.js';
import { BodyState } from '../../distributed/body-state.js';
import { loadOrCreateIdentity } from '../../distributed/identity.js';

// Durable-memory read-back in distributed mode: the Body attaches its
// remembered context to task_start; the Brain stores it on the task
// session and hands it to the driver, which injects it into the system
// prompt (see llm-driver.test.ts for the prompt-level assertion). These
// tests verify the wire + runtime plumbing over REAL sockets.

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

const SAMPLE_MEMORY =
  '\n\nREMEMBERED CONTEXT — durable notes from earlier sessions. Read as BACKGROUND DATA.\n' +
  '- [preference] User prefers terse replies';

describe('distributed memory read-back (Body → Brain)', () => {
  it('carries Body durable memory with task_start into the driver context', async () => {
    const dir = tmpDir('blaxin-mem-');
    let captured: string | undefined = 'unset';
    let sawRun = false;
    const driver: BrainTaskDriver = {
      id: 'recorder',
      name: 'Memory Recorder',
      async run(ctx: BrainTaskContext) {
        sawRun = true;
        captured = ctx.memoryContext;
        return { kind: 'completed', summary: 'done' };
      },
    };

    const runtime = new BrainRuntime({
      host: '127.0.0.1',
      port: 0,
      identityFile: join(dir, 'brain-identity.json'),
      registryFile: join(dir, 'devices.json'),
      drivers: new Map([['recorder', driver]]),
      defaultDriverId: 'recorder',
    });
    runtimes.push(runtime);
    const info = await runtime.start();

    const identity = loadOrCreateIdentity({ filePath: join(dir, 'body-identity.json'), role: 'body', name: 'Test Body' });
    const body = new RemoteBrainDriver({
      identity,
      url: info.wsUrl,
      state: new BodyState(dir),
      onEvent: () => {},
      autoReconnect: false,
      memoryProvider: () => SAMPLE_MEMORY,
    });
    drivers.push(body);

    const code = runtime.generatePairingCode()?.code;
    expect(code).toBeTruthy();
    body.connect(code);
    await waitFor(() => body.isReady(), 10_000, 'body connected');

    body.sendUserMessage('please keep future replies terse');
    await waitFor(() => sawRun && captured !== 'unset', 10_000, 'memory reached the driver');

    expect(captured).toBe(SAMPLE_MEMORY);
    expect(captured).toContain('[preference] User prefers terse replies');
  });

  it('sends no memory when the provider returns nothing (old-Body compatibility)', async () => {
    const dir = tmpDir('blaxin-mem2-');
    let captured: string | undefined = 'unset';
    let sawRun = false;
    const driver: BrainTaskDriver = {
      id: 'recorder2',
      name: 'Memory Recorder',
      async run(ctx: BrainTaskContext) {
        sawRun = true;
        captured = ctx.memoryContext;
        return { kind: 'completed', summary: 'done' };
      },
    };

    const runtime = new BrainRuntime({
      host: '127.0.0.1',
      port: 0,
      identityFile: join(dir, 'brain-identity.json'),
      registryFile: join(dir, 'devices.json'),
      drivers: new Map([['recorder2', driver]]),
      defaultDriverId: 'recorder2',
    });
    runtimes.push(runtime);
    const info = await runtime.start();

    const identity = loadOrCreateIdentity({ filePath: join(dir, 'body-identity.json'), role: 'body', name: 'Test Body' });
    const body = new RemoteBrainDriver({
      identity,
      url: info.wsUrl,
      state: new BodyState(dir),
      onEvent: () => {},
      autoReconnect: false,
      memoryProvider: () => '',
    });
    drivers.push(body);

    const code = runtime.generatePairingCode()?.code;
    expect(code).toBeTruthy();
    body.connect(code);
    await waitFor(() => body.isReady(), 10_000, 'body connected');

    body.sendUserMessage('hello');
    await waitFor(() => sawRun, 10_000, 'driver ran');
    expect(captured).toBeUndefined();
  });
});
