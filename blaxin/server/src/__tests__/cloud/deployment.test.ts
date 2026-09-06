import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'blaxin-deploy-'));
process.env.BLAXIN_DATA_DIR = TEST_DIR;

const { DeploymentEngine, resetDeploymentsForTests } = await import('../../../src/cloud/deployment.js');
import type { DeploymentEngine as DeploymentEngineClass } from '../../../src/cloud/deployment.js';
import type {
  CloudProvider, CloudResourceShape, CloudInstance, CloudQuotaSummary,
  CloudResourceInventory, CloudCredentialsStatus, LaunchInstanceRequest,
} from '../../../src/cloud/cloud-provider.js';

// ── A REAL in-process stand-in for the tunneled model endpoint ──

let tunnelServer: Server;
let tunnelPort = 0;
let generateHits = 0;
let endpointPostHits = 0;

beforeAll(async () => {
  tunnelServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/providers/ollama/endpoint') {
      endpointPostHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname === '/api/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ version: '0.6.0' }));
    }
    if (url.pathname === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b-instruct-q4_K_M' }] }));
    }
    if (url.pathname === '/api/generate') {
      generateHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ response: 'OK', done: true }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => tunnelServer.listen(0, '127.0.0.1', () => resolve()));
  const address = tunnelServer.address();
  if (address && typeof address === 'object') tunnelPort = address.port;
  process.env.BLAXIN_PORT = String(tunnelPort);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => tunnelServer.close((e) => (e ? reject(e) : resolve())));
});

// ── Controllable fake CloudProvider ─────────────────────────────

class FakeProvider implements CloudProvider {
  readonly id = 'fake';
  readonly name = 'Fake Cloud';
  launchCount = 0;
  terminateCalls: string[] = [];
  failValidation = false;
  instances = new Map<string, CloudInstance>();
  /** Polls before an instance flips to running (shared across engines). */
  pollsUntilRunning = 2;
  private polls = 0;

  credentialsStatus(): CloudCredentialsStatus { return { configured: true, missing: [] }; }
  async clearCredentials(): Promise<void> { /* noop */ }
  async validateCredentials(): Promise<{ tenancyName: string | null; region: string | null; user: string | null }> {
    if (this.failValidation) throw new Error('Fake auth failed');
    return { tenancyName: 'FakeTenancy', region: 'us-fake-1', user: 'fake-user' };
  }
  async discoverTopology(): Promise<any> { return { region: 'us-fake-1', regions: ['us-fake-1'], compartments: [], availabilityDomains: [] }; }
  async discoverShapes(compartmentId: string): Promise<CloudResourceShape[]> {
    return [{ id: 'Fake.Standard.A1', architecture: 'aarch64', ocpus: 4, memoryBytes: 24 * 1024 * 1024 * 1024, gpus: 0, vramBytesPerGpu: null, limitKnown: true, availableCount: 10, storageBytes: null }];
  }
  async listInstances(compartmentId: string): Promise<CloudInstance[]> { return [...this.instances.values()]; }
  async getInstance(instanceId: string): Promise<CloudInstance | null> {
    const inst = this.instances.get(instanceId);
    if (!inst) return null;
    if (inst.state === 'provisioning' && ++this.polls >= this.pollsUntilRunning) {
      const running = { ...inst, state: 'running' as const };
      this.instances.set(instanceId, running);
      return running;
    }
    return inst;
  }
  async launchInstance(req: LaunchInstanceRequest): Promise<CloudInstance> {
    // idempotent by token: same display name ⇒ same instance
    for (const inst of this.instances.values()) {
      if (inst.name === req.displayName && inst.state !== 'terminated') return inst;
    }
    this.launchCount++;
    const inst: CloudInstance = {
      id: `ocid1.instance.${this.launchCount}`,
      name: req.displayName,
      shapeId: req.shapeId,
      state: 'provisioning',
      publicIp: null,
      architecture: 'aarch64',
      ocpus: 4,
      memoryBytes: 24 * 1024 * 1024 * 1024,
      gpus: 0,
      compartmentId: req.compartmentId,
      ad: req.availabilityDomain,
    };
    this.instances.set(inst.id, inst);
    return inst;
  }
  async terminateInstance(instanceId: string): Promise<void> { this.terminateCalls.push(instanceId); }
  async discoverQuota(compartmentId: string): Promise<CloudQuotaSummary[]> { return []; }
  inventoryForShape(shape: CloudResourceShape, compartmentId: string): CloudResourceInventory {
    return {
      schemaVersion: 1, scope: 'cloud', provider: 'fake', region: 'us-fake-1', instanceId: null, shapeId: shape.id,
      os: { platform: 'linux', release: 'x', family: 'linux' }, architecture: shape.architecture,
      cpu: { cores: 8, physicalCores: 4, model: shape.id, clockMhz: null, flags: { avx2: false, avx512: false, neon: true } },
      memoryBytes: shape.memoryBytes ?? 0, gpus: [], storage: { freeBytes: null, totalBytes: null }, detectedAt: Date.now(),
    };
  }
}

function makeEngine(provider: FakeProvider, brainSshHost = 'tunnel.example.com') {
  return new DeploymentEngine({
    provider,
    brainSshHost,
    brainSshPort: 22,
    tunnelPort,
    resolveImageId: async (arch) => `ocid1.image.${arch}`,
    pollMs: 5,
    pollTimeoutMs: 15_000,
  });
}

type DeploymentRecord = NonNullable<ReturnType<typeof DeploymentEngine.prototype.get>>;

async function awaitTerminal(engine: DeploymentEngineClass, id: string, timeoutMs = 20_000): Promise<DeploymentRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = engine.get(id);
    if (rec && ['READY', 'FAILED', 'CANCELLED'].includes(rec.state)) return rec;
    if (Date.now() > deadline) throw new Error('Deployment did not reach a terminal state in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const INPUT = {
  shapeId: 'Fake.Standard.A1',
  compartmentId: 'ocid1.compartment.oc1..x',
  availabilityDomain: 'Uoc:FAKE-AD-1',
  modelId: 'qwen2.5:7b-instruct-q4_K_M',
  runtimeId: 'ollama',
};

describe('deployment state machine', () => {
  beforeEach(() => {
    resetDeploymentsForTests();
    generateHits = 0;
    endpointPostHits = 0;
  });

  it('reaches READY only after a real health check + inference + Brain registration', async () => {
    const provider = new FakeProvider();
    provider.pollsUntilRunning = 1;
    const engine = makeEngine(provider);
    const rec = engine.start(INPUT);
    const terminal = await awaitTerminal(engine, rec.id);

    expect(terminal.state).toBe('READY');
    expect(terminal.endpoint).toBe(`http://127.0.0.1:${tunnelPort}`);
    expect(generateHits).toBeGreaterThanOrEqual(1); // real inference round trip
    expect(endpointPostHits).toBeGreaterThanOrEqual(1); // real Brain registration call
    expect(provider.launchCount).toBe(1);
  });

  it('persists every transition and resumes from the last durable step (no duplicate launch)', async () => {
    const provider = new FakeProvider();
    provider.pollsUntilRunning = 3;
    const engineA = makeEngine(provider);
    const rec = engineA.start(INPUT);

    // While A is still provisioning, a second engine (simulating a crash
    // restart) takes over the same persisted record.
    await new Promise((r) => setTimeout(r, 30));
    const engineB = makeEngine(provider);
    const resumed = engineB.resumeAll();
    expect(resumed.length).toBe(1);

    const terminalA = await awaitTerminal(engineA, rec.id);
    const terminalB = await awaitTerminal(engineB, rec.id);
    expect(terminalA.state).toBe('READY');
    expect(terminalB.state).toBe('READY');
    // the shared provider saw the instance launched exactly once
    expect(provider.launchCount).toBe(1);
  });

  it('cancels honestly and terminates the instance it created', async () => {
    const provider = new FakeProvider();
    provider.pollsUntilRunning = 100; // stay provisioning
    const engine = makeEngine(provider);
    const rec = engine.start(INPUT);
    // Wait until the instance has actually been launched (so the
    // cancellation path has something real to tear down).
    const deadline = Date.now() + 5_000;
    while (provider.launchCount < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(provider.launchCount).toBe(1);
    const cancel = engine.cancel(rec.id);
    expect(cancel.ok).toBe(true);
    const terminal = await awaitTerminal(engine, rec.id);
    expect(terminal.state).toBe('CANCELLED');
    expect(provider.terminateCalls.length).toBeGreaterThanOrEqual(1);
    // cancelling an already-terminal deployment is a clean refusal
    expect(engine.cancel(rec.id).ok).toBe(false);
  });

  it('records explicit FAILED states with the real error', async () => {
    const provider = new FakeProvider();
    provider.failValidation = true;
    const engine = makeEngine(provider);
    const rec = engine.start(INPUT);
    const terminal = await awaitTerminal(engine, rec.id, 10_000);
    expect(terminal.state).toBe('FAILED');
    expect(terminal.error).toMatch(/Fake auth failed/);
    expect(provider.launchCount).toBe(0); // nothing was launched
  });

  it('fails fast and honestly when the reverse tunnel target is not configured', async () => {
    const provider = new FakeProvider();
    const engine = makeEngine(provider, ''); // no BLAXIN_TUNNEL_HOST
    const rec = engine.start(INPUT);
    const terminal = await awaitTerminal(engine, rec.id, 10_000);
    expect(terminal.state).toBe('FAILED');
    expect(terminal.error).toMatch(/BLAXIN_TUNNEL_HOST/);
    expect(provider.launchCount).toBe(0);
  });

  it('does not resume terminal deployments', () => {
    const provider = new FakeProvider();
    const engine = makeEngine(provider);
    const rec = engine.start(INPUT);
    void rec;
    // new engine over the same store: nothing to resume once READY
    const engine2 = makeEngine(provider);
    return new Promise<void>((resolve) => {
      const tryResume = () => {
        const all = engine2.list();
        if (all.every((r) => ['READY', 'FAILED', 'CANCELLED'].includes(r.state))) {
          expect(engine2.resumeAll().length).toBe(0);
          resolve();
        } else {
          setTimeout(tryResume, 10);
        }
      };
      tryResume();
    });
  });
});