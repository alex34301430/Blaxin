// BLAXIN Body persistence for the distributed layer
// =============================================================
// The Body persists (in its local data dir):
//   - the Brain it is paired with (id + public key + URL + transport)
//   - its own identity is persisted separately (body-identity.json)
//   - a bounded cache of executed remote actions, keyed by actionId
//
// The executed-action cache is what prevents DUPLICATE EXECUTION after
// a reconnect: when the Brain re-sends a task_action whose actionId was
// already executed, the Body answers from this cache instead of running
// the tool again. Non-idempotent actions without a cached outcome are
// never blindly replayed.
// =============================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../utils/logger.js';
import { DeviceId } from './types.js';

export interface BrainConfig {
  brainId: DeviceId;
  brainName: string;
  brainPublicKey: string;
  /** ws:// or wss:// URL of the Brain's /ws/brain endpoint. */
  url: string;
  pairedAt: number;
}

export interface CachedActionResult {
  actionId: string;
  taskId: string;
  tool: string;
  /** 'received' = the action was requested but its execution did not
   * finish (crash / restart before the tool returned). Terminal outcomes
   * below mean the action reached a verdict. */
  state: 'received' | 'final';
  outcome: 'allowed' | 'denied' | 'rejected';
  success: boolean;
  /** Truncated tool output (replay does not need the full payload). */
  output?: string;
  error?: string;
  executedAt: number;
  idempotent: boolean;
}

export interface BodyStateFile {
  brain: BrainConfig | null;
  /** Last remote task this body ran (for honest reconnect reports). */
  lastTaskId?: string;
  lastTaskText?: string;
  lastTaskState?: string;
}

export const MAX_CACHE_ENTRIES = 200;
export const MAX_CACHED_OUTPUT_CHARS = 20_000;

/** A JSON file under the data dir, written atomically with 0600 perms. */
export class JsonStateFile<T> {
  private value: T | null = null;
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly validate: (raw: unknown) => T | null,
  ) {}

  /** Read once (lazily cached); corrupt files yield null, never throw. */
  get(): T | null {
    if (!this.loaded) {
      this.loaded = true;
      try {
        if (existsSync(this.filePath)) {
          const raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
          this.value = this.validate(raw);
        }
      } catch (error: any) {
        logger.warn('body', `State file unreadable (${this.filePath}): ${error.message}`);
        this.value = null;
      }
    }
    return this.value;
  }

  set(value: T | null): void {
    this.value = value;
    this.loaded = true;
    this.save();
  }

  update(fn: (current: T | null) => T | null): void {
    this.set(fn(this.get()));
  }

  save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = join(dirname(this.filePath), `.state.${process.pid}.${Date.now()}.tmp`);
      writeFileSync(tmp, JSON.stringify(this.value), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (error: any) {
      logger.error('body', `Failed to persist body state: ${error.message}`);
    }
  }

  clear(): void {
    this.set(null);
  }
}

function validateBrainConfig(raw: unknown): BrainConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.brainId !== 'string' || !/^BLX-BRAIN-[A-Z0-9]{4,12}$/.test(b.brainId)) return null;
  if (typeof b.brainPublicKey !== 'string' || b.brainPublicKey.length < 16) return null;
  if (typeof b.url !== 'string' || !/^wss?:\/\//.test(b.url)) return null;
  return {
    brainId: b.brainId,
    brainName: typeof b.brainName === 'string' ? b.brainName.slice(0, 60) : b.brainId,
    brainPublicKey: b.brainPublicKey,
    url: b.url,
    pairedAt: typeof b.pairedAt === 'number' ? b.pairedAt : Date.now(),
  };
}

export class BodyState {
  readonly brain: JsonStateFile<BrainConfig>;
  readonly actions: JsonStateFile<CachedActionResult[]>;

  constructor(dataDir = process.env.BLAXIN_DATA_DIR || '.') {
    this.brain = new JsonStateFile<BrainConfig>(
      join(dataDir, '.blaxin-state', 'body-brain.json'),
      validateBrainConfig,
    );
    this.actions = new JsonStateFile<CachedActionResult[]>(
      join(dataDir, '.blaxin-state', 'body-actions.json'),
      (raw) => {
        if (!Array.isArray(raw)) return [];
        const out: CachedActionResult[] = [];
        for (const a of raw) {
          if (!a || typeof a !== 'object') continue;
          const r = a as Record<string, unknown>;
          if (typeof r.actionId === 'string' && typeof r.taskId === 'string' &&
              typeof r.tool === 'string' && (r.outcome === 'allowed' || r.outcome === 'denied' || r.outcome === 'rejected')) {
            out.push({
              actionId: r.actionId,
              taskId: r.taskId,
              tool: r.tool,
              state: r.state === 'received' ? 'received' : 'final',
              outcome: r.outcome,
              success: r.success === true,
              output: typeof r.output === 'string' ? r.output : undefined,
              error: typeof r.error === 'string' ? r.error : undefined,
              executedAt: typeof r.executedAt === 'number' ? r.executedAt : Date.now(),
              idempotent: r.idempotent !== false,
            });
          }
        }
        return out;
      },
    );
  }

  /** The paired Brain config, or null when not paired. */
  getBrain(): BrainConfig | null {
    return this.brain.get();
  }

  setBrain(config: BrainConfig): void {
    this.brain.set(config);
  }

  clearBrain(): void {
    this.brain.clear();
  }

  /** Look up the action ledger entry by actionId (duplicate-execution guard). */
  getCachedAction(actionId: string): CachedActionResult | undefined {
    const all = this.actions.get() || [];
    return all.find((a) => a.actionId === actionId);
  }

  /** Record that an action request arrived (before execution starts). */
  markActionReceived(action: { actionId: string; taskId: string; tool: string; idempotent: boolean }): void {
    const all = (this.actions.get() || []).filter((a) => a.actionId !== action.actionId);
    all.push({
      actionId: action.actionId,
      taskId: action.taskId,
      tool: action.tool,
      state: 'received',
      outcome: 'rejected',
      success: false,
      executedAt: Date.now(),
      idempotent: action.idempotent,
    });
    while (all.length > MAX_CACHE_ENTRIES) all.shift();
    this.actions.set(all);
  }

  cacheAction(result: CachedActionResult): void {
    const all = this.actions.get() || [];
    const next = all.filter((a) => a.actionId !== result.actionId);
    next.push(result);
    while (next.length > MAX_CACHE_ENTRIES) next.shift();
    this.actions.set(next);
  }

  /** All ledger entries for a task (used for honest state reports). */
  cachedForTask(taskId: string): CachedActionResult[] {
    return (this.actions.get() || []).filter((a) => a.taskId === taskId);
  }

  /** Terminal (final-verdict) entries only — used to answer state_sync. */
  lastFinalAction(taskId: string): CachedActionResult | undefined {
    const all = (this.actions.get() || []).filter((a) => a.taskId === taskId && a.state === 'final');
    return all.length > 0 ? all[all.length - 1] : undefined;
  }

  clearActionCache(): void {
    this.actions.set([]);
  }
}

/** Shared singleton used by the running Body server. */
export const bodyState = new BodyState();
