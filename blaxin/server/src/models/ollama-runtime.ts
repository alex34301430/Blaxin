// BLAXIN Ollama runtime
// =============================================================
// The first production ModelRuntime implementation: manages the local
// Ollama engine over its native HTTP API (default 127.0.0.1:11434).
//
// Security posture: the Ollama endpoint is loopback-only. We never
// expose it to other hosts and never forward it through the Body.
// =============================================================

import { execFile } from 'child_process';
import { readFile, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { dataPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import {
  ModelRuntime, RuntimeModelInfo, RuntimeOperationResult, RuntimeStatus,
} from './runtime.js';

const OLLAMA_HOST_DEFAULT = '127.0.0.1';
const OLLAMA_PORT_DEFAULT = 11434;
const HEALTH_TIMEOUT_MS = 2_500;
const OPERATION_TIMEOUT_MS = 15_000;
const LOG_TAIL_BYTES = 16 * 1024;

/** Absolute-process timeout wrapper for execFile. */
function run(command: string, args: string[], timeoutMs = OPERATION_TIMEOUT_MS): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '', error: error.message });
      } else {
        resolve({ ok: true, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
      }
    });
  });
}

export interface OllamaRuntimeOptions {
  host?: string;
  port?: number;
  /** Where the runtime keeps small bookkeeping files (daemon pid hints). */
  stateDir?: string;
  now?: () => number;
}

export class OllamaRuntime implements ModelRuntime {
  readonly id = 'ollama';
  readonly name = 'Ollama';
  private readonly host: string;
  private readonly port: number;
  private readonly stateDir: string;
  private readonly now: () => number;
  /** Pulls started via this runtime (bounded map). */
  private activePulls = new Map<string, { startedAt: number; status: 'pulling' }>();

  constructor(options: OllamaRuntimeOptions = {}) {
    this.host = options.host ?? process.env.BLAXIN_OLLAMA_HOST ?? OLLAMA_HOST_DEFAULT;
    this.port = Number(options.port ?? process.env.BLAXIN_OLLAMA_PORT ?? OLLAMA_PORT_DEFAULT);
    this.stateDir = options.stateDir ?? dataPath('runtime-ollama');
    this.now = options.now ?? Date.now;
  }

  get endpoint(): string {
    return `http://${this.host}:${this.port}`;
  }

  /** Loopback guard: we only ever talk to a local Ollama. */
  private assertLoopback(): void {
    const h = this.host.toLowerCase();
    if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') {
      throw new Error('OllamaRuntime only accepts loopback endpoints');
    }
  }

  private async fetchJson(path: string, init?: RequestInit, timeoutMs = HEALTH_TIMEOUT_MS): Promise<{ status: number; body: unknown } | null> {
    try {
      const res = await fetch(`${this.endpoint}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: res.status, body };
    } catch {
      return null;
    }
  }

  async isInstalled(): Promise<boolean> {
    // Installed = the binary is on PATH or the API answers.
    const which = await run('which', ['ollama'], 3_000);
    if (which.ok && which.stdout.trim()) return true;
    const health = await this.fetchJson('/api/version');
    return health !== null && health.status === 200;
  }

  async install(): Promise<RuntimeOperationResult> {
    if (await this.isInstalled()) return { ok: true, detail: 'Ollama is already installed' };
    const fam = process.platform;
    if (fam === 'linux') {
      // Official install script pinned to the official domain.
      const curl = await run('curl', ['-fsSL', '--max-time', '120', 'https://ollama.com/install.sh', '-o', '/tmp/blaxin-ollama-install.sh'], 150_000);
      if (!curl.ok) return { ok: false, error: `Failed to download the Ollama installer: ${curl.error || curl.stderr.slice(0, 200)}` };
      const sh = await run('sh', ['/tmp/blaxin-ollama-install.sh'], 600_000);
      return sh.ok
        ? { ok: true, detail: sh.stdout.slice(-400) }
        : { ok: false, error: `Ollama installer failed: ${sh.error || sh.stderr.slice(-400)}` };
    }
    if (fam === 'darwin') {
      const brew = await run('brew', ['install', 'ollama'], 600_000);
      return brew.ok ? { ok: true } : { ok: false, error: `brew install failed: ${brew.error || brew.stderr.slice(-300)}` };
    }
    return { ok: false, error: 'Automatic Ollama installation is not supported on this OS. Install it from https://ollama.com and retry.' };
  }

  async uninstall(): Promise<RuntimeOperationResult> {
    await this.stop();
    // We only remove what we track (state dir); the system package is
    // left to the system package manager — never force-remove globally.
    await rm(this.stateDir, { recursive: true, force: true });
    return { ok: true, detail: 'BLAXIN Ollama state removed; uninstall the system package via your package manager if desired.' };
  }

  async start(): Promise<RuntimeOperationResult> {
    this.assertLoopback();
    if (!(await this.isInstalled())) {
      return { ok: false, error: 'Ollama is not installed' };
    }
    const health = await this.fetchJson('/api/version');
    if (health && health.status === 200) {
      return { ok: true, detail: 'Ollama is already running' };
    }
    // Detached spawn: `ollama serve` keeps running after we exit.
    const spawned = await run('sh', ['-c', `nohup ollama serve >> '${this.stateDir}/ollama.log' 2>&1 & echo $!`], 5_000);
    if (!spawned.ok) {
      return { ok: false, error: `Failed to start Ollama: ${spawned.error || spawned.stderr.slice(-200)}` };
    }
    // Bounded wait for real health (no fake READY).
    const deadline = this.now() + 20_000;
    while (this.now() < deadline) {
      const h = await this.fetchJson('/api/version');
      if (h && h.status === 200) return { ok: true };
      await new Promise((r) => setTimeout(r, 500));
      // If the process died, stop waiting.
      const pidFile = `${this.stateDir}/ollama.pid`;
      if (existsSync(pidFile)) {
        const pid = Number((await readFile(pidFile, 'utf-8')).trim());
        if (Number.isFinite(pid) && !process.kill(pid, 0)) break;
      }
    }
    return { ok: false, error: 'Ollama did not become healthy within 20s' };
  }

  async stop(): Promise<RuntimeOperationResult> {
    this.assertLoopback();
    // Prefer a clean stop of OUR spawned daemon; never pkill other users'
    // Ollama instances.
    const pidFile = `${this.stateDir}/ollama.pid`;
    if (existsSync(pidFile)) {
      try {
        const pid = Number((await readFile(pidFile, 'utf-8')).trim());
        if (Number.isFinite(pid) && pid > 1) {
          process.kill(pid, 'SIGTERM');
          await writeFile(pidFile, '', 'utf-8');
          return { ok: true, detail: `Stopped daemon ${pid}` };
        }
      } catch { /* stale pid file */ }
    }
    // Not started by us: report honestly — we don't own the lifecycle.
    const health = await this.fetchJson('/api/version');
    return {
      ok: true,
      detail: health && health.status === 200
        ? 'Ollama is managed outside BLAXIN; it was not stopped'
        : 'Ollama is not running',
    };
  }

  async restart(): Promise<RuntimeOperationResult> {
    await this.stop();
    return this.start();
  }

  async status(): Promise<RuntimeStatus> {
    if (!(await this.isInstalled())) return { state: 'not-installed' };
    const health = await this.fetchJson('/api/version');
    if (!health || health.status !== 200) {
      return { state: 'stopped' };
    }
    const models = await this.modelInfo();
    return { state: 'running', endpoint: this.endpoint, models };
  }

  async loadModel(modelId: string): Promise<RuntimeOperationResult> {
    this.assertLoopback();
    // Ollama loads on first request; keep-alive pins it. Validate the id.
    if (!/^[A-Za-z0-9._:\-\/]{1,120}$/.test(modelId)) {
      return { ok: false, error: 'Invalid model id' };
    }
    const res = await this.fetchJson('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId, prompt: '', keep_alive: '30m' }),
    }, 120_000);
    if (res && res.status === 200) return { ok: true };
    return { ok: false, error: `Ollama failed to load ${modelId}` };
  }

  async unloadModel(modelId: string): Promise<RuntimeOperationResult> {
    this.assertLoopback();
    if (!/^[A-Za-z0-9._:\-\/]{1,120}$/.test(modelId)) {
      return { ok: false, error: 'Invalid model id' };
    }
    const res = await this.fetchJson('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId, prompt: '', keep_alive: 0 }),
    }, 30_000);
    if (res && res.status === 200) return { ok: true };
    return { ok: false, error: `Ollama failed to unload ${modelId}` };
  }

  async modelInfo(): Promise<RuntimeModelInfo[]> {
    const res = await this.fetchJson('/api/tags');
    if (!res || res.status !== 200) return [];
    const body = res.body as { models?: Array<{ name?: string; size?: number; modified_at?: string; details?: { parameter_size?: string; quantization_level?: string } }> } | null;
    const models = body?.models ?? [];
    return models.map((m) => ({
      id: String(m.name || ''),
      sizeBytes: typeof m.size === 'number' ? m.size : null,
      parameters: m.details?.parameter_size ? parseParamCount(m.details.parameter_size) : null,
      quantization: m.details?.quantization_level || null,
      modifiedAt: m.modified_at ? Date.parse(m.modified_at) || null : null,
    }));
  }

  resourceRequirements(): { diskBytes: number; ramBytes: number } {
    // The engine itself: ~1.5 GB disk (bundled runtimes), ~0.5 GB RAM idle.
    return { diskBytes: 1.6 * 1024 * 1024 * 1024, ramBytes: 512 * 1024 * 1024 };
  }

  async logs(tailLines = 100): Promise<string> {
    try {
      const logPath = `${this.stateDir}/ollama.log`;
      if (!existsSync(logPath)) return '';
      const raw = await readFile(logPath, 'utf-8');
      const lines = raw.split('\n');
      return lines.slice(-tailLines).join('\n');
    } catch (error: any) {
      logger.warn('ollama', `Failed to read logs: ${error.message}`);
      return '';
    }
  }

  /** Start pulling a model (streaming progress via the callback).
   * The pull is REAL: progress comes from Ollama's streaming response.
   * Returns a pull id the client polls via pullStatus(). */
  async pullModel(modelId: string, onProgress?: (p: { total: number | null; done: number | null; percent: number | null }) => void): Promise<RuntimeOperationResult> {
    this.assertLoopback();
    if (!/^[A-Za-z0-9._:\-\/]{1,120}$/.test(modelId)) {
      return { ok: false, error: 'Invalid model id' };
    }
    this.activePulls.set(modelId, { startedAt: this.now(), status: 'pulling' });
    try {
      const res = await fetch(`${this.endpoint}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelId, stream: true }),
        signal: AbortSignal.timeout(60 * 60 * 1000), // 1h hard cap
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `Ollama pull failed (${res.status}): ${text.slice(0, 300)}` };
      }
      // Stream NDJSON progress.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastErr: string | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line) as { total?: number; completed?: number; error?: string };
            if (j.error) lastErr = j.error;
            if (typeof j.total === 'number' && typeof j.completed === 'number' && onProgress) {
              onProgress({ total: j.total, done: j.completed, percent: Math.round((j.completed / j.total) * 100) });
            }
          } catch { /* partial line */ }
        }
      }
      if (lastErr) return { ok: false, error: `Ollama pull failed: ${lastErr}` };
      // Confirm the model actually landed.
      const models = await this.modelInfo();
      if (!models.some((m) => m.id === modelId)) {
        return { ok: false, error: `Pull finished but ${modelId} is not present in the local model list` };
      }
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: `Ollama pull failed: ${error.message}` };
    } finally {
      this.activePulls.delete(modelId);
    }
  }

  pullStatus(modelId: string): { pulling: boolean; startedAt: number | null } {
    const p = this.activePulls.get(modelId);
    return p ? { pulling: true, startedAt: p.startedAt } : { pulling: false, startedAt: null };
  }
}

/** "7.6B" → 7_600_000_000; null when unparseable. */
function parseParamCount(label: string): number | null {
  const m = label.match(/([\d.]+)\s*([BMK])/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { b: 1e9, m: 1e6, k: 1e3 }[m[2].toLowerCase()] ?? 1;
  return Math.round(n * mult);
}
