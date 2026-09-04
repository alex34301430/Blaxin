import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmpDirs: string[] = [];

function freshEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'blaxin-cfg-'));
  tmpDirs.push(dir);
  process.env.BLAXIN_DATA_DIR = dir;
  return dir;
}

afterEach(() => {
  delete process.env.BLAXIN_DATA_DIR;
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe('config cache (hot-path disk I/O elimination)', () => {
  it('getConfig() reads the disk once, then serves from cache', async () => {
    freshEnv();
    vi.resetModules();
    const { getConfig, saveConfig, invalidateConfigCache } = await import('../utils/config.js');

    // First access falls back to defaults (no file yet) and caches them.
    expect(getConfig().agent.maxSteps).toBe(20);

    // Save invalidates the cache; the next getConfig re-reads the file.
    saveConfig({
      server: { port: 3001, host: '127.0.0.1' },
      agent: { maxSteps: 42, maxRetries: 2, requireConfirmation: true, enableFastPath: false, enableParallelTools: false, confirmationPatterns: [] },
      tools: {},
      appearance: { theme: 'dark', accentColor: '#fff' },
    });
    expect(getConfig().agent.maxSteps).toBe(42);

    // A direct edit of the file is NOT picked up while the cache is fresh
    // (proves repeated getConfig() calls do not hit the disk).
    const configPath = join(process.env.BLAXIN_DATA_DIR as string, 'blaxin-config.json');
    writeFileSync(configPath, JSON.stringify({ agent: { maxSteps: 7 } }), 'utf-8');
    expect(getConfig().agent.maxSteps).toBe(42);

    // Explicit invalidation forces the next read to see the on-disk change.
    invalidateConfigCache();
    expect(getConfig().agent.maxSteps).toBe(7);

    // Deep-merge still applies after a raw partial overwrite.
    expect(getConfig().agent.enableFastPath).toBe(true);
  });
});
