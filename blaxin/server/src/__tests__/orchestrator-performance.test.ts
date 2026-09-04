import { describe, it, expect, beforeEach } from 'vitest';
import { AgentOrchestrator } from '../orchestrator/index.js';
import { telemetry } from '../utils/telemetry.js';
import {
  buildFakes, FakeProvider, FakeToolRegistry, makeToolCall, sleep,
  StubTool,
} from './helpers/orchestrator-fakes.js';
import { ToolResult } from '../types.js';

interface Ev { event: string; data: any }

function makeOrchestrator(fakes: ReturnType<typeof buildFakes>, events?: Ev[]) {
  const orch = new AgentOrchestrator({
    providers: fakes.providers,
    toolRegistry: fakes.tools,
    sessionState: fakes.session,
    memoryStore: fakes.memory,
    getConfig: () => fakes.config,
  });
  if (events) {
    orch.setEventCallback((event, data) => events.push({ event, data }));
  }
  return orch;
}

async function respondToNextConfirmation(
  orch: AgentOrchestrator,
  events: Ev[],
  approved: boolean,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const ev = events.find((e) => e.event === 'confirmation-required');
    if (ev) {
      orch.respondToConfirmation(ev.data.stepId, approved);
      return;
    }
    await sleep(10);
  }
  throw new Error('No confirmation-required event was emitted');
}

beforeEach(() => {
  telemetry.reset();
});

describe('deterministic fast path', () => {
  it('executes a screenshot request with ZERO model calls', async () => {
    const fakes = buildFakes({ providerLatencyMs: 200 });
    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);
    const start = Date.now();

    await orch.processMessage('take a screenshot');

    const elapsed = Date.now() - start;
    expect((fakes.providers.getProvider() as FakeProvider).calls).toBe(0); // never contacted the brain
    expect(elapsed).toBeLessThan(200); // far below the fake provider's own latency
    expect(orch.getState()).toBe('completed');

    const history = orch.getConversationHistory();
    const roles = history.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(history[3].content).toContain('Done');
    // task-complete telemetry recorded as 'direct'
    const last = telemetry.latest(1)[0];
    expect(last.kind).toBe('direct');
    expect(last.modelCalls).toBe(0);
  });

  it('completes without a configured provider or model', async () => {
    const fakes = buildFakes();
    fakes.providers.activeProvider = null as never;
    fakes.providers.activeModel = null as never;
    const orch = makeOrchestrator(fakes);
    await orch.processMessage('screenshot');
    expect(orch.getState()).toBe('completed');
    expect(orch.getConversationHistory().at(-1)?.content).toContain('Done');
  });

  it('records LLM attempts that fail before any model call (no provider)', async () => {
    const fakes = buildFakes();
    fakes.providers.activeProvider = null as never;
    fakes.providers.activeModel = null as never;
    const orch = makeOrchestrator(fakes);

    // Not a direct-action request: falls through to the LLM loop, which
    // has no provider to talk to. The failed attempt must still appear in
    // telemetry so the metrics UI can count it as an issue.
    await orch.processMessage('help me plan my week');

    expect((fakes.providers.getProvider() as FakeProvider).calls).toBe(0);
    const last = telemetry.latest(1)[0];
    expect(last.kind).toBe('llm');
    expect(last.result).toBe('no-provider');
    expect(last.modelCalls).toBe(0);
  });

  it('can be disabled via config, falling back to the LLM loop', async () => {
    const fakes = buildFakes({ providerLatencyMs: 0, fastPath: false });
    const orch = makeOrchestrator(fakes);
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script = [{ content: 'Here you go.' }];

    await orch.processMessage('take a screenshot');

    expect(provider.calls).toBe(1);
    expect(orch.getState()).toBe('completed');
  });

  it('denied direct actions complete without a model call and never execute', async () => {
    const fakes = buildFakes({ providerLatencyMs: 100 });
    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);
    const provider = fakes.providers.getProvider() as FakeProvider;
    fakes.browser.calls = 0;

    const run = orch.processMessage('open https://example.com');
    await respondToNextConfirmation(orch, events, false);
    await run;

    expect(provider.calls).toBe(0);
    expect(fakes.browser.calls).toBe(0); // denied => never executed
    expect(orch.getState()).toBe('completed');
    const last = orch.getConversationHistory().at(-1)?.content || '';
    expect(last.toLowerCase()).toContain('permission');
    expect(telemetry.latest(1)[0]?.result).toBe('denied');
  });

  it('approved direct actions run through the standard confirmation gate', async () => {
    const fakes = buildFakes({ providerLatencyMs: 100 });
    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);
    fakes.browser.output = 'Opened URL: https://example.com';

    const run = orch.processMessage('open example.com');
    await respondToNextConfirmation(orch, events, true);
    await run;

    expect(fakes.browser.calls).toBe(1);
    expect(orch.getState()).toBe('completed');
    expect(orch.getConversationHistory().at(-1)?.content).toContain('Opened');
  });

  it('rolls back and falls back to the LLM loop when the direct tool fails', async () => {
    const fakes = buildFakes({ providerLatencyMs: 0 });
    const orch = makeOrchestrator(fakes);
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script = [{ content: 'I could not take the screenshot — scrot is missing.' }];

    // Make the screenshot stub fail.
    const tools = fakes.tools as FakeToolRegistry;
    const screenshot = tools.getTool('screenshot') as StubTool;
    screenshot.fail = true;

    await orch.processMessage('take a screenshot');

    // LLM loop was used to recover, and the failed direct attempt was
    // rolled back: exactly one user message remains in history.
    expect(provider.calls).toBe(1);
    const userMsgs = orch.getConversationHistory().filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(orch.getState()).toBe('completed');
    expect(telemetry.latest(1)[0]?.kind).toBe('llm');
  });
});

describe('dependency-aware parallel tool execution', () => {
  /** Three parallel-capable read tools that log their active windows. */
  function readTools(fakes: ReturnType<typeof buildFakes>) {
    const intervals: Array<{ name: string; start: number; end: number }> = [];
    for (const name of ['read-a', 'read-b', 'read-c']) {
      const tool = new StubTool(name, {
        executionMode: 'parallel',
        latencyMs: 80,
        output: 'stub',
      });
      tool.execute = async () => {
        const start = Date.now();
        await sleep(80);
        intervals.push({ name, start, end: Date.now() });
        return { success: true, output: name.toUpperCase(), data: {} } as ToolResult;
      };
      (fakes.tools as FakeToolRegistry).register(tool);
    }
    return intervals;
  }

  it('runs independent reads concurrently and settles history in call order', async () => {
    const fakes = buildFakes({ providerLatencyMs: 20 });
    const intervals = readTools(fakes);
    const orch = makeOrchestrator(fakes);
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script = [{
      toolCalls: [
        makeToolCall('read-a', {}, 0),
        makeToolCall('read-b', {}, 1),
        makeToolCall('read-c', {}, 2),
      ],
    }];

    const start = Date.now();
    await orch.processMessage('read those three files');
    const total = Date.now() - start;

    // Serial would take 20 + 3*80 ≈ 260ms; parallel ≈ 100ms.
    expect(total).toBeLessThan(220);
    // The three reads overlapped: all started within ~40ms of each other.
    const starts = intervals.map((i) => i.start);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(40);

    // History results settle in the original call order (A, B, C).
    const toolMsgs = orch.getConversationHistory().filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.content)).toEqual([
      expect.stringContaining('A'),
      expect.stringContaining('B'),
      expect.stringContaining('C'),
    ]);
    expect(telemetry.latest(1)[0]?.parallelWaves).toBe(1);
  });

  it('serializes when parallel execution is disabled', async () => {
    const fakes = buildFakes({ providerLatencyMs: 20, parallelTools: false });
    const intervals = readTools(fakes);
    const orch = makeOrchestrator(fakes);
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script = [{
      toolCalls: [
        makeToolCall('read-a', {}, 0),
        makeToolCall('read-b', {}, 1),
        makeToolCall('read-c', {}, 2),
      ],
    }];

    const start = Date.now();
    await orch.processMessage('read those three files');
    const total = Date.now() - start;

    expect(total).toBeGreaterThanOrEqual(240); // strictly sequential
    const starts = intervals.map((i) => i.start);
    expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThanOrEqual(150);
  });

  it('keeps serial (exclusive) tools in their own waves and preserves order', async () => {
    const fakes = buildFakes({ providerLatencyMs: 20 });
    const intervals = readTools(fakes);
    const screenshot = new StubTool('screenshot', { executionMode: 'serial', latencyMs: 40, output: 'shot' });
    (fakes.tools as FakeToolRegistry).register(screenshot);
    const orch = makeOrchestrator(fakes);
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script = [{
      toolCalls: [
        makeToolCall('read-a', {}, 0),
        makeToolCall('screenshot', {}, 1),
        makeToolCall('read-b', {}, 2),
      ],
    }];

    await orch.processMessage('look at these things');

    // The screenshot (serial tool) sits between two parallel-capable reads,
    // so execution must be three solo waves — the reads never overlap the
    // screenshot and never overlap each other.
    expect(intervals.length).toBe(2); // read-a and read-b both ran
    const starts = intervals.map((i) => i.start);
    expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThanOrEqual(100);
    const toolMsgs = orch.getConversationHistory().filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.content)).toEqual([
      expect.stringContaining('A'),
      expect.stringContaining('shot'),
      expect.stringContaining('B'),
    ]);
    // Three solo waves (read / screenshot / read): the serial tool never
    // shares a wave with the parallel reads.
    expect(telemetry.latest(1)[0]?.waves).toBeGreaterThanOrEqual(3);
    expect(telemetry.latest(1)[0]?.parallelWaves).toBe(0);
  });
});

describe('context budget (history bound)', () => {
  it('caps oversized tool outputs stored in history', async () => {
    const fakes = buildFakes({ providerLatencyMs: 0 });
    const orch = makeOrchestrator(fakes);
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script = [{
      toolCalls: [makeToolCall('filesystem', { operation: 'read', path: '/big' }, 0)],
    }];

    const big = 'x'.repeat(100_000);
    const fsTool = (fakes.tools as FakeToolRegistry).getTool('filesystem') as StubTool;
    fsTool.execute = async () => ({ success: true, output: big, data: {} });

    await orch.processMessage('read that big file');

    const toolMsgs = orch.getConversationHistory().filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content.length).toBeLessThan(13000);
    expect(toolMsgs[0].content).toContain('truncated');
  });

  it('keeps small outputs intact', async () => {
    const fakes = buildFakes({ providerLatencyMs: 0 });
    const orch = makeOrchestrator(fakes);
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script = [{ toolCalls: [makeToolCall('search', { query: 'x' }, 0)] }];
    const searchTool = (fakes.tools as FakeToolRegistry).getTool('search') as StubTool;
    searchTool.execute = async () => ({ success: true, output: 'small result', data: {} });

    await orch.processMessage('gather some info');

    const toolMsgs = orch.getConversationHistory().filter((m) => m.role === 'tool');
    expect(toolMsgs[0].content).toBe('Tool result (search): small result');
  });
});

describe('queue behavior', () => {
  it('runs queued tasks after the active task finishes, without re-entrancy', async () => {
    const fakes = buildFakes({ providerLatencyMs: 0 });
    const orch = makeOrchestrator(fakes);
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script = [
      { content: 'first done' },
      { content: 'second done' },
    ];

    const p1 = orch.processMessage('first task');
    const p2 = orch.processMessage('second task');
    await Promise.all([p1, p2]);

    const contents = orch.getConversationHistory()
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content);
    expect(contents).toEqual(['first done', 'second done']);
    expect(provider.calls).toBe(2);
  });
});
