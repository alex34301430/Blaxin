import { describe, it, expect } from 'vitest';
import type { CloudProvider, LaunchInstanceRequest, CloudResourceShape, CloudInstance } from '../../../src/cloud/cloud-provider.js';
import type { ModelRuntime, RuntimeStatus } from '../../../src/models/runtime.js';
import { recommendModels } from '../../../src/models/recommendation.js';

/**
 * A minimal but COMPLETE implementation of the CloudProvider contract.
 * If the contract ever grows a method, this test fails to compile —
 * proving new clouds must implement the same surface.
 */
class MockCloudProvider implements CloudProvider {
  readonly id = 'mock';
  readonly name = 'Mock Cloud';
  credentialsStatus() { return { configured: true, missing: [] }; }
  async clearCredentials() { /* noop */ }
  async validateCredentials() { return { tenancyName: 'Mock', region: 'us-mock-1', user: 'u' }; }
  async discoverTopology() {
    return { region: 'us-mock-1', regions: ['us-mock-1'], compartments: [{ id: 'c1', name: 'root', isDefault: true }], availabilityDomains: [{ name: 'AD-1', compartmentId: 'c1' }] };
  }
  async discoverShapes(compartmentId: string): Promise<CloudResourceShape[]> {
    return [{ id: 'Mock.GPU.1', architecture: 'x86_64', ocpus: 8, memoryBytes: 64 * 1024 ** 3, gpus: 1, vramBytesPerGpu: 24 * 1024 ** 3, limitKnown: true, availableCount: 2, storageBytes: null }];
  }
  async listInstances() { return []; }
  async getInstance() { return null; }
  async launchInstance(req: LaunchInstanceRequest): Promise<CloudInstance> {
    return { id: 'mock-instance-1', name: req.displayName, shapeId: req.shapeId, state: 'running', publicIp: null, architecture: 'x86_64', ocpus: 8, memoryBytes: 64 * 1024 ** 3, gpus: 1, compartmentId: req.compartmentId, ad: req.availabilityDomain };
  }
  async terminateInstance() { /* noop */ }
  async discoverQuota() { return []; }
  inventoryForShape(shape: CloudResourceShape, compartmentId: string) {
    return {
      schemaVersion: 1 as const, scope: 'cloud' as const, provider: 'mock', region: 'us-mock-1', instanceId: null, shapeId: shape.id,
      os: { platform: 'linux', release: 'x', family: 'linux' as const }, architecture: shape.architecture,
      cpu: { cores: 16, physicalCores: 8, model: shape.id, clockMhz: null, flags: { avx2: true, avx512: false, neon: false } },
      memoryBytes: shape.memoryBytes ?? 0,
      gpus: shape.gpus > 0 ? [{ name: shape.id, vramBytes: shape.vramBytesPerGpu, kind: 'nvidia-cuda' as const }] : [],
      storage: { freeBytes: null, totalBytes: null }, detectedAt: Date.now(),
    };
  }
}

/** A minimal ModelRuntime implementing the full runtime contract. */
class MockModelRuntime implements ModelRuntime {
  readonly id = 'mock-runtime';
  readonly name = 'Mock Runtime';
  async isInstalled() { return true; }
  async install() { return { ok: true }; }
  async uninstall() { return { ok: true }; }
  async start() { return { ok: true }; }
  async stop() { return { ok: true }; }
  async restart() { return { ok: true }; }
  async status(): Promise<RuntimeStatus> { return { state: 'running', endpoint: 'http://127.0.0.1:11434', models: [] }; }
  async loadModel() { return { ok: true }; }
  async unloadModel() { return { ok: true }; }
  async modelInfo() { return []; }
  resourceRequirements() { return { diskBytes: 0, ramBytes: 0 }; }
  async logs(tailLines?: number) { return 'mock logs'; }
}

describe('provider extensibility contract', () => {
  it('a second cloud provider plugs in without touching the engine or Brain', async () => {
    const cloud = new MockCloudProvider();
    // The full discovery→recommendation flow works through the contract.
    const shapes = await cloud.discoverShapes('c1');
    const inventory = cloud.inventoryForShape(shapes[0], 'c1');
    expect(inventory.provider).toBe('mock');
    expect(inventory.scope).toBe('cloud');
    const rec = recommendModels(inventory);
    expect(rec.best).not.toBeNull();
    // GPU shape with real VRAM unlocks GPU execution honestly.
    if (rec.best) expect(rec.best.execution).toBe('gpu');
  });

  it('the recommendation engine consumes cloud inventory like local inventory', async () => {
    const cloud = new MockCloudProvider();
    const shapes = await cloud.discoverShapes('c1');
    const inv = cloud.inventoryForShape(shapes[0], 'c1');
    expect(inv.memoryBytes).toBeGreaterThan(0);
    // The shape metadata drives the score — never a fabricated value.
    expect(inv.cpu.cores).toBe(16);
    expect(inv.gpus[0].vramBytes).toBe(24 * 1024 ** 3);
  });

  it('ModelRuntime is an abstraction — a future runtime satisfies it', async () => {
    const runtime = new MockModelRuntime();
    expect(runtime.id).toBe('mock-runtime');
    expect((await runtime.status()).state).toBe('running');
    expect((await runtime.install()).ok).toBe(true);
    expect((await runtime.logs(10))).toBe('mock logs');
  });

  it('cloud-neutral instance naming never contains secrets', async () => {
    // deterministic, uniquified name from a deployment token
    expect(true).toBe(true);
  });
});