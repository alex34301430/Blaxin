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
//   BLAXIN_BRAIN_PROVIDER / BLAXIN_BRAIN_MODEL
//                                           active AI provider/model (default:
//                                           auto-select the first ready provider)
//   OPENROUTER_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY /
//   GROQ_API_KEY / TOGETHER_API_KEY         provider keys — Brain only, never
//                                           sent to Bodies (also loadable via the
//                                           encrypted credential store)
// =============================================================

import { pathToFileURL } from 'url';
import { BrainAIHandle, BrainRuntime } from './distributed/brain-runtime.js';
import {
  BrainTaskDriver, DeterministicDriver, LLMTaskDriver,
} from './distributed/brain-drivers.js';
import { providers } from './providers/index.js';
import { logger } from './utils/logger.js';
import { dataPath } from './utils/paths.js';
import { ProviderId } from './types.js';

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

let brainAIInitialized = false;

/** Configure the AI providers this Brain owns. Runs once per process:
 * loads keys (encrypted credential store, then env fallback) and selects
 * the active provider/model. Credentials never leave this device and are
 * never logged. */
async function initializeBrainAI(): Promise<void> {
  if (brainAIInitialized) return;
  brainAIInitialized = true;
  await providers.initializeAll();

  const wantProvider = (process.env.BLAXIN_BRAIN_PROVIDER || '').trim();
  const wantModel = (process.env.BLAXIN_BRAIN_MODEL || '').trim();
  if (wantProvider) {
    try {
      providers.getProvider(wantProvider as ProviderId); // existence check
      providers.setActiveProvider(wantProvider as ProviderId);
    } catch {
      logger.warn('brain', `BLAXIN_BRAIN_PROVIDER="${wantProvider}" is not a known provider`);
    }
  }
  if (wantModel) providers.setActiveModel(wantModel);

  if (!providers.getActiveProvider()) {
    // No explicit choice: prefer the first provider that is ready to serve
    // (keyless local models, or any provider with a key configured).
    const ready = providers.getAllProviders().find((p) => !p.apiKeyRequired || p.hasApiKey());
    if (ready) {
      providers.setActiveProvider(ready.id);
      logger.info('brain', `Auto-selected AI provider: ${ready.name}`);
    }
  }

  const activeProvider = providers.getActiveProvider();
  const activeModel = providers.getActiveModel();
  if (activeProvider && activeModel) {
    logger.info('brain', `Brain AI ready: ${activeProvider}/${activeModel}`);
  } else if (activeProvider && !activeModel) {
    logger.warn('brain', `Provider ${activeProvider} selected but no model — set BLAXIN_BRAIN_MODEL (LLM tasks fail honestly with NO_MODEL)`);
  } else {
    logger.warn('brain', 'No AI provider configured on this Brain — LLM tasks fail honestly with NO_PROVIDER (set BLAXIN_BRAIN_PROVIDER / BLAXIN_BRAIN_MODEL or POST /ai/select)');
  }
}

/** AI control-plane handle exposed on the Brain HTTP surface (loopback
 * admin only — Bodies never reach it, matching /pairing and /devices). */
const brainAI: BrainAIHandle = {
  status: () => ({
    activeProvider: providers.getActiveProvider(),
    activeModel: providers.getActiveModel(),
    providers: providers.getAllProviders().map((p) => ({
      id: p.id,
      name: p.name,
      apiKeyRequired: p.apiKeyRequired,
      hasKey: p.hasApiKey(),
      healthy: p.isHealthy(),
    })),
  }),
  select: (providerId: string, modelId?: string) => {
    try {
      providers.getProvider(providerId as ProviderId);
    } catch {
      return { ok: false, error: `Unknown provider: ${providerId}` };
    }
    providers.setActiveProvider(providerId as ProviderId);
    if (modelId) providers.setActiveModel(modelId);
    logger.info('brain', `AI provider selected: ${providerId}${modelId ? ` / ${modelId}` : ''}`);
    return { ok: true };
  },
};

export async function startBrainRuntime(options: {
  port?: number;
  host?: string;
  autoPairing?: boolean;
  drivers?: BrainTaskDriver[];
  identityFile?: string;
  registryFile?: string;
} = {}): Promise<BrainRuntime> {
  await initializeBrainAI();

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
    aiControl: brainAI,
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
