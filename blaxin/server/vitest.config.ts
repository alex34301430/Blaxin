import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/**/*.test.ts',
      // Cross-package tests: the client's registry-sync module lives in
      // the client package (self-contained for the Docker/vite build) and
      // is exercised here from the server suite. Kept outside src/ so the
      // server tsc build (rootDir=src) never sees the client import.
      'registry-sync.test.ts',
    ],
    exclude: ['dist/**', 'node_modules/**'],
    environment: 'node',
    env: {
      // Keep tests from touching real runtime state
      BLAXIN_MEMORY_FILE: '.blaxin-state/memory.test.json',
      BLAXIN_TELEMETRY_FILE: '.blaxin-state/telemetry.test.json',
    },
  },
});
