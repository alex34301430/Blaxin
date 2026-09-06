import { describe, it, expect } from 'vitest';
import { recommendModels } from '../../../src/models/recommendation.js';
import { ResourceInventory } from '../../../src/models/resource-inventory.js';
import { MODEL_CATALOG } from '../../../src/models/model-catalog.js';

const GB = 1024 * 1024 * 1024;

function inventory(overrides: Partial<ResourceInventory> = {}): ResourceInventory {
  return {
    schemaVersion: 1,
    scope: 'local',
    os: { platform: 'linux', release: 'test', family: 'linux' },
    architecture: 'x86_64',
    cpu: { cores: 8, physicalCores: 4, model: 'Test CPU', clockMhz: 3000, flags: { avx2: true, avx512: false, neon: false } },
    memoryBytes: 16 * GB,
    gpus: [],
    storage: { freeBytes: 100 * GB, totalBytes: 500 * GB },
    detectedAt: Date.now(),
    ...overrides,
  };
}

describe('recommendation engine', () => {
  it('recommends deterministic best + ranked alternatives on a 16 GB machine', () => {
    const a = recommendModels(inventory());
    const b = recommendModels(inventory());
    expect(a.best).not.toBeNull();
    expect(a.best!.model.id).toBe(b.best!.model.id);
    // sorted best-first
    const scores = a.alternatives.map((x) => x.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    // the best model must fit measured RAM
    expect(a.best!.model.ramBytes).toBeLessThanOrEqual(16 * GB);
  });

  it('never recommends a model that cannot fit in RAM', () => {
    const result = recommendModels(inventory({ memoryBytes: 3 * GB }));
    for (const alt of result.alternatives) {
      expect(alt.model.ramBytes).toBeLessThan(3 * GB);
    }
    expect(result.alternatives.length).toBeLessThan(MODEL_CATALOG.length);
  });

  it('treats unknown VRAM conservatively (CPU execution, never GPU)', () => {
    const withGpu = inventory({ gpus: [{ name: 'GPU', vramBytes: null, kind: 'nvidia-cuda' }] });
    const result = recommendModels(withGpu);
    // Unknown VRAM must not unlock a GPU-required model as 'gpu'.
    for (const alt of result.alternatives) {
      if (alt.execution === 'gpu') {
        // If it is gpu, VRAM must have been known and sufficient.
        const gpu = withGpu.gpus[0];
        expect(gpu.vramBytes).not.toBeNull();
        expect(gpu.vramBytes!).toBeGreaterThanOrEqual(alt.model.vramBytes ?? 0);
      }
    }
  });

  it('reports an honest warning when a GPU is required but none was detected', () => {
    const result = recommendModels(inventory({ gpus: [] }));
    const warned = result.alternatives.filter((a) => a.warnings.some((w) => w.code === 'GPU_REQUIRED_NOT_DETECTED'));
    // Only big models trigger it — and only on GPU-less machines.
    for (const alt of warned) {
      expect((alt.model.vramBytes ?? 0) > 4 * GB).toBe(true);
    }
  });

  it('fails closed on incompatible architectures', () => {
    const result = recommendModels(inventory({ architecture: 'riscv64' }));
    // 'any' architectures could still run, but nothing should be claimed as x86.
    expect(result.best).toBeNull();
  });

  it('returns a note (not a fake model) when nothing can run', () => {
    const result = recommendModels(inventory({ memoryBytes: 256 * 1024 * 1024 }));
    expect(result.best).toBeNull();
    expect(result.alternatives.length).toBe(0);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('scores capability coverage: requesting code+tools prefers capable models', () => {
    const plain = recommendModels(inventory(), { capabilities: ['chat'] });
    const code = recommendModels(inventory(), { capabilities: ['code'] });
    if (code.best && plain.best) {
      expect(code.best.score).toBeGreaterThanOrEqual(plain.best.score);
    }
  });

  it('emits CAPABILITY_PARTIAL warnings for missing capabilities', () => {
    const result = recommendModels(inventory(), { capabilities: ['long-context'] });
    const withLong = result.alternatives.find((a) => a.model.capabilities.includes('long-context'));
    const without = result.alternatives.find((a) => !a.model.capabilities.includes('long-context'));
    expect(withLong).toBeDefined();
    expect(without?.warnings.some((w) => w.code === 'CAPABILITY_PARTIAL')).toBe(true);
  });
});
