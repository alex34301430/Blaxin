import { describe, it, expect } from 'vitest';
import { MODEL_CATALOG, getCatalogModel, modelsForRuntime } from '../../../src/models/model-catalog.js';

describe('model catalog', () => {
  it('contains only entries with complete, honest metadata', () => {
    expect(MODEL_CATALOG.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const m of MODEL_CATALOG) {
      expect(m.id).toBeTruthy();
      expect(ids.has(m.id)).toBe(false);
      ids.add(m.id);
      expect(m.name).toBeTruthy();
      expect(m.parameters).toBeGreaterThan(0);
      expect(m.diskBytes).toBeGreaterThan(0);
      expect(m.ramBytes).toBeGreaterThanOrEqual(m.diskBytes);
      expect(m.contextTokens).toBeGreaterThan(0);
      expect(m.runtimes.length).toBeGreaterThan(0);
      expect(m.architectures.length).toBeGreaterThan(0);
      expect(m.license).toBeTruthy();
      expect(m.schemaVersion).toBe(1);
      // No invented performance numbers: the list is either empty or
      // every claim carries an explicit source.
      for (const p of m.performance) {
        expect(p.metric).toBeTruthy();
        expect(p.value).toBeTruthy();
        expect(p.source).toBeTruthy();
      }
    }
  });

  it('looks models up by canonical id', () => {
    expect(getCatalogModel('qwen2.5:7b-instruct-q4_K_M')?.parameters).toBe(7_600_000_000);
    expect(getCatalogModel('does-not-exist')).toBeUndefined();
  });

  it('filters models by runtime compatibility', () => {
    const ollama = modelsForRuntime('ollama');
    expect(ollama.length).toBe(MODEL_CATALOG.length);
    expect(modelsForRuntime('vllm').every((m) => m.runtimes.includes('vllm'))).toBe(true);
  });

  it('keeps sizes in a sane band (nothing claims gigabytes for a 0.5B model)', () => {
    const tiny = getCatalogModel('qwen2.5:0.5b-instruct-q4_K_M')!;
    expect(tiny.diskBytes).toBeLessThan(1 * 1024 * 1024 * 1024);
    expect(tiny.ramBytes).toBeGreaterThan(512 * 1024 * 1024);
  });
});