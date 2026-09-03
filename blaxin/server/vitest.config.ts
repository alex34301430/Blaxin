import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    environment: 'node',
    env: {
      // Keep tests from touching real runtime memory
      BLAXIN_MEMORY_FILE: '.blaxin-state/memory.test.json',
    },
  },
});
