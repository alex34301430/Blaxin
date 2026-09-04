import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    environment: 'node',
    env: {
      // Keep tests from touching real runtime state
      BLAXIN_MEMORY_FILE: '.blaxin-state/memory.test.json',
      BLAXIN_TELEMETRY_FILE: '.blaxin-state/telemetry.test.json',
    },
  },
});
