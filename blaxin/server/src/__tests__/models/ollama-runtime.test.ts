import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OllamaRuntime } from '../../../src/models/ollama-runtime.js';

// ── A real (in-process) stand-in for the Ollama HTTP API ────────

let server: Server;
let basePort = 0;
let pullProgressEvents: Array<{ total: number | null; done: number | null; percent: number | null }> = [];
let pullModel: string | null = null;
let generateCalls = 0;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/version') return send(200, { version: '0.6.0' });
    if (url.pathname === '/api/tags') {
      return send(200, {
        models: [
          { name: 'qwen2.5:0.5b', size: 400 * 1024 * 1024, modified_at: '2026-01-02T03:04:05Z', details: { parameter_size: '0.5B', quantization_level: 'Q4_K_M' } },
          { name: 'llama3.1:8b', size: 5 * 1024 * 1024 * 1024, modified_at: '', details: { parameter_size: '8.0B', quantization_level: 'Q4_K_M' } },
        ],
      });
    }
    if (url.pathname === '/api/pull') {
      pullModel = (req.url || '').includes('model=') ? '?' : 'pull-called';
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { pullModel = JSON.parse(body).model ?? pullModel; } catch { /* noop */ }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        res.write(JSON.stringify({ status: 'downloading', total: 1000, completed: 250 }) + '\n');
        res.write(JSON.stringify({ status: 'downloading', total: 1000, completed: 750 }) + '\n');
        res.write(JSON.stringify({ status: 'success' }) + '\n');
        res.end();
      });
      return;
    }
    if (url.pathname === '/api/generate') {
      generateCalls++;
      return send(200, { response: 'OK', done: true });
    }
    send(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address && typeof address === 'object') basePort = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

function makeRuntime() {
  return new OllamaRuntime({
    host: '127.0.0.1',
    port: basePort,
    stateDir: mkdtempSync(join(tmpdir(), 'blaxin-ollama-test-')),
    now: () => Date.now(),
  });
}

describe('OllamaRuntime against a real local endpoint', () => {
  it('detects installation via the API', async () => {
    expect(await makeRuntime().isInstalled()).toBe(true);
  });

  it('reports running status with the real local model list', async () => {
    const status = await makeRuntime().status();
    expect(status.state).toBe('running');
    if (status.state === 'running') {
      expect(status.endpoint).toContain(`127.0.0.1:${basePort}`);
      const ids = status.models.map((m) => m.id);
      expect(ids).toContain('qwen2.5:0.5b');
      const qwen = status.models.find((m) => m.id === 'qwen2.5:0.5b')!;
      expect(qwen.parameters).toBe(500_000_000);
      expect(qwen.quantization).toBe('Q4_K_M');
      expect(qwen.sizeBytes).toBe(400 * 1024 * 1024);
      expect(qwen.modifiedAt).toBe(Date.parse('2026-01-02T03:04:05Z'));
      // unparseable modified_at must be null, not NaN
      const llama = status.models.find((m) => m.id === 'llama3.1:8b')!;
      expect(llama.modifiedAt).toBeNull();
    }
  });

  it('streams real pull progress and confirms the model landed', async () => {
    const runtime = makeRuntime();
    pullProgressEvents = [];
    const result = await runtime.pullModel('qwen2.5:0.5b', (p) => pullProgressEvents.push(p));
    expect(result.ok).toBe(true);
    expect(pullModel).toBe('qwen2.5:0.5b');
    // spent: downloading events only (progress callbacks)
    expect(pullProgressEvents.length).toBeGreaterThanOrEqual(2);
    expect(pullProgressEvents[0]?.percent).toBeGreaterThan(0);
    expect(pullProgressEvents.at(-1)?.percent).toBe(75);
    expect(runtime.pullStatus('qwen2.5:0.5b').pulling).toBe(false);
  });

  it('validates model ids before touching the network', async () => {
    const runtime = makeRuntime();
    expect((await runtime.pullModel('../../etc/passwd')).ok).toBe(false);
    expect((await runtime.loadModel('bad id with spaces!')).ok).toBe(false);
    expect((await runtime.unloadModel('')).ok).toBe(false);
  });

  it('rejects non-loopback endpoints', async () => {
    const runtime = new OllamaRuntime({ host: 'evil.example.com', port: basePort, stateDir: join(tmpdir(), 'blaxin-ollama-test2') });
    await expect(runtime.start()).rejects.toThrow(/loopback/);
    await expect(runtime.loadModel('x')).rejects.toThrow(/loopback/);
  });

  it('supports load/unload round trips against the API', async () => {
    const runtime = makeRuntime();
    expect((await runtime.loadModel('qwen2.5:0.5b')).ok).toBe(true);
    expect((await runtime.unloadModel('qwen2.5:0.5b')).ok).toBe(true);
    expect(generateCalls).toBeGreaterThanOrEqual(2);
  });

  it('reports not-running honestly when the daemon is absent', async () => {
    const runtime = new OllamaRuntime({ host: '127.0.0.1', port: 1, stateDir: join(tmpdir(), 'blaxin-ollama-test3'), now: () => Date.now() });
    const status = await runtime.status();
    // port 1 never answers → stopped (or not-installed when no binary)
    expect(['stopped', 'not-installed']).toContain(status.state);
  });

  it('never claims a runtime we did not start (stop is honest)', async () => {
    const runtime = makeRuntime();
    const stopped = await runtime.stop();
    expect(stopped.ok).toBe(true);
    expect(stopped.detail).toMatch(/managed outside BLAXIN|not running/i);
  });
});