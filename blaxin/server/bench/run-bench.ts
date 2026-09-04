// BLAXIN Engine Benchmark
// =============================================================
// Repeatable, offline benchmark of the agent engine itself (not the
// model). Uses a scripted fake "brain" with a fixed artificial latency
// so the measured deltas are pure engine overhead:
//
//   1. Direct path   — an unambiguous tool request executed with the
//                      deterministic fast path (zero model calls)
//   2. LLM baseline  — the same request through the classic loop
//   3. Parallel      — one model response carrying 3 independent reads
//   4. Serial        — the same response with parallel execution off
//   5. Engine        — zero-latency model + tools, 3 sequential waves:
//                      every millisecond is pure orchestrator overhead
//   6. Big payloads  — same loop with ~100KB tool outputs (context
//                      budgeting, history bookkeeping at the cap)
//
// Run:  cd server && npm run bench
// =============================================================

import { AgentOrchestrator } from '../src/orchestrator/index.js';
import { FakeProviderRegistry, FakeToolRegistry, FakeSession, FakeMemory, makeConfig, makeToolCall, StubTool, sleep } from '../src/__tests__/helpers/orchestrator-fakes.js';
import { FakeProvider } from '../src/__tests__/helpers/orchestrator-fakes.js';
import { logger } from '../src/utils/logger.js';
import { telemetry, TaskMetrics } from '../src/utils/telemetry.js';

const MODEL_LATENCY_MS = 250;
const TOOL_LATENCY_MS = 120;
const SCREENSHOT_MS = 30;
const WARMUP = 1;
const RUNS = 5;
/** Tool output at/above the context-budget cap (12KB stored). */
const BIG_OUTPUT = 'x'.repeat(100_000);

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface ScenarioResult {
  label: string;
  runs: number[];
  medianMs: number;
  minMs: number;
  /** Telemetry of the last measured run (model/time decomposition). */
  metrics: TaskMetrics | undefined;
}

async function timeRun(fn: () => Promise<void>): Promise<number> {
  const start = Date.now();
  await fn();
  return Date.now() - start;
}

function makeOrchestrator(opts: { fastPath: boolean; parallelTools: boolean; modelLatencyMs: number; toolLatencyMs?: number; eventSink?: boolean; bigOutput?: boolean }) {
  const toolLatencyMs = opts.toolLatencyMs ?? TOOL_LATENCY_MS;
  const providers = new FakeProviderRegistry(opts.modelLatencyMs);
  const tools = new FakeToolRegistry();
  const session = new FakeSession();
  const memory = new FakeMemory();

  const readOutput = opts.bigOutput ? BIG_OUTPUT : undefined;
  tools.register(new StubTool('screenshot', { executionMode: 'serial', latencyMs: SCREENSHOT_MS }));
  tools.register(new StubTool('read-a', { executionMode: 'parallel', latencyMs: toolLatencyMs, output: readOutput ?? 'A' }));
  tools.register(new StubTool('read-b', { executionMode: 'parallel', latencyMs: toolLatencyMs, output: readOutput ?? 'B' }));
  tools.register(new StubTool('read-c', { executionMode: 'parallel', latencyMs: toolLatencyMs, output: readOutput ?? 'C' }));

  const orch = new AgentOrchestrator({
    providers,
    toolRegistry: tools,
    sessionState: session,
    memoryStore: memory,
    getConfig: () => makeConfig({
      enableFastPath: opts.fastPath,
      enableParallelTools: opts.parallelTools,
    }),
  });

  if (opts.eventSink) {
    // Production wires the same sink: JSON.stringify per emitted event
    // (the WebSocket broadcast itself is not measurable offline).
    orch.setEventCallback((event, data) => {
      void JSON.stringify({ event, data });
    });
  }

  return { orch, providers: providers as FakeProviderRegistry, tools };
}

async function runDirectPath(fastPath: boolean): Promise<number> {
  const { orch } = makeOrchestrator({ fastPath, parallelTools: true, modelLatencyMs: MODEL_LATENCY_MS });
  return timeRun(() => orch.processMessage('take a screenshot'));
}

async function runBatch(parallel: boolean): Promise<number> {
  const { orch, providers } = makeOrchestrator({ fastPath: false, parallelTools: parallel, modelLatencyMs: MODEL_LATENCY_MS });
  const provider = providers.getProvider() as FakeProvider;
  provider.script = [{
    toolCalls: [
      makeToolCall('read-a', {}, 0),
      makeToolCall('read-b', {}, 1),
      makeToolCall('read-c', {}, 2),
    ],
  }];
  return timeRun(() => orch.processMessage('read all three files for me'));
}

/** Zero-latency model + tools, 3 sequential single-tool waves. Every
 * millisecond measured here is pure engine cost (message building, wave
 * planning, history bookkeeping, telemetry, event serialization). */
async function runEngineOverhead(bigOutput = false): Promise<number> {
  const { orch, providers } = makeOrchestrator({
    fastPath: false,
    parallelTools: true,
    modelLatencyMs: 0,
    toolLatencyMs: 0,
    eventSink: true, // production-representative event serialization
    bigOutput,
  });
  const provider = providers.getProvider() as FakeProvider;
  provider.script = [
    { toolCalls: [makeToolCall('read-a', {}, 0)] },
    { toolCalls: [makeToolCall('read-b', {}, 1)] },
    { toolCalls: [makeToolCall('read-c', {}, 2)] },
    { content: 'done' },
  ];
  return timeRun(() => orch.processMessage('do three things in sequence'));
}

async function collect(label: string, fn: (mode: boolean) => Promise<number>, mode: boolean, minRuns = RUNS): Promise<ScenarioResult> {
  for (let i = 0; i < WARMUP; i++) await fn(mode);
  const runs: number[] = [];
  for (let i = 0; i < minRuns; i++) runs.push(await fn(mode));
  return {
    label,
    runs,
    medianMs: Math.round(median(runs)),
    minMs: Math.min(...runs),
    metrics: telemetry.latest(1)[0],
  };
}

function fmt(result: ScenarioResult): string {
  const spread = result.runs.map((r) => `${r}ms`).join(', ');
  const m = result.metrics;
  const share = m && m.modelMs > 0
    ? `  (model ${m.modelMs}ms = ${Math.round((m.modelMs / (m.totalMs || 1)) * 100)}% of task time)`
    : '';
  return `${result.label.padEnd(38)} median ${String(result.medianMs).padStart(5)}ms  (runs: ${spread})${share}`;
}

async function main(): Promise<void> {
  // Keep the measured loop quiet: state-transition INFO logs would flood
  // the console and add noise to timing on slow terminals.
  logger.setLevel('error');

  console.log('\nBLAXIN engine benchmark — scripted brain latency: model=250ms, tool=120ms');
  console.log('='.repeat(78));

  const directPath = await collect('1. Direct path (screenshot, no LLM)', runDirectPath, true);
  const llmPath = await collect('2. LLM loop baseline (same request)', runDirectPath, false);
  const parallelBatch = await collect('3. 3 reads — parallel waves', runBatch, true);
  const serialBatch = await collect('4. 3 reads — serial (parallel off)', runBatch, false);
  const engineOverhead = await collect('5. Engine overhead (3 waves, 0 latency)', async () => runEngineOverhead(false), true);
  const bigPayload = await collect('6. Engine w/ 100KB tool outputs (3 waves)', async () => runEngineOverhead(true), true);

  console.log(fmt(directPath));
  console.log(fmt(llmPath));
  console.log(fmt(parallelBatch));
  console.log(fmt(serialBatch));
  console.log(fmt(engineOverhead));
  console.log(fmt(bigPayload));

  const perWaveMs = engineOverhead.medianMs / 4; // 4 loop iterations (3 tool waves + final answer)
  const bigPerWaveMs = bigPayload.medianMs / 4;
  console.log(`\nEngine overhead breakdown: ${engineOverhead.medianMs}ms across 4 loop iterations ≈ ${perWaveMs.toFixed(1)}ms per iteration (${bigPayload.medianMs}ms with 100KB outputs ≈ ${bigPerWaveMs.toFixed(1)}ms/iteration)`);

  console.log('\n' + '='.repeat(78));
  console.log('Speedups (median):');
  console.log(`  Fast path vs LLM loop      ${(llmPath.medianMs / directPath.medianMs).toFixed(1)}x faster  (${llmPath.medianMs}ms -> ${directPath.medianMs}ms, ${Math.round((1 - directPath.medianMs / llmPath.medianMs) * 100)}% reduction)`);
  console.log(`  Parallel batch vs serial    ${(serialBatch.medianMs / parallelBatch.medianMs).toFixed(1)}x faster  (${serialBatch.medianMs}ms -> ${parallelBatch.medianMs}ms, ${Math.round((1 - parallelBatch.medianMs / serialBatch.medianMs) * 100)}% reduction)`);

  // Guard rails: fail loudly when the architecture regresses.
  const failures: string[] = [];
  if (directPath.medianMs >= llmPath.medianMs / 2) {
    failures.push('fast path is not significantly faster than the LLM loop');
  }
  if (parallelBatch.medianMs >= serialBatch.medianMs * 0.85) {
    failures.push('parallel execution is not significantly faster than serial');
  }
  // Pure orchestrator cost must stay small: 3 zero-latency waves plus the
  // closing model turn should finish well under 10ms per iteration.
  if (perWaveMs >= 10) {
    failures.push(`engine overhead too high (${engineOverhead.medianMs}ms for 3 zero-latency waves, ${perWaveMs.toFixed(1)}ms/iteration)`);
  }
  if (bigPerWaveMs >= 25) {
    failures.push(`engine overhead too high with large payloads (${bigPayload.medianMs}ms for 3 zero-latency waves, ${bigPerWaveMs.toFixed(1)}ms/iteration)`);
  }
  if (failures.length > 0) {
    console.error('\nBENCHMARK FAILED: ' + failures.join('; '));
    process.exit(1);
  }
  console.log('\nBenchmark passed all guard rails.');
  await sleep(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});