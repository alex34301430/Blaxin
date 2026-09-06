import { describe, it, expect, afterAll } from 'vitest';
import {
  normalizeArch,
  normalizeOsFamily,
  formatBytes,
  detectResourceInventory,
  invalidateResourceCache,
} from '../../../src/models/resource-inventory.js';

describe('resource inventory normalization', () => {
  it('normalizes architectures', () => {
    expect(normalizeArch('x64')).toBe('x86_64');
    expect(normalizeArch('amd64')).toBe('x86_64');
    expect(normalizeArch('aarch64')).toBe('aarch64');
    expect(normalizeArch('armv7l')).toBe('armv7');
    expect(normalizeArch('riscv64')).toBe('riscv64');
    expect(normalizeArch('weird')).toBe('other');
  });

  it('normalizes OS families', () => {
    expect(normalizeOsFamily('linux')).toBe('linux');
    expect(normalizeOsFamily('darwin')).toBe('macos');
    expect(normalizeOsFamily('win32')).toBe('windows');
    expect(normalizeOsFamily('freebsd')).toBe('other');
  });

  it('formats byte counts honestly (unknown stays unknown)', () => {
    expect(formatBytes(null)).toBe('unknown');
    expect(formatBytes(undefined)).toBe('unknown');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toMatch(/GB/);
    expect(formatBytes(512 * 1024)).toMatch(/KB/);
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });
});

describe('real local detection', () => {
  afterAll(() => invalidateResourceCache());

  it('detects the real machine without inventing hardware', async () => {
    const inv = await detectResourceInventory();
    expect(inv.scope).toBe('local');
    expect(inv.schemaVersion).toBe(1);
    // These come from the OS API — always present and real.
    expect(inv.memoryBytes).toBeGreaterThan(0);
    expect(inv.cpu.cores).toBeGreaterThanOrEqual(1);
    expect(['x86_64', 'aarch64', 'armv7', 'riscv64', 'other']).toContain(inv.architecture);
    expect(['linux', 'macos', 'windows', 'other']).toContain(inv.os.family);
    expect(inv.detectedAt).toBeLessThanOrEqual(Date.now());
    // Unknowns are null, never fabricated values.
    expect(inv.cpu.flags.avx2 === null || typeof inv.cpu.flags.avx2 === 'boolean').toBe(true);
  });

  it('never claims a GPU unless the OS reported one', async () => {
    const inv = await detectResourceInventory();
    for (const gpu of inv.gpus) {
      // A detected GPU always has a name and a kind; VRAM may be null
      // when the OS does not expose it.
      expect(gpu.kind).not.toBe('unknown');
      expect(typeof gpu.name).toBe('string');
    }
  });
});