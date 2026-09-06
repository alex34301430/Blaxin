// BLAXIN Brain LLM driver — focused unit tests
// =============================================================
// The LLM driver is the production reasoning core of the Brain. These
// tests exercise it with a SCRIPTED fake provider (no credentials, no
// network). They verify the driver never fakes completion: direct
// answers, real tool loops, honest failures on unadvertised tools,
// provider errors, missing provider/model/key, denials, policy
// rejections, silent-Body timeouts, and the step cap.
// =============================================================

import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { LLMTaskDriver } from '../../distributed/brain-drivers.js';
import type {
  BrainTaskContext, LLMProviderLike, LLMProviderRegistryLike,
} from '../../distributed/brain-drivers.js';
import type { AIResponse, ChatMessage, ToolCall, ToolDefinition, ProviderId } from '../../types.js';
import type { TaskActionRequest, ActionResult, CapabilitySet } from '../../distributed/types.js';

const FILESYSTEM_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'filesystem',
    description: 'Read and write files on the Body.',
    parameters: { type: 'object', properties: { operation: { type: 'string' }, path: { type: 'string' } } },
  },
};

const BODY_CAPS: CapabilitySet = ['filesystem'];
const FAKE_PROVIDER: ProviderId = 'custom';
const FAKE_MODEL = 'fake-model';

function textResponse(content: string): AIResponse {
  return {
    message: { id: uuidv4(), role: 'assistant', content, timestamp: Date.now() },
    model: FAKE_MODEL,
    provider: FAKE_PROVIDER,
  };
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

/** Provider that plays back a script of responses/errors in order. */
class ScriptedProvider implements LLMProviderLike {
  id = FAKE_PROVIDER;
  name = 'Fake Brain Provider';
  hasKey = true;
  apiKeyRequired = true;
  chats: Array<{ messages: ChatMessage[]; model: string; tools?: ToolDefinition[] }> = [];
  private queue: Array<(messages: ChatMessage[]) => AIResponse | Error> = [];

  hasApiKey(): boolean { return this.hasKey; }

  play(fn: (messages: ChatMessage[]) => AIResponse | Error): void { this.queue.push(fn); }

  async chat(request: {
    messages: ChatMessage[];
    model: string;
    provider?: string;
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<AIResponse> {
    this.chats.push({ messages: request.messages, model: request.model, tools: request.tools });
    const fn = this.queue.shift();
    if (!fn) throw new Error('ScriptedProvider: no scripted response left');
    const out = fn(request.messages);
    if (out instanceof Error) throw out;
    return out;
  }
}

class FakeRegistry implements LLMProviderRegistryLike {
  constructor(
    private readonly provider: LLMProviderLike,
    private readonly providerId: ProviderId | null = FAKE_PROVIDER,
    private readonly model: string | null = FAKE_MODEL,
  ) {}
  getActiveProvider(): ProviderId | null { return this.providerId; }
  getActiveModel(): string | null { return this.model; }
  getProvider(_id: ProviderId): LLMProviderLike { return this.provider; }
}

interface Harness {
  ctx: BrainTaskContext;
  driver: LLMTaskDriver;
  actions: TaskActionRequest[];
  provider: ScriptedProvider;
}

function makeHarness(options?: {
  respond?: (req: TaskActionRequest) => ActionResult | Promise<ActionResult>;
  maxActionWaitMs?: number;
  maxSteps?: number;
  providerId?: ProviderId | null;
  model?: string | null;
}): Harness {
  const provider = new ScriptedProvider();
  const actions: TaskActionRequest[] = [];
  const respond = options?.respond ?? ((req: TaskActionRequest) => ({
    taskId: req.taskId,
    actionId: req.actionId,
    requestId: req.requestId,
    outcome: 'allowed' as const,
    executed: true,
    replay: false,
    success: true,
    output: 'ok',
  }));
  const ctx: BrainTaskContext = {
    taskId: 'task-1',
    text: 'read the marker file',
    bodyId: 'BLX-BODY-0001',
    bodyName: 'Test Body',
    capabilities: [...BODY_CAPS],
    tools: [FILESYSTEM_DEF],
    update: () => {},
    note: () => {},
    requestAction: async (req) => { actions.push(req); return respond(req); },
    isCancelled: () => false,
  };
  // NB: use explicit undefined checks so callers can pass null (no
  // provider / no model) — `??` would swallow null back to the default.
  const pid: ProviderId | null = options && options.providerId !== undefined ? options.providerId : FAKE_PROVIDER;
  const mdl: string | null = options && options.model !== undefined ? options.model : FAKE_MODEL;
  const registry = new FakeRegistry(provider, pid, mdl);
  const driver = new LLMTaskDriver({
    providers: registry,
    maxSteps: options?.maxSteps ?? 20,
    maxActionWaitMs: options?.maxActionWaitMs ?? 5000,
  });
  return { ctx, driver, actions, provider };
}

describe('LLMTaskDriver', () => {
  it('answers directly when the model needs no tools', async () => {
    const h = makeHarness();
    h.provider.play(() => textResponse('Hello! I do not need any tools.'));
    const outcome = await h.driver.run(h.ctx);
    expect(outcome.kind).toBe('completed');
    expect((outcome as { summary: string }).summary).toBe('Hello! I do not need any tools.');
    expect(h.provider.chats).toHaveLength(1);
    expect(h.actions).toHaveLength(0);
  });

  it('runs a real tool loop: requests the action, feeds the result back, completes', async () => {
    const h = makeHarness();
    // Turn 1: request a filesystem read.
    h.provider.play(() => toolResponse([
      { id: 'call_1', name: 'filesystem', args: { operation: 'read', path: '/tmp/marker' } },
    ]));
    // Turn 2: after seeing the tool result, answer.
    h.provider.play((messages) => {
      const tool = [...messages].reverse().find((m) => m.role === 'tool');
      return textResponse(`Final answer. ${tool?.content ?? '(no tool message)'}`);
    });
    const outcome = await h.driver.run(h.ctx);

    expect(outcome.kind).toBe('completed');
    expect((outcome as { summary: string }).summary).toContain('Final answer.');
    // Exactly one action requested (serial), executed successfully.
    expect(h.actions).toHaveLength(1);
    expect(h.actions[0].action.tool).toBe('filesystem');
    expect(h.actions[0].action.args).toEqual({ operation: 'read', path: '/tmp/marker' });
    expect(h.actions[0].idempotent).toBe(true); // read is safe to replay
    // Two model turns: plan+call, then final answer.
    expect(h.provider.chats).toHaveLength(2);
    // The tool result was fed back into the second call's history.
    const secondCall = h.provider.chats[1].messages;
    expect(secondCall.some((m) => m.role === 'tool' && m.content === 'Tool result (filesystem): ok')).toBe(true);
  });

  it('marks non-idempotent operations so the Body never blindly replays them', async () => {
    const h = makeHarness();
    h.provider.play(() => toolResponse([
      { id: 'call_w', name: 'filesystem', args: { operation: 'write', path: '/tmp/x', content: 'hi' } },
    ]));
    h.provider.play(() => textResponse('written.'));
    const outcome = await h.driver.run(h.ctx);
    expect(outcome.kind).toBe('completed');
    expect(h.actions).toHaveLength(1);
    expect(h.actions[0].idempotent).toBe(false);
  });

  it('passes the body description and tool schemas to the model (never credentials)', async () => {
    const h = makeHarness();
    h.provider.play(() => textResponse('no tools needed'));
    await h.driver.run(h.ctx);
    const first = h.provider.chats[0];
    expect(first.tools).toEqual([FILESYSTEM_DEF]);
    const system = first.messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('CONNECTED BODY: Test Body (BLX-BODY-0001)');
    expect(system.content).toContain('Available actions on this Body: filesystem');
  });

  it('never fakes completion when the model requests a tool the body did not advertise', async () => {
    const h = makeHarness();
    h.provider.play(() => toolResponse([
      { id: 'call_x', name: 'computer-control', args: { action: 'key_press', key: 'x' } },
    ]));
    const outcome = await h.driver.run(h.ctx);
    expect(outcome.kind).toBe('failed');
    const failed = outcome as { error: string; code?: string };
    expect(failed.code).toBe('UNKNOWN_TOOL');
    expect(failed.error).toContain('computer-control');
    expect(h.actions).toHaveLength(0); // nothing was ever executed
    expect(h.provider.chats).toHaveLength(1); // no second "summary" turn
  });

  it('fails honestly when the provider throws', async () => {
    const h = makeHarness();
    h.provider.play(() => { throw new Error('provider exploded (HTTP 503)'); });
    const outcome = await h.driver.run(h.ctx);
    expect(outcome.kind).toBe('failed');
    const failed = outcome as { error: string; code?: string };
    expect(failed.code).toBe('MODEL_ERROR');
    expect(failed.error).toContain('provider exploded');
    expect(h.actions).toHaveLength(0);
  });

  it('fails honestly when no provider is configured (with setup guidance)', async () => {
    const h = makeHarness({ providerId: null, model: null });
    const outcome = await h.driver.run(h.ctx);
    expect(outcome.kind).toBe('failed');
    const failed = outcome as { error: string; code?: string };
    expect(failed.code).toBe('NO_PROVIDER');
    expect(failed.error).toContain('BLAXIN_BRAIN_PROVIDER');
    expect(h.provider.chats).toHaveLength(0);
  });

  it('fails honestly when a provider is selected but no model', async () => {
    const h = makeHarness({ model: null });
    const outcome = await h.driver.run(h.ctx);
    expect(outcome.kind).toBe('failed');
    expect((outcome as { code?: string }).code).toBe('NO_MODEL');
  });

  it('fails honestly when the provider key is missing', async () => {
    const h = makeHarness();
    h.provider.hasKey = false;
    const outcome = await h.driver.run(h.ctx);
    expect(outcome.kind).toBe('failed');
    const failed = outcome as { error: string; code?: string };
    expect(failed.code).toBe('NO_API_KEY');
    expect(failed.error).toContain('No API key');
    expect(h.provider.chats).toHaveLength(0);
  });

  it('does not demand a key from keyless local providers (ollama)', async () => {
    const h = makeHarness();
    h.provider.hasKey = false;
    h.provider.apiKeyRequired = false; // local model, no key needed
    h.provider.play(() => textResponse('ran on the local model'));
    const outcome = await h.driver.run(h.ctx);
    expect(outcome.kind).toBe('completed');
    expect((outcome as { summary: string }).summary).toBe('ran on the local model');
    expect(h.provider.chats).toHaveLength(1); // the call really happened
  });

  it('stops immediately when the user denies an action — never retries, never fakes', async () => {
    const h = makeHarness({
      respond: (req) => ({
        taskId: req.taskId,
        actionId: req.actionId,
        requestId: req.requestId,
        outcome: 'denied' as const,
        executed: false,
        replay: false,
        success: false,
      }),
    });
    h.provider.play(() => toolResponse([
      { id: 'call_1', name: 'filesystem', args: { operation: 'read', path: '/tmp/marker' } },
    ]));
    const outcome = await h.driver.run(h.ctx);
    expect(outcome.kind).toBe('completed');
    const summary = (outcome as { summary: string }).summary;
    expect(summary).toContain('did not approve');
    expect(h.actions).toHaveLength(1); // the denial stopped everything
    expect(h.provider.chats).toHaveLength(1); // no loop after denial
  });

  it('fails honestly when the Body rejects an action on policy grounds', async () => {
    const h = makeHarness({
      respond: (req) => ({
        taskId: req.taskId,
        actionId: req.actionId,
        requestId: req.requestId,
        outcome: 'rejected' as const,
        executed: false,
        replay: false,
        success: false,
        error: 'policy: path outside allowed root',
      }),
    });
    h.provider.play(() => toolResponse([
      { id: 'call_1', name: 'filesystem', args: { operation: 'read', path: '/etc/shadow' } },
    ]));
    const outcome = await h.driver.run(h.ctx);
    expect(outcome.kind).toBe('failed');
    const failed = outcome as { error: string; code?: string };
    expect(failed.code).toBe('REJECTED');
    expect(failed.error).toContain('policy: path outside allowed root');
  });

  it('times out honestly when the Body never responds', async () => {
    const h = makeHarness({
      maxActionWaitMs: 80,
      respond: () => new Promise<ActionResult>(() => {}), // never answers
    });
    h.provider.play(() => toolResponse([
      { id: 'call_1', name: 'filesystem', args: { operation: 'read', path: '/tmp/marker' } },
    ]));
    const outcome = await h.driver.run(h.ctx);
    expect(outcome.kind).toBe('failed');
    const failed = outcome as { error: string; code?: string };
    expect(failed.code).toBe('TIMEOUT');
    expect(failed.error).toContain('did not respond');
  });

  it('stops at the step cap with an honest summary (no fabricated final answer)', async () => {
    const h = makeHarness({ maxSteps: 2 });
    // The model never "finishes": it requests an action every turn.
    h.provider.play(() => toolResponse([
      { id: 'call_a', name: 'filesystem', args: { operation: 'read', path: '/a' } },
    ]));
    h.provider.play(() => toolResponse([
      { id: 'call_b', name: 'filesystem', args: { operation: 'read', path: '/b' } },
    ]));
    const outcome = await h.driver.run(h.ctx);
    expect(outcome.kind).toBe('completed');
    const summary = (outcome as { summary: string }).summary;
    expect(summary).toContain('maximum number of reasoning steps');
    expect(h.actions).toHaveLength(2); // exactly maxSteps actions, then stopped
  });
});
