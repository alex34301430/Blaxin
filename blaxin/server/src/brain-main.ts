// BLAXIN Brain — standalone process entrypoint
// =============================================================
// Start an independent BLAXIN Brain (reasoning device) with:
//
//   cd server && npm run brain
//   # or directly:
//   npx tsx src/brain-main.ts [--pair]
//
// The Brain listens for Body connections, runs one-time pairing, and
// drives tasks by requesting structured actions from connected Bodies.
// It owns the AI providers (keys stay on this device) and NEVER
// executes tools itself.
//
// Env:
//   BLAXIN_BRAIN_HOST / BLAXIN_BRAIN_PORT   bind address (default 127.0.0.1:3100)
//   BLAXIN_DATA_DIR                         state dir (identity + registry)
//   BLAXIN_BRAIN_DEFAULT_DRIVER             llm | deterministic (default llm)
//   BLAXIN_BRAIN_DETERMINISTIC_STEPS        JSON array of {tool,args,description}
//   BLAXIN_BRAIN_AUTO_PAIRING=1             print a fresh pairing code at boot
// =============================================================

import { pathToFileURL } from 'url';
import { BrainRuntime } from './distributed/brain-runtime.js';
import {
  BrainTaskDriver, DeterministicDriver, LLMTaskDriver,
} from './distributed/brain-drivers.js';
import { providers } from './providers/index.js';
import { logger } from './utils/logger.js';
import { dataPath } from './utils/paths.js';

function readDeterministicSteps(): unknown[] {
  const raw = process.env.BLAXIN_BRAIN_DETERMINISTIC_STEPS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function startBrainRuntime(options: {
  port?: number;
  host?: string;
  autoPairing?: boolean;
  drivers?: BrainTaskDriver[];
  identityFile?: string;
  registryFile?: string;
} = {}): Promise<BrainRuntime> {
  const drivers: BrainTaskDriver[] = options.drivers ?? [
    // Production reasoning driver (uses the providers the Brain owns).
    new LLMTaskDriver({ providers }),
  ];
  // Deterministic driver (scripted/test runs) — registered only when the
  // operator supplies explicit steps so it can never run by accident.
  const steps = readDeterministicSteps();
  if (steps.length > 0) {
    const sanitized = steps
      .filter((s): s is { tool: string; args: Record<string, unknown>; description?: string; idempotent?: boolean } =>
        !!s && typeof s === 'object' && typeof (s as { tool?: unknown }).tool === 'string')
      .map((s) => ({
        tool: s.tool,
        args: s.args && typeof s.args === 'object' ? s.args as Record<string, unknown> : {},
        description: typeof s.description === 'string' ? s.description : `Run ${s.tool}`,
        idempotent: s.idempotent !== false,
      }));
    if (sanitized.length > 0) {
      drivers.push(new DeterministicDriver({ steps: sanitized }));
      logger.info('brain', `Deterministic driver registered with ${sanitized.length} steps`);
    }
  }

  const runtime = new BrainRuntime({
    host: options.host,
    port: options.port,
    drivers: new Map(drivers.map((d) => [d.id, d])),
    identityFile: options.identityFile ?? dataPath('brain-identity.json'),
    registryFile: options.registryFile ?? dataPath('.blaxin-state', 'brain-devices.json'),
  });

  await runtime.start();
  if (options.autoPairing || process.env.BLAXIN_BRAIN_AUTO_PAIRING === '1') {
    const code = runtime.generatePairingCode();
    if (code) {
      logger.info('brain', `READY FOR PAIRING — Pairing Code: ${code.code} — expires in ${code.expiresInSec}s`);
    }
  } else {
    logger.info('brain', `Generate a pairing code: POST /pairing/start (or restart with BLAXIN_BRAIN_AUTO_PAIRING=1)`);
  }
  return runtime;
}

async function main(): Promise<void> {
  logger.info('brain', `BLAXIN Brain starting (data dir: ${process.env.BLAXIN_DATA_DIR || '(cwd)'})`);
  await startBrainRuntime();

  const shutdown = async () => {
    logger.info('brain', 'Brain shutting down...');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// Run only when this file is the entrypoint (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error: any) => {
    logger.error('brain', `Brain failed to start: ${error.message}`);
    process.exit(1);
  });
}
