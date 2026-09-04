// BLAXIN live Brain LLM — OPT-IN two-process test (real provider)
// =============================================================
// Verifies the real LLM path through the standalone Brain process:
// a real user task crosses from a real Body to a real Brain, the Brain
// calls an actual AI provider with a real key, and the final answer
// comes back over the wire.
//
// SKIPPED BY DEFAULT. Run it only when you want a live check and have a
// Brain-side provider key available (the key stays in your shell — it is
// never written to disk and never committed):
//
//   cd server
//   OPENROUTER_API_KEY=sk-or-... \
//   BLAXIN_BRAIN_PROVIDER=openrouter \
//   BLAXIN_BRAIN_MODEL=openrouter/auto \
//   BLAXIN_LIVE_BRAIN_E2E=1 \
//   npx vitest run src/__tests__/distributed/live-llm-brain.test.ts
//
// Keyless local providers work too (BLAXIN_BRAIN_PROVIDER=ollama with
// no key). This test never fabricates a result: a provider failure,
// missing model, or missing key fails the test loudly.
// =============================================================

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'net';
import WebSocket from 'ws';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TSX = join(SERVER_ROOT, 'node_modules', '.bin', 'tsx');

const LIVE_ENABLED = process.env.BLAXIN_LIVE_BRAIN_E2E === '1';
const PROVIDER = (process.env.BLAXIN_BRAIN_PROVIDER || '').trim();
const MODEL = (process.env.BLAXIN_BRAIN_MODEL || '').trim();

/** Env var that can carry a provider's key (mirrors providers/index.ts). */
function keyEnvFor(providerId: string): string | null {
  const mapping: Record<string, string> = {
    openrouter: 'OPENROUTER_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
    groq: 'GROQ_API_KEY',
    together: 'TOGETHER_API_KEY',
  };
  return mapping[providerId] || null;
}

const KEYLESS = PROVIDER === 'ollama';
const KEY_ENV = keyEnvFor(PROVIDER);
const HAS_KEY = KEYLESS || (KEY_ENV !== null && !!process.env[KEY_ENV]?.trim());

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];
const logs = new Map<string, string>();

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function spawnProc(name: string, entry: string, env: Record<string, string>): ChildProcess {
  const child = spawn(TSX, [entry], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      BLAXIN_MEMORY_FILE: undefined,
      BLAXIN_TELEMETRY_FILE: undefined,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.set(name, (logs.get(name) || '') + d.toString()));
  child.stderr.on('data', (d) => logs.set(name, (logs.get(name) || '') + d.toString()));
  children.push(child);
  return child;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${url}\n--- logs ---\n${dumpLogs()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${JSON.stringify(json)}\n--- logs ---\n${dumpLogs()}`);
  return json;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function poll(fn: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}\n--- logs ---\n${dumpLogs()}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function kill(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

function dumpLogs(): string {
  const out: string[] = [];
  for (const [name, log] of logs) {
    out.push(`===== ${name} logs =====\n${log.slice(-4000)}`);
  }
  return out.join('\n');
}

afterAll(async () => {
  for (const child of children.splice(0)) await kill(child);
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}, 30_000);

describe.skipIf(!LIVE_ENABLED)('live Brain LLM E2E (opt-in, real provider)', () => {
  it('routes a real user task through the provider and back without faking', async () => {
    if (!PROVIDER) {
      throw new Error('BLAXIN_BRAIN_PROVIDER is not set (e.g. openrouter). Refusing to guess.');
    }
    if (!MODEL) {
      throw new Error('BLAXIN_BRAIN_MODEL is not set. The Brain refuses to guess a model.');
    }
    if (!HAS_KEY) {
      const hint = KEY_ENV ? ` (set ${KEY_ENV})` : ` (unknown key env for provider "${PROVIDER}")`;
      throw new Error(`No API key available for provider "${PROVIDER}"${hint}. Keys stay in your shell and are never committed.`);
    }

    const brainDir = tmpDir('live-brain-');
    const bodyDir = tmpDir('live-body-');
    const marker = join(brainDir, 'marker.txt');
    const markerContent = `live-llm-marker-${Date.now()}`;
    writeFileSync(marker, markerContent);

    const brainPort = await freePort();
    const bodyPort = await freePort();

    const brainProc = spawnProc('brain', 'src/brain-main.ts', {
      BLAXIN_BRAIN_HOST: '127.0.0.1',
      BLAXIN_BRAIN_PORT: String(brainPort),
      BLAXIN_DATA_DIR: brainDir,
      BLAXIN_BRAIN_PROVIDER: PROVIDER,
      BLAXIN_BRAIN_MODEL: MODEL,
    });
    const brainBase = `http://127.0.0.1:${brainPort}`;
    await waitForHttp(`${brainBase}/health`, 20_000);

    // Confirm the Brain control plane reports the configured model.
    const ai = await getJson(`${brainBase}/ai/status`);
    expect(ai.activeProvider).toBe(PROVIDER);
    expect(ai.activeModel).toBe(MODEL);

    const pair = await postJson(`${brainBase}/pairing/start`, {});
    const code = pair.code as string;

    const bodyProc = spawnProc('body', 'src/index.ts', {
      BLAXIN_HOST: '127.0.0.1',
      PORT: String(bodyPort),
      BLAXIN_DATA_DIR: bodyDir,
      BLAXIN_BRAIN_MODE: 'external',
      BLAXIN_BRAIN_URL: `ws://127.0.0.1:${brainPort}/ws/brain`,
      BLAXIN_BODY_NAME: 'Live Test Body',
    });
    const bodyBase = `http://127.0.0.1:${bodyPort}`;
    await waitForHttp(`${bodyBase}/api/health`, 20_000);

    await postJson(`${bodyBase}/api/brain/connect`, {
      url: `ws://127.0.0.1:${brainPort}/ws/brain`,
      code,
    });
    await poll(async () => {
      const status = await getJson(`${bodyBase}/api/brain/status`);
      return status.brain?.state === 'CONNECTED';
    }, 15_000, 'body CONNECTED to brain');

    // Send a real user task over the Body UI WebSocket.
    const events: Array<{ event: string; data: any }> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${bodyPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.on('message', (data) => {
      try { events.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    ws.send(JSON.stringify({
      type: 'user-message',
      data: { content: `Use the filesystem tool to read the file at ${marker}, then tell me what it contains.` },
    }));

    // Wait for a real terminal answer from the provider through the Brain.
    await poll(async () => events.some((e) => e.event === 'agent-message'), 120_000, 'final agent message from the live model');
    const errors = events.filter((e) => e.event === 'error');
    expect(errors).toEqual([]); // provider/model failures surface as errors — never silently
    const final = events.find((e) => e.event === 'agent-message');
    expect(final?.data).toBeTruthy();
    // Honest terminal state, not a fabricated one.
    expect(hasEvent(events, 'task-complete') || hasEvent(events, 'agent-state', (d) => d.state === 'completed')).toBe(true);
    // The model was told the marker path; when it used the tool the real
    // content comes back. (A pure-text answer is allowed — the point of
    // this test is the provider round trip, not forcing tool use.)
    ws.close();
  }, 150_000);
});

function hasEvent(events: Array<{ event: string; data: any }>, event: string, predicate?: (d: any) => boolean): boolean {
  return events.some((e) => e.event === event && (!predicate || predicate(e.data)));
}
