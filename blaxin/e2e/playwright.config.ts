import { defineConfig } from '@playwright/test';

// BLAXIN end-to-end tests.
//
// Topology (mirrors real development usage):
//   Google Chrome  ──▶  vite dev server (127.0.0.1:5173)
//                          │  /api + /ws proxied to the backend
//                          ▼
//                    real BLAXIN backend (127.0.0.1:3001, tsx from src,
//                    scratch data dir under .runtime/)
//
// The deterministic fast path lets a real safe task ("list /tmp") run
// end to end with NO provider key, so the full UI → WS → agent loop →
// UI pipeline is exercised honestly. No browser binaries are downloaded:
// the installed system Chrome is used via channel 'chrome'.

const BACKEND_PORT = Number(process.env.PW_BACKEND_PORT || 3001);
const VITE_PORT = Number(process.env.PW_VITE_PORT || 5173);
const DATA_DIR = new URL('./.runtime/data', import.meta.url).pathname;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${VITE_PORT}`,
    channel: 'chrome',
    headless: true,
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx src/index.ts',
      cwd: '../server',
      url: `http://127.0.0.1:${BACKEND_PORT}/api/health`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        PORT: String(BACKEND_PORT),
        BLAXIN_HOST: '127.0.0.1',
        BLAXIN_DATA_DIR: DATA_DIR,
        BROWSER: 'none',
      },
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // --host 127.0.0.1: vite otherwise binds 'localhost' which can
      // resolve to ::1 only, refusing IPv4 readiness probes.
      command: `npm run dev -- --host 127.0.0.1 --port ${VITE_PORT} --strictPort`,
      cwd: '../client',
      url: `http://127.0.0.1:${VITE_PORT}`,
      timeout: 30_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
