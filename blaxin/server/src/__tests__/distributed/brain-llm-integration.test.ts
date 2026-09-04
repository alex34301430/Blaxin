// BLAXIN Brain ↔ Body — LLM-driven integration (real sockets)
// =============================================================
// Phase B1: verify the REAL Brain reasoning path end to end without any
// provider credential. The Brain's LLM driver is fed by a SCRIPTED model
// (no network), while everything else is real:
//   - a real BrainRuntime speaking the versioned protocol over real WS
//   - a real RemoteBrainDriver Body with the real filesystem tool
//   - the full capability/policy gate on the Body
// The scripted model requests a filesystem read; the action crosses the
// wire, the Body executes it for real, the result is fed back to the
// "model", which then produces the final answer. This proves the loop
// shape that a live provider will drive (covered separately by the
// opt-in live test).
// =============================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { BrainRuntime } from '../../distributed/brain-runtime.js';
import { LLMTaskDriver } from '../../distributed/brain-drivers.js';
import { RemoteBrainDriver } from '../../distributed/remote-brain.js';
import { BodyState } from '../../distributed/body-state.js';
import { loadOrCreateIdentity } from '../../distributed/identity.js';
import { FileSystemTool } from '../../tools/filesystem.js';
import type { LLMProviderLike, LLMProviderRegistryLike } from '../../distributed/brain-drivers.js';
import type {
  AIResponse, ChatMessage, ToolCall, ToolDefinition, Tool, ToolResult, ProviderId,
} from '../../types.js';

const tmpDirs: string[] = [];
const runtimes: BrainRuntime[] = [];
const drivers: RemoteBrainDriver[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const d of drivers.splice(0)) d.disconnect();
  for (const r of runtimes.splice(0)) await r.stop();
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** A registry exposing ONLY the filesystem tool (real implementation). */
function filesystemOnlyRegistry() {
  const fsTool = new FileSystemTool();
  const tools = new Map<string, Tool>([['filesystem', fsTool]]);
  return {
    getTool(name: string): Tool | undefined { return tools.get(name); },
    getToolDefinitions(): ToolDefinition[] { return [...tools.values()].map((t) => t.definition); },
    async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const tool = tools.get(name);
      if (!tool) return { success: false, output: '', error: `Unknown tool: ${name}` };
      return tool.execute(args);
    },
    requiresConfirmation(name: string, args: Record<string, unknown>): boolean {
      return tools.get(name)?.requiresConfirmation?.(args) ?? false;
    },
  };
}

const FAKE_PROVIDER: ProviderId = 'custom';
const FAKE_MODEL = 'fake-model';

/** A scripted model: turn 1 requests actions, later turns answer from the
 * accumulated tool results. No network, no credentials. */
class ScriptedModel implements LLMProviderLike {
  id = FAKE_PROVIDER;
  name = 'Scripted Brain Model';
  hasKey = true;
  chats: number = 0;
  private queue: Array<(messages: ChatMessage[]) => AIResponse> = [];

  hasApiKey(): boolean { return this.hasKey; }

  play(fn: (messages: ChatMessage[]) => AIResponse): void { this.queue.push(fn); }

  async chat(request: {
    messages: ChatMessage[];
    model: string;
    provider?: string;
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<AIResponse> {
    this.chats++;
    const fn = this.queue.shift();
    if (!fn) throw new Error('ScriptedModel: no scripted response left');
    return fn(request.messages);
  }
}

class FakeRegistry implements LLMProviderRegistryLike {
  constructor(private readonly provider: LLMProviderLike) {}
  getActiveProvider(): ProviderId | null { return FAKE_PROVIDER; }
  getActiveModel(): string | null { return FAKE_MODEL; }
  getProvider(_id: ProviderId): LLMProviderLike { return this.provider; }
}

function toolResponse(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): AIResponse {
  const toolCalls: ToolCall[] = calls.map((c) => ({
    id: c.id,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  }));
  return {
    message: { id: uuidv4(), role: 'assistant', content: '', timestamp: Date.now() },
    toolCalls,
    model: FAKE_MODEL,
    provider: FAKE_PROVIDER,
  };
}

function textResponse(content: string): AIResponse {
  return {
    message: { id: uuidv4(), role: 'assistant', content, timestamp: Date.now() },
    model: FAKE_MODEL,
    provider: FAKE_PROVIDER,
  };
}

async function makeBrain(model: ScriptedModel): Promise<{ runtime: BrainRuntime; wsUrl: string }> {
  const dir = tmpDir('blaxin-brain-');
  const registry = new FakeRegistry(model);
  const runtime = new BrainRuntime({
    host: '127.0.0.1',
    port: 0,
    identityFile: join(dir, 'brain-identity.json'),
    registryFile: join(dir, 'devices.json'),
    drivers: new Map([['llm', new LLMTaskDriver({ providers: registry, maxSteps: 10 })]]),
    defaultDriverId: 'llm',
  });
  runtimes.push(runtime);
  const info = await runtime.start();
  return { runtime, wsUrl: info.wsUrl };
}

interface TestBody {
  identityId: string;
  driver: RemoteBrainDriver;
  events: Array<{ event: string; data: any }>;
}

async function makeBody(dir: string, wsUrl: string): Promise<TestBody> {
  const identity = loadOrCreateIdentity({ filePath: join(dir, 'body-identity.json'), role: 'body', name: 'Test Body' });
  const events: Array<{ event: string; data: any }> = [];
  const driver = new RemoteBrainDriver({
    identity,
    url: wsUrl,
    state: new BodyState(dir),
    toolRegistry: filesystemOnlyRegistry(),
    onEvent: (event, data) => { events.push({ event, data }); },
    autoReconnect: true,
  });
  drivers.push(driver);
  return { identityId: identity.id, driver, events };
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function hasEvent(events: Array<{ event: string; data: any }>, event: string, predicate?: (d: any) => boolean): boolean {
  return events.some((e) => e.event === event && (!predicate || predicate(e.data)));
}

describe('brain ↔ body LLM task loop (real sockets, scripted model)', () => {
  it('drives a real tool execution from a model decision to a verified final answer', async () => {
    const dir = tmpDir('blaxin-body-');
    const marker = join(dir, 'marker.txt');
    const markerContent = 'brain-llm-marker-7';
    writeFileSync(marker, markerContent);

    const model = new ScriptedModel();
    // Turn 1: the "model" decides the task needs a filesystem read.
    model.play(() => toolResponse([
      { id: 'call_1', name: 'filesystem', args: { operation: 'read', path: marker } },
    ]));
    // Turn 2: it answers from the tool result the Body really produced.
    model.play((messages) => {
      const tool = [...messages].reverse().find((m) => m.role === 'tool');
      return textResponse(`Verified final answer. ${tool?.content ?? '(no tool result)'}`);
    });

    const { runtime, wsUrl } = await makeBrain(model);
    const { driver, events } = await makeBody(dir, wsUrl);
    const code = runtime.generatePairingCode()?.code;
    expect(code).toBeTruthy();

    driver.connect(code);
    await waitFor(() => driver.isReady(), 10_000, 'body connected to brain');
    expect((driver.status().capabilities as string[])).toEqual(['filesystem']);

    driver.sendUserMessage('read the marker file and report its content');
    await waitFor(() => hasEvent(events, 'agent-message'), 15_000, 'final agent message');

    const final = events.find((e) => e.event === 'agent-message');
    // The tool result (real file content from the Body) reached the model
    // and came back in its final answer — no fabricated summary.
    expect(JSON.stringify(final?.data)).toContain(markerContent);
    expect(JSON.stringify(final?.data)).toContain('Verified final answer');
    expect(hasEvent(events, 'agent-state', (d) => d.state === 'completed')).toBe(true);
    expect(hasEvent(events, 'error')).toBe(false);
    expect(model.chats).toBeGreaterThanOrEqual(2);
  });

  it('fails honestly when the model asks for a tool the Body never advertised', async () => {
    const dir = tmpDir('blaxin-body-');
    const model = new ScriptedModel();
    model.play(() => toolResponse([
      { id: 'call_x', name: 'computer-control', args: { action: 'key_press', key: 'x' } },
    ]));

    const { runtime, wsUrl } = await makeBrain(model);
    const { driver, events } = await makeBody(dir, wsUrl);
    const code = runtime.generatePairingCode()?.code;

    driver.connect(code);
    await waitFor(() => driver.isReady(), 10_000, 'body connected');

    driver.sendUserMessage('press a key for me');
    await waitFor(() => hasEvent(events, 'error', (d) => d.code === 'UNKNOWN_TOOL'), 10_000, 'unknown-tool failure');
    // Failed honestly: surfaced as an error, never as a fake completion.
    expect(hasEvent(events, 'agent-state', (d) => d.state === 'completed')).toBe(false);
    expect(hasEvent(events, 'agent-message')).toBe(false);
    expect((driver.status().task as { state: string } | null)?.state).toBe('error');
    // The Brain never executed anything locally, and the body never ran it.
    expect(model.chats).toBe(1);
  });
});
