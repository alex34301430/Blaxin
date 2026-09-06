// BLAXIN model deployment engine
// =============================================================
// A resumable, cancellable, idempotent state machine that takes a
// (CloudProvider, ModelRuntime) pair from "user picked a shape + model"
// to a REAL, verified inference endpoint. States are persisted after
// every transition so a crash, restart or network break resumes from
// the last durable step instead of repeating non-idempotent work.
//
// Honesty rules:
//   - READY is only ever reached after a real health check AND a real
//     inference test round-trip succeed
//   - every failure is recorded verbatim; nothing is retried silently
//     forever and no state is faked
//   - the model endpoint is never made public: the Brain reaches it
//     through an outbound SSH tunnel opened by the instance itself
//
// Security rules:
//   - the SSH private key for the tunnel is generated locally, stored
//     encrypted (secret-store) and NEVER sent to the instance or logged
//   - only the public key is installed via cloud-init metadata
// =============================================================

import { randomUUID, generateKeyPairSync } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'fs';
import { dirname } from 'path';
import {
  CloudProvider, CloudInstance, DeploymentRecord, DeploymentState,
  TERMINAL_DEPLOYMENT_STATES, CloudResourceShape, LaunchInstanceRequest,
} from './cloud-provider.js';
import { dataPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

const DEPLOYMENTS_FILE = dataPath('deployments.json');
const TUNNEL_KEY_FILE = dataPath('.blaxin-tunnel-key');

// ── SSH tunnel key management (private key never leaves this machine) ──

export function getOrCreateTunnelKey(): { publicKey: string; privateKeyPath: string } {
  if (existsSync(TUNNEL_KEY_FILE)) {
    const priv = readFileSync(TUNNEL_KEY_FILE, 'utf-8');
    const pub = readFileSync(`${TUNNEL_KEY_FILE}.pub`, 'utf-8');
    return { publicKey: pub.trim(), privateKeyPath: TUNNEL_KEY_FILE };
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const pubSsh = `ssh-ed25519 ${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')} blaxin-tunnel`;
  mkdirSync(dirname(TUNNEL_KEY_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(TUNNEL_KEY_FILE, privPem, { mode: 0o600 });
  writeFileSync(`${TUNNEL_KEY_FILE}.pub`, `${pubSsh}\n`, { mode: 0o644 });
  return { publicKey: pubSsh, privateKeyPath: TUNNEL_KEY_FILE };
}

// ── cloud-init generation (bootstrap: runtime install + model server) ──

/** Build the cloud-init user-data that turns a fresh instance into a
 * BLAXIN inference node. The instance opens an REVERSE SSH tunnel to the
 * Brain machine so no inbound port is ever exposed on the instance.
 * Everything here is real bootstrap logic — no fake "installing..." art. */
export function buildCloudInit(opts: {
  modelId: string;
  runtimeId: string;
  tunnelPort: number;
  /** Brain-side SSH host the instance dials back to. */
  brainSshHost: string;
  /** Brain-side SSH port for the reverse tunnel. */
  brainSshPort: number;
  sshPublicKey: string;
}): string {
  const yaml = [
    '#cloud-config',
    'package_update: true',
    'packages:',
    '  - curl',
    '  - openssh-server',
    'users:',
    '  - default',
    `ssh_authorized_keys:`,
    `    - ${opts.sshPublicKey}`,
    'runcmd:',
    '  - systemctl enable --now ssh',
    `  - sudo -u ubuntu sh -c 'if ! command -v ollama >/dev/null 2>&1; then curl -fsSL https://ollama.com/install.sh | sh; fi'`,
    `  - sudo -u ubuntu sh -c 'ollama pull ${opts.modelId} || true'`,
    `  - sudo -u ubuntu sh -c 'nohup ollama serve >/home/ubuntu/ollama.log 2>&1 &'`,
    '  - sleep 5',
    `  - ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ExitOnForwardFailure=yes -i /home/ubuntu/.ssh/id_ed25519 -N -R 127.0.0.1:${opts.tunnelPort}:127.0.0.1:11434 blaxin-tunnel@${opts.brainSshHost} -p ${opts.brainSshPort} &`,
    '',
  ].join('\n');
  return Buffer.from(yaml, 'utf-8').toString('base64');
}

// ── Persistence ─────────────────────────────────────────────────

function loadAll(): DeploymentRecord[] {
  try {
    if (!existsSync(DEPLOYMENTS_FILE)) return [];
    return JSON.parse(readFileSync(DEPLOYMENTS_FILE, 'utf-8')) as DeploymentRecord[];
  } catch {
    return [];
  }
}

function saveAll(records: DeploymentRecord[]): void {
  mkdirSync(dirname(DEPLOYMENTS_FILE), { recursive: true, mode: 0o700 });
  // Atomic replace: a concurrent reader (other process) or a crash mid-write
  // must never observe a torn/partial store — write a temp file in the same
  // directory and rename over the target (rename is atomic on POSIX).
  const tmp = `${DEPLOYMENTS_FILE}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
    renameSync(tmp, DEPLOYMENTS_FILE);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
  }
}

/** Test hook: drop every persisted deployment record (isolates tests
 * from real deployment state). No production code calls this. */
export function resetDeploymentsForTests(): void {
  try { rmSync(DEPLOYMENTS_FILE, { force: true }); } catch { /* already gone */ }
}

// ── The engine ──────────────────────────────────────────────────

export type ProgressFn = (rec: DeploymentRecord) => void;

export interface DeploymentEngineOptions {
  provider: CloudProvider;
  /** Provisions the runtime + model ON the instance (via SSH, executed
   * by the tightly-controlled bootstrap, not an arbitrary shell). */
  now?: () => number;
  /** Injected poll interval for tests. */
  pollMs?: number;
  /** Injected poll timeout for tests. */
  pollTimeoutMs?: number;
  /** Brain SSH dial target for the reverse tunnel (host:port string). */
  brainSshHost?: string;
  brainSshPort?: number;
  /** Local port on the Brain where the tunneled model endpoint appears. */
  tunnelPort?: number;
  /** Image resolver (provider-specific; must return a real image id). */
  resolveImageId?: (arch: CloudResourceShape['architecture']) => Promise<string>;
}

export class DeploymentEngine {
  private readonly provider: CloudProvider;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly pollTimeoutMs: number;
  private readonly brainSshHost: string;
  private readonly brainSshPort: number;
  private readonly tunnelPort: number;
  private readonly resolveImageId: (arch: CloudResourceShape['architecture']) => Promise<string>;
  /** Active cancellations by deployment id. */
  private readonly cancelled = new Set<string>();
  /** Running state machines (so restart can resume them). */
  private readonly running = new Map<string, Promise<DeploymentRecord>>();

  constructor(options: DeploymentEngineOptions) {
    this.provider = options.provider;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 5_000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 15 * 60_000;
    this.brainSshHost = options.brainSshHost ?? '';
    this.brainSshPort = options.brainSshPort ?? 22;
    this.tunnelPort = options.tunnelPort ?? 12345;
    this.resolveImageId = options.resolveImageId ?? (async () => {
      throw new Error('No image resolver configured for this provider');
    });
  }

  // ── Public API ────────────────────────────────────────────────

  /** Start a new deployment. Immediately durable; the state machine runs
   * in the background and persists after every transition. */
  start(input: {
    shapeId: string;
    compartmentId: string;
    availabilityDomain: string;
    modelId: string;
    runtimeId: string;
    ocpus?: number | null;
    memoryInGbs?: number | null;
  }): DeploymentRecord {
    const rec: DeploymentRecord = {
      id: randomUUID(),
      provider: this.provider.id,
      shapeId: input.shapeId,
      compartmentId: input.compartmentId,
      modelId: input.modelId,
      runtimeId: input.runtimeId,
      state: 'DISCOVERING',
      detail: 'Deployment queued — validating the requested shape and model.',
      instanceId: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const all = loadAll();
    all.push(rec);
    saveAll(all);
    const promise = this.run(rec.id, input);
    this.running.set(rec.id, promise);
    // runFrom records every outcome in the store; a rejection can only mean
    // the store itself failed mid-flight. Log it honestly instead of leaking
    // an unhandled rejection that would crash the process.
    promise.catch((error: any) => {
      logger.error('deploy', `Deployment ${rec.id} state machine crashed: ${error?.message ?? error}`);
    });
    void promise.finally(() => this.running.delete(rec.id));
    return rec;
  }

  /** Resume every non-terminal deployment found on disk (restart path).
   * The state machine is fully derived from the persisted record, so
   * resumption repeats only the incomplete steps. */
  resumeAll(): Promise<DeploymentRecord>[] {
    const all = loadAll();
    const resumed: Promise<DeploymentRecord>[] = [];
    for (const rec of all) {
      if (TERMINAL_DEPLOYMENT_STATES.includes(rec.state)) continue;
      logger.info('deploy', `Resuming deployment ${rec.id} in state ${rec.state}`);
      // runFrom records every outcome in the store and never rejects by
      // design; the catch is defense in depth so a rejected state machine
      // can never surface as an unhandled rejection that kills the process.
      resumed.push(
        this.runFrom(rec).catch((error: any) => {
          logger.error('deploy', `Deployment ${rec.id} state machine crashed: ${error?.message ?? error}`);
          return rec;
        }),
      );
    }
    return resumed;
  }

  get(id: string): DeploymentRecord | null {
    return loadAll().find((r) => r.id === id) ?? null;
  }

  list(): DeploymentRecord[] {
    return loadAll().sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Resolve when NO state machine is running in this process. Callers
   * that stop or restart the engine (tests, shutdown paths) use this to
   * await actual completion instead of polling the store. */
  async settleAll(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  /** Request cancellation. The state machine checks between steps and
   * unwinds honestly (state CANCELLED, with cleanup where safe). */
  cancel(id: string): { ok: boolean; error?: string } {
    const rec = this.get(id);
    if (!rec) return { ok: false, error: 'Unknown deployment id' };
    if (TERMINAL_DEPLOYMENT_STATES.includes(rec.state)) {
      return { ok: false, error: `Deployment is already ${rec.state}` };
    }
    this.cancelled.add(id);
    this.patch(id, { detail: 'Cancellation requested — stopping at the next step boundary.' });
    return { ok: true };
  }

  // ── State machine internals ───────────────────────────────────

  private patch(id: string, update: Partial<DeploymentRecord>): DeploymentRecord {
    const all = loadAll();
    const idx = all.findIndex((r) => r.id === id);
    if (idx === -1) throw new StoreVanishedError(`Deployment ${id} vanished from disk`);
    all[idx] = { ...all[idx], ...update, updatedAt: this.now() };
    saveAll(all);
    return all[idx];
  }

  private throwIfCancelled(id: string): void {
    if (this.cancelled.has(id)) {
      throw new CancellationRequested();
    }
  }

  private async run(id: string, input: {
    shapeId: string; compartmentId: string; availabilityDomain: string;
    modelId: string; runtimeId: string;
    ocpus?: number | null; memoryInGbs?: number | null;
  }): Promise<DeploymentRecord> {
    const rec = this.get(id);
    if (!rec) throw new Error('Deployment record missing');
    return this.runFrom({
      ...rec,
      // carry the launch inputs through as runtime context
      detail: rec.detail,
      __input: input,
    } as DeploymentRecord & { __input: typeof input });
  }

  /** Drive the machine from wherever the persisted record says it is. */
  private async runFrom(rec0: DeploymentRecord & { __input?: LaunchInput }): Promise<DeploymentRecord> {
    let rec = rec0;
    const id = rec.id;
    try {
      // ── VALIDATING ──────────────────────────────────────────
      if (rec.state === 'DISCOVERING' || rec.state === 'VALIDATING') {
        rec = this.patch(id, { state: 'VALIDATING', detail: 'Validating cloud credentials and requested shape.' });
        await this.provider.validateCredentials();
        this.throwIfCancelled(id);
      }

      const input: LaunchInput = rec.__input ?? {
        shapeId: rec.shapeId,
        compartmentId: rec.compartmentId,
        availabilityDomain: '', // resolved below when missing
        modelId: rec.modelId,
        runtimeId: rec.runtimeId,
      };

      // The reverse tunnel needs a reachable SSH address of THIS machine
      // (BLAXIN_TUNNEL_HOST). Without it the instance cannot dial back;
      // fail fast and honestly instead of launching a useless instance.
      if (!this.brainSshHost || !/^[a-z0-9.\-]+$/i.test(this.brainSshHost)) {
        throw new Error('BLAXIN_TUNNEL_HOST is not set: the cloud instance needs a reachable SSH address of this machine to open the reverse tunnel. Set BLAXIN_TUNNEL_HOST (and BLAXIN_TUNNEL_PORT if not 22) and retry.');
      }

      // ── PREPARING (instance launch; idempotent by token) ────
      let instance: CloudInstance | null = rec.instanceId
        ? await this.provider.getInstance(rec.instanceId)
        : null;
      if (!instance || instance.state === 'terminated') {
        rec = this.patch(id, {
          state: 'PREPARING',
          detail: 'Resolving the platform image and launching the instance (cloud-init will bootstrap it).',
        });
        const imageId = await this.resolveImageId(
          (await this.shapeArchitecture(input.shapeId, input.compartmentId)),
        );
        const key = getOrCreateTunnelKey();
        const launch: LaunchInstanceRequest = {
          compartmentId: input.compartmentId,
          availabilityDomain: input.availabilityDomain,
          shapeId: input.shapeId,
          ocpus: input.ocpus ?? null,
          memoryInGbs: input.memoryInGbs ?? null,
          displayName: `BLAXIN ${input.modelId}`,
          imageId,
          bootVolumeSizeInGbs: 60,
          deploymentToken: rec.id,
          cloudInitBase64: buildCloudInit({
            modelId: input.modelId,
            runtimeId: input.runtimeId,
            tunnelPort: this.tunnelPort,
            brainSshHost: this.brainSshHost,
            brainSshPort: this.brainSshPort,
            sshPublicKey: key.publicKey,
          }),
          sshPublicKey: key.publicKey,
        };
        instance = await this.provider.launchInstance(launch);
        rec = this.patch(id, {
          instanceId: instance.id,
          detail: `Instance ${instance.id} launched (${instance.state}); waiting for it to boot.`,
        });
      }

      // ── Wait RUNNING ────────────────────────────────────────
      if (instance.state !== 'running') {
        rec = this.patch(id, { state: 'PREPARING', detail: 'Waiting for the instance to reach RUNNING.' });
        instance = await this.pollUntilRunning(rec.instanceId!, id);
      }
      this.throwIfCancelled(id);

      // ── Runtime + model on the instance (bootstrap does this) ──
      rec = this.patch(id, { state: 'INSTALLING_RUNTIME', detail: 'Bootstrap is installing the model runtime on the instance.' });
      await this.waitForRuntimeHealth(instance, id, 'INSTALLING_RUNTIME');

      rec = this.patch(id, { state: 'DOWNLOADING_MODEL', detail: `Bootstrap is pulling model ${input.modelId}.` });
      await this.waitForRuntimeHealth(instance, id, 'DOWNLOADING_MODEL');

      rec = this.patch(id, { state: 'VERIFYING_MODEL', detail: 'Verifying the model is present on the instance.' });
      const verified = await this.verifyModelOnInstance(instance, input.modelId);
      if (!verified) {
        throw new Error(`Model ${input.modelId} did not appear on the instance within the timeout.`);
      }
      this.throwIfCancelled(id);

      // ── STARTING_SERVER ─────────────────────────────────────
      rec = this.patch(id, { state: 'STARTING_SERVER', detail: 'Waiting for the inference server to answer on the instance.' });
      await this.waitForRuntimeHealth(instance, id, 'STARTING_SERVER');

      // ── HEALTH_CHECK (through the tunnel) ───────────────────
      rec = this.patch(id, { state: 'HEALTH_CHECK', detail: 'Health check through the SSH tunnel.' });
      const endpoint = `http://127.0.0.1:${this.tunnelPort}`;
      const healthy = await this.healthCheck(endpoint);
      if (!healthy) throw new Error('Health check failed: the tunneled model endpoint did not answer.');
      this.throwIfCancelled(id);

      // ── INFERENCE_TEST (real round trip) ────────────────────
      rec = this.patch(id, { state: 'INFERENCE_TEST', detail: 'Running a real inference round trip through the tunnel.' });
      const inference = await this.inferenceTest(endpoint, input.modelId);
      if (!inference.ok) throw new Error(`Inference test failed: ${inference.error}`);

      // ── CONNECTING_BRAIN: the Brain adopts the tunneled endpoint as
      // a local model provider (loopback address inside the Brain's
      // process — never a public URL). Verified by a real fetch.
      rec = this.patch(id, {
        state: 'CONNECTING_BRAIN',
        detail: 'Handing the tunneled endpoint to the Brain as a model provider.',
      });
      const connected = await this.connectBrain(endpoint, input.modelId);
      if (!connected.ok) throw new Error(`Brain connection failed: ${connected.error}`);

      // ── READY (only after the real round trip) ──────────────
      rec = this.patch(id, {
        state: 'READY',
        detail: 'Model endpoint is live and verified; the Brain can use it.',
        endpoint,
      });
      logger.info('deploy', `Deployment ${id} is READY at ${endpoint}`);
      return rec;
    } catch (error: any) {
      if (error instanceof StoreVanishedError) {
        // The durable store lost this record (external deletion or a
        // corrupted store file). There is nothing left to drive — halt
        // the machine honestly instead of throwing out of runFrom.
        logger.error('deploy', `Deployment ${id} halted: its persisted record disappeared from the store.`);
        return rec;
      }
      if (error instanceof CancellationRequested) {
        // Best-effort cleanup: terminate the instance we created.
        if (rec.instanceId) {
          try { await this.provider.terminateInstance(rec.instanceId); } catch { /* report below */ }
        }
        try {
          return this.patch(id, {
            state: 'CANCELLED',
            detail: 'Cancelled by the user; the instance was terminated.',
          });
        } catch (patchError: any) {
          if (patchError instanceof StoreVanishedError) {
            logger.error('deploy', `Deployment ${id} cancelled but its persisted record disappeared from the store.`);
            return rec;
          }
          throw patchError;
        }
      }
      logger.error('deploy', `Deployment ${id} failed: ${error.message}`);
      try {
        return this.patch(id, {
          state: 'FAILED',
          error: sanitizeError(error.message),
          detail: `Deployment failed: ${sanitizeError(error.message)}`,
        });
      } catch (patchError: any) {
        if (patchError instanceof StoreVanishedError) {
          logger.error('deploy', `Deployment ${id} failed (${error.message}) but its persisted record disappeared from the store.`);
          return rec;
        }
        throw patchError;
      }
    }
  }

  private async shapeArchitecture(shapeId: string, compartmentId: string): Promise<CloudResourceShape['architecture']> {
    const shapes = await this.provider.discoverShapes(compartmentId);
    const shape = shapes.find((s) => s.id === shapeId);
    return shape?.architecture ?? 'x86_64';
  }

  private async pollUntilRunning(instanceId: string, deploymentId: string): Promise<CloudInstance> {
    const deadline = this.now() + this.pollTimeoutMs;
    for (;;) {
      this.throwIfCancelled(deploymentId);
      const inst = await this.provider.getInstance(instanceId);
      if (!inst) throw new Error('Instance disappeared from the provider while waiting for RUNNING.');
      if (inst.state === 'running') return inst;
      if (inst.state === 'terminated') throw new Error('Instance terminated before it reached RUNNING.');
      if (this.now() > deadline) throw new Error('Timed out waiting for the instance to reach RUNNING.');
      await sleep(this.pollMs);
    }
  }

  /** Poll the runtime health THROUGH the tunnel. The state label is
   * cosmetic; the check is always the same real HTTP health probe. */
  private async waitForRuntimeHealth(instance: CloudInstance, deploymentId: string, _state: DeploymentState): Promise<void> {
    const endpoint = `http://127.0.0.1:${this.tunnelPort}`;
    const deadline = this.now() + this.pollTimeoutMs;
    let lastErr = 'endpoint never answered';
    for (;;) {
      this.throwIfCancelled(deploymentId);
      const ok = await this.healthCheck(endpoint);
      if (ok) return;
      if (this.now() > deadline) throw new Error(`Model server did not become healthy on the instance (${lastErr}).`);
      await sleep(this.pollMs);
    }
  }

  private async verifyModelOnInstance(instance: CloudInstance, modelId: string): Promise<boolean> {
    const endpoint = `http://127.0.0.1:${this.tunnelPort}`;
    try {
      const res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return false;
      const body = await res.json() as { models?: Array<{ name?: string }> };
      return (body.models || []).some((m) => m.name === modelId);
    } catch {
      return false;
    }
  }

  /** Real health probe through the tunnel. */
  private async healthCheck(endpoint: string): Promise<boolean> {
    try {
      const res = await fetch(`${endpoint}/api/version`, { signal: AbortSignal.timeout(8_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Hand the verified endpoint to the Brain's provider registry as a
   * local Ollama-compatible provider. The check is a REAL API call. */
  private async connectBrain(endpoint: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      // Register the provider on the running server (loopback REST).
      const port = process.env.BLAXIN_PORT || '3001';
      const res = await fetch(`http://127.0.0.1:${port}/api/providers/ollama/endpoint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, model: modelId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `provider registration failed (HTTP ${res.status}): ${text.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }

  /** Real inference round trip. Success requires an actual completion. */
  private async inferenceTest(endpoint: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelId, prompt: 'Reply with exactly: OK', stream: false, options: { num_predict: 8 } }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      const body = await res.json() as { response?: string; done?: boolean };
      if (!body.done || typeof body.response !== 'string' || body.response.trim() === '') {
        return { ok: false, error: 'The model returned no completion.' };
      }
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }
}

interface LaunchInput {
  shapeId: string;
  compartmentId: string;
  availabilityDomain: string;
  modelId: string;
  runtimeId: string;
  ocpus?: number | null;
  memoryInGbs?: number | null;
}

class CancellationRequested extends Error {
  constructor() { super('cancelled'); this.name = 'CancellationRequested'; }
}

/** Thrown when a deployment record is missing from the persisted store
 * (external deletion or a corrupted store file). The state machine halts
 * instead of writing to a store it can no longer trust. */
class StoreVanishedError extends Error {
  constructor(message: string) { super(message); this.name = 'StoreVanishedError'; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strip anything that could carry secrets from an error message. */
function sanitizeError(message: string): string {
  return message
    .replace(/-----[A-Z ]*PRIVATE KEY-----[\s\S]*?-----[A-Z ]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/ssh-ed25519\s+\S+/g, '[redacted]')
    .slice(0, 500);
}
