import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { AddressInfo } from 'net';
import type { Server } from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'blaxin-api-'));
process.env.BLAXIN_DATA_DIR = TEST_DIR;
process.env.BLAXIN_PORT = '30399';

const { createInfrastructureRouter } = await import('../../../src/api/infrastructure.js');
import type { ModelRuntime, RuntimeStatus } from '../../../src/models/runtime.js';
import type { CloudProvider, CloudResourceShape, CloudInstance, CloudQuotaSummary, CloudResourceInventory, CloudCredentialsStatus, LaunchInstanceRequest } from '../../../src/cloud/cloud-provider.js';

// ── Fakes (full contract implementations) ───────────────────────

let endpointOverride: string | null = null;
let activatedModel: string | null = null;
let validateOk = true;
let savedCreds: unknown = null;
let clearCalled = 0;
let fakeDeployments: Array<Record<string, unknown>> = [{ id: 'dep-1', state: 'READY', detail: 'ok', modelId: 'qwen2.5:7b-instruct-q4_K_M' }];

class FakeRuntime {
  readonly id = 'ollama';
  readonly name = 'Ollama';
  async status(): Promise<RuntimeStatus> { return { state: 'running', endpoint: 'http://127.0.0.1:11434', models: [{ id: 'qwen2.5:0.5b', sizeBytes: 4, parameters: 500_000_000, quantization: 'Q4_K_M', modifiedAt: null }] }; }
  async install() { return { ok: true }; }
  async start() { return { ok: true }; }
  async stop() { return { ok: true }; }
  async restart() { return { ok: true }; }
  async pullModel(modelId: string, onProgress?: (p: { total: number | null; done: number | null; percent: number | null }) => void) {
    onProgress?.({ total: 100, done: 50, percent: 50 });
    return { ok: true };
  }
  async logs() { return 'log line one\nlog line two'; }
}

class FakeCloud implements CloudProvider {
  readonly id = 'oci';
  readonly name = 'Oracle Cloud';
  credentialsStatus(): CloudCredentialsStatus { return { configured: true, missing: [] }; }
  async clearCredentials(): Promise<void> { clearCalled++; }
  async validateCredentials(): Promise<{ tenancyName: string | null; region: string | null; user: string | null }> {
    if (!validateOk) throw new Error('OCI authentication failed: check the tenancy OCID, user OCID, fingerprint, key and region (401)');
    return { tenancyName: 'RealTenancy', region: 'us-ashburn-1', user: 'ocid1.user.oc1..x' };
  }
  async discoverTopology() { return { region: 'us-ashburn-1', regions: ['us-ashburn-1'], compartments: [{ id: 'c1', name: 'root', isDefault: true }], availabilityDomains: [{ name: 'AD-1', compartmentId: 'c1' }] }; }
  async discoverShapes(compartmentId: string): Promise<CloudResourceShape[]> { return [{ id: 'VM.Standard.A1.Flex', architecture: 'aarch64', ocpus: 4, memoryBytes: 24 * 1024 ** 3, gpus: 0, vramBytesPerGpu: null, limitKnown: true, availableCount: 8, storageBytes: null }]; }
  async listInstances() { return []; }
  async getInstance() { return null; }
  async launchInstance(req: LaunchInstanceRequest): Promise<CloudInstance> { return { id: 'i1', name: req.displayName, shapeId: req.shapeId, state: 'running', publicIp: null, architecture: 'aarch64', ocpus: 4, memoryBytes: 24 * 1024 ** 3, gpus: 0, compartmentId: req.compartmentId, ad: req.availabilityDomain }; }
  async terminateInstance() { /* noop */ }
  async discoverQuota(): Promise<CloudQuotaSummary[]> { return [{ service: 'compute', scope: 'AD-1', limit: 8, used: 2, available: 6 }]; }
  inventoryForShape(shape: CloudResourceShape): CloudResourceInventory {
    return {
      schemaVersion: 1, scope: 'cloud', provider: 'oci', region: 'us-ashburn-1', instanceId: null, shapeId: shape.id,
      os: { platform: 'linux', release: 'x', family: 'linux' }, architecture: shape.architecture,
      cpu: { cores: 8, physicalCores: 4, model: shape.id, clockMhz: null, flags: { avx2: false, avx512: false, neon: true } },
      memoryBytes: shape.memoryBytes ?? 0, gpus: [], storage: { freeBytes: null, totalBytes: null }, detectedAt: Date.now(),
    };
  }
}

const fakeEngine = {
  list: () => fakeDeployments,
  get: (id: string) => fakeDeployments.find((d) => d.id === id) ?? null,
  start: (input: Record<string, unknown>) => ({ id: 'dep-2', ...input, state: 'DISCOVERING', detail: 'queued' }),
  cancel: (id: string) => (id === 'dep-1' ? { ok: false, error: 'Deployment is already READY' } : { ok: true }),
};

// ── Real HTTP server over the router ────────────────────────────

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', createInfrastructureRouter({
    runtime: new FakeRuntime() as unknown as import('../../../src/models/ollama-runtime.js').OllamaRuntime,
    cloud: new FakeCloud(),
    deployments: fakeEngine as never,
    tunnel: { host: '203.0.113.10', port: 22, localPort: 12345 },
    setOllamaEndpoint: (e: string) => {
      if (!/^(http:\/\/)?127\.0\.0\.1:\d+$/.test(e)) return false;
      endpointOverride = e;
      return true;
    },
    activateOllamaModel: (m?: string) => { activatedModel = m ?? null; },
    saveCredentials: (cred: unknown) => { savedCreds = cred; },
    clearCredentials: () => { clearCalled++; },
    credentialSummary: () => ({ configured: true, region: 'us-ashburn-1', tenancyMasked: 'ocid1.tenancy…mple' }),
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

async function req(path: string, init?: RequestInit) {
  const res = await fetch(`${base}/api${path}`, init);
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
}

describe('infrastructure REST API', () => {
  it('GET /api/resources detects the real local machine', async () => {
    const { status, body } = await req('/resources');
    expect(status).toBe(200);
    const inv = (body as any).inventory;
    expect(inv.scope).toBe('local');
    expect(inv.memoryBytes).toBeGreaterThan(0);
    expect(typeof inv.cpu.cores).toBe('number');
  });

  it('GET /api/catalog returns the maintainable catalog', async () => {
    const { status, body } = await req('/catalog');
    expect(status).toBe(200);
    expect((body as any).count).toBeGreaterThan(0);
    expect((body as any).models[0]).toMatchObject({ id: expect.any(String), license: expect.any(String) });
  });

  it('POST /api/recommend returns best + alternatives for the real machine', async () => {
    const { status, body } = await req('/recommend', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    expect(status).toBe(200);
    expect((body as any).best).not.toBeNull();
    expect(Array.isArray((body as any).alternatives)).toBe(true);
    expect((body as any).alternatives.length).toBeGreaterThan(0);
  });

  it('POST /api/recommend supports cloud scope through the provider contract', async () => {
    const { status, body } = await req('/recommend', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'cloud', compartmentId: 'c1', shapeId: 'VM.Standard.A1.Flex' }),
    });
    expect(status).toBe(200);
    expect((body as any).inventory.scope).toBe('cloud');
    expect((body as any).best).not.toBeNull();
  });

  it('GET /api/runtime/status reports truthful engine state + pull progress', async () => {
    const { status, body } = await req('/runtime/status');
    expect(status).toBe(200);
    expect((body as any).status.state).toBe('running');
    expect((body as any).status.models[0].parameters).toBe(500_000_000);
  });

  it('POST /api/runtime/pull accepts a model and reports progress', async () => {
    const pull = await req('/runtime/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: 'qwen2.5:7b-instruct-q4_K_M' }) });
    expect(pull.status).toBe(200);
    expect((pull.body as any).pulling).toBe(true);
    // Wait for the fake pull to finish, then the status no longer lists it.
    await new Promise((r) => setTimeout(r, 20));
    const status = await req('/runtime/status');
    expect((status.body as any).pulling).toEqual([]);
  });

  it('POST /api/providers/ollama/endpoint only accepts loopback endpoints', async () => {
    const bad = await req('/providers/ollama/endpoint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'http://evil.example.com:11434' }) });
    expect(bad.status).toBe(400);
    const good = await req('/providers/ollama/endpoint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'http://127.0.0.1:12345', model: 'qwen2.5:7b' }) });
    expect(good.status).toBe(200);
    expect(endpointOverride).toBe('http://127.0.0.1:12345');
    expect(activatedModel).toBe('qwen2.5:7b');
  });

  it('GET /api/cloud/status returns masked summaries and tunnel guidance, never secrets', async () => {
    const { status, body } = await req('/cloud/status');
    expect(status).toBe(200);
    expect((body as any).provider.name).toBe('Oracle Cloud');
    expect((body as any).credentials.tenancyMasked).not.toContain('ocid1.tenancy.oc1');
    expect((body as any).tunnel.host).toBe('203.0.113.10');
  });

  it('POST /api/cloud/oci/connect validates live then stores; failures wipe the store', async () => {
    validateOk = true;
    const good = await req('/cloud/oci/connect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenancy: 'ocid1.tenancy.oc1..aaaaaaaaexample', user: 'ocid1.user.oc1..aaaaaaaaexample', fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99', privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----', region: 'us-ashburn-1' }),
    });
    expect(good.status).toBe(200);
    expect(savedCreds).not.toBeNull();

    // live validation fails → credentials must not be kept
    validateOk = false;
    const bad = await req('/cloud/oci/connect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenancy: 'ocid1.tenancy.oc1..aaaaaaaaexample', user: 'ocid1.user.oc1..aaaaaaaaexample', fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99', privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----', region: 'us-ashburn-1' }),
    });
    expect(bad.status).toBe(400);
    expect(clearCalled).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/cloud/oci/connect rejects structurally invalid input before any save', async () => {
    validateOk = true;
    const savedBefore = savedCreds;
    const res = await req('/cloud/oci/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenancy: 'nope' }) });
    expect(res.status).toBe(400);
    expect(savedCreds).toBe(savedBefore);
  });

  it('DELETE /api/cloud/oci disconnects', async () => {
    const { status } = await req('/cloud/oci', { method: 'DELETE' });
    expect(status).toBe(200);
    expect(clearCalled).toBeGreaterThanOrEqual(2);
  });

  it('exposes topology / shapes / quota through the provider contract', async () => {
    const topology = await req('/cloud/topology');
    expect(topology.status).toBe(200);
    expect((topology.body as any).regions).toContain('us-ashburn-1');
    const shapes = await req('/cloud/shapes?compartmentId=c1');
    expect((shapes.body as any).shapes[0].id).toBe('VM.Standard.A1.Flex');
    const quota = await req('/cloud/quota?compartmentId=c1');
    expect((quota.body as any).quotas[0].available).toBe(6);
    const missing = await req('/cloud/shapes');
    expect(missing.status).toBe(400);
  });

  it('GET /api/cloud/tunnel returns only the PUBLIC key', async () => {
    const { status, body } = await req('/cloud/tunnel');
    expect(status).toBe(200);
    const key = (body as any).publicKey as string;
    expect(key.startsWith('ssh-ed25519 ')).toBe(true);
    // the private key must never surface
    expect(key).not.toContain('PRIVATE KEY');
  });

  it('lists deployments and refuses to cancel terminal ones', async () => {
    const list = await req('/cloud/deployments');
    expect((list.body as any).deployments[0].id).toBe('dep-1');
    const cancel = await req('/cloud/deployments/dep-1/cancel', { method: 'POST' });
    expect(cancel.status).toBe(409);
  });

  it('POST /api/cloud/deploy validates the model against the catalog', async () => {
    const ok = await req('/cloud/deploy', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shapeId: 'VM.Standard.A1.Flex', compartmentId: 'c1', availabilityDomain: 'AD-1', modelId: 'qwen2.5:7b-instruct-q4_K_M', runtimeId: 'ollama' }),
    });
    expect(ok.status).toBe(200);
    expect((ok.body as any).deployment.id).toBe('dep-2');
    const unknown = await req('/cloud/deploy', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shapeId: 'VM.Standard.A1.Flex', compartmentId: 'c1', availabilityDomain: 'AD-1', modelId: 'not-a-real-model', runtimeId: 'ollama' }),
    });
    expect(unknown.status).toBe(400);
  });
});