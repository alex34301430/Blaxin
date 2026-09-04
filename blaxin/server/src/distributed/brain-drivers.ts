// BLAXIN brain task drivers
// =============================================================
// A task driver is the Brain's "reasoning core" for one task. It
// receives a user request (forwarded by the Body) and drives the task
// to completion by REQUESTING structured actions from the Body and
// consuming the structured results. Drivers never execute anything
// locally — every action crosses the capability/policy boundary on the
// Body.
//
//   llm          — real provider loop (the production driver). Reuses the
//                  provider registry the Brain owns; the Body's tool
//                  schemas (advertised during capability exchange) are
//                  offered to the model.
//   deterministic— executes a fixed, JSON-configured action sequence and
//                  verifies each result. Used by the distributed E2E
//                  test and scripted runs; it is real end-to-end
//                  execution (full policy gate on the Body), not a mock.
// =============================================================

import { v4 as uuidv4 } from 'uuid';
import {
  ActionResult, CapabilitySet, TaskActionRequest,
} from './types.js';
import { ToolDefinition, ProviderId, ChatMessage, AIResponse, ToolCall } from '../types.js';
import { logger } from '../utils/logger.js';
import { budgetToolResultOutput } from '../utils/context-budget.js';

export type DriverOutcome =
  | { kind: 'completed'; summary: string }
  | { kind: 'failed'; error: string; code?: string };

/** Everything a driver may do to/with its Body during a task. */
export interface BrainTaskContext {
  taskId: string;
  /** The user's request text (forwarded by the Body). */
  text: string;
  bodyId: string;
  bodyName: string;
  capabilities: CapabilitySet;
  /** Tool schemas advertised by the Body (validated against caps). */
  tools: ToolDefinition[];
  /** Emit a progress update to the Body (maps to agent-state on the UI). */
  update(state: string, description?: string): void;
  /** Request one structured action; resolves with the Body's verdict. */
  requestAction(req: TaskActionRequest): Promise<ActionResult>;
  /** Record an activity note for observability (not sent to the Body). */
  note(component: string, message: string): void;
}

export interface BrainTaskDriver {
  id: string;
  name: string;
  run(ctx: BrainTaskContext): Promise<DriverOutcome>;
}

// ── Deterministic driver (tests / scripted runs) ───────────────

export interface DeterministicStep {
  tool: string;
  args: Record<string, unknown>;
  description: string;
  idempotent?: boolean;
}

export interface DeterministicDriverOptions {
  steps: DeterministicStep[];
  maxActionWaitMs?: number;
}

export class DeterministicDriver implements BrainTaskDriver {
  readonly id = 'deterministic';
  readonly name = 'Deterministic test driver';

  constructor(private readonly options: DeterministicDriverOptions) {}

  async run(ctx: BrainTaskContext): Promise<DriverOutcome> {
    const summary: string[] = [];
    for (const step of this.options.steps) {
      if (!ctx.tools.some((t) => t.function.name === step.tool)) {
        return { kind: 'failed', error: `Body does not offer tool "${step.tool}"`, code: 'UNSUPPORTED_CAPABILITY' };
      }
      ctx.update('executing', step.description);
      const actionId = uuidv4();
      const result = await ctx.requestAction({
        taskId: ctx.taskId,
        actionId,
        requestId: actionId,
        action: { tool: step.tool, args: step.args },
        idempotent: step.idempotent !== false,
        description: step.description,
      });
      if (result.outcome === 'denied') {
        return { kind: 'failed', error: `Action denied by the user: ${step.description}`, code: 'DENIED' };
      }
      if (result.outcome === 'rejected') {
        return { kind: 'failed', error: result.error || 'Action rejected by the Body', code: 'REJECTED' };
      }
      if (!result.success) {
        return { kind: 'failed', error: result.error || `Action failed: ${step.description}`, code: 'ACTION_FAILED' };
      }
      summary.push(`${step.description}: ${(result.output || '').slice(0, 300)}`);
    }
    return { kind: 'completed', summary: summary.join('\n') };
  }
}

// ── LLM driver (production reasoning) ───────────────────────────

/** Structural provider surface the LLM driver needs (injectable). */
export interface LLMProviderLike {
  id: string;
  name: string;
  hasApiKey(): boolean;
  chat(request: {
    messages: ChatMessage[];
    model: string;
    provider?: string;
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<AIResponse>;
}

export interface LLMProviderRegistryLike {
  getActiveProvider(): ProviderId | null;
  getActiveModel(): string | null;
  getProvider(id: ProviderId): LLMProviderLike;
}

export interface LLMDriverOptions {
  providers: LLMProviderRegistryLike;
  maxSteps?: number;
  maxActionWaitMs?: number;
}

const BRAIN_SYSTEM_PROMPT = `You are the BLAXIN BRAIN — the fixed external intelligence of a BLAXIN AI agent.

A BLAXIN BODY (a separate device) is connected to you and can execute actions on the user's computer. You NEVER execute actions yourself: you reason, plan, and REQUEST structured actions, then analyze the results the Body returns.

RULES:
1. ANALYZE the user's request, PLAN a small number of clear steps.
2. Request ONE action at a time using the provided tools; wait for its result before continuing.
3. The Body enforces its own security policy: it may deny an action or ask the user for approval. Respect denials — never retry a denied action.
4. VERIFY important outcomes. If a tool reports failure, analyze why and try a safe alternative.
5. Never ask for or mention API keys, tokens, or credentials.
6. Never claim you ran a command yourself — you requested it from the Body.
7. When the user's request is fully handled (or you hit a hard limit), reply with a concise final answer to the user.`;

const MAX_CONFIRMATION_WAIT_MS = 120 * 1000;

export class LLMTaskDriver implements BrainTaskDriver {
  readonly id = 'llm';
  readonly name = 'LLM reasoning driver';

  private readonly maxSteps: number;
  private readonly maxActionWaitMs: number;

  constructor(private readonly options: LLMDriverOptions) {
    this.maxSteps = options.maxSteps ?? 20;
    this.maxActionWaitMs = options.maxActionWaitMs ?? MAX_CONFIRMATION_WAIT_MS;
  }

  async run(ctx: BrainTaskContext): Promise<DriverOutcome> {
    const providerId = this.options.providers.getActiveProvider();
    const modelId = this.options.providers.getActiveModel();
    if (!providerId || !modelId) {
      return { kind: 'failed', error: 'No AI provider or model configured on the Brain. Configure a provider in Brain settings.', code: 'NO_PROVIDER' };
    }
    const provider = this.options.providers.getProvider(providerId);
    if (!provider.hasApiKey()) {
      return { kind: 'failed', error: `No API key configured for ${provider.name} on the Brain.`, code: 'NO_API_KEY' };
    }

    const history: ChatMessage[] = [
      {
        id: uuidv4(),
        role: 'user',
        content: ctx.text,
        timestamp: Date.now(),
      },
    ];

    for (let step = 1; step <= this.maxSteps; step++) {
      ctx.update('thinking', `Thinking (step ${step})…`);

      let response: AIResponse;
      try {
        response = await provider.chat({
          messages: [
            {
              id: 'system',
              role: 'system',
              content: BRAIN_SYSTEM_PROMPT + this.describeBody(ctx),
              timestamp: Date.now(),
            },
            ...history,
          ],
          model: modelId,
          provider: providerId,
          tools: ctx.tools.length > 0 ? ctx.tools : undefined,
          maxTokens: 4096,
          temperature: 0.7,
        });
      } catch (error: any) {
        return { kind: 'failed', error: `Model error: ${error.message}`, code: 'MODEL_ERROR' };
      }

      const calls = (response.toolCalls || []).filter((tc) =>
        ctx.tools.some((t) => t.function.name === tc.function.name),
      );

      if (calls.length === 0) {
        // Final answer.
        return { kind: 'completed', summary: response.message.content || 'Done.' };
      }

      // Record the assistant turn (with its calls) for replay semantics.
      history.push({
        id: uuidv4(),
        role: 'assistant',
        content: response.message.content || '',
        timestamp: Date.now(),
        toolCalls: calls,
      });

      // Execute serially: Body-side policy + confirmation gates must not
      // overlap, matching the local orchestrator's serial-mode rules.
      for (const call of calls) {
        const actionId = `${call.id}_${ctx.taskId.slice(0, 8)}`;
        const args = this.parseArgs(call);
        const actionResult = await ctx.requestAction({
          taskId: ctx.taskId,
          actionId,
          requestId: actionId,
          action: { tool: call.function.name, args },
          idempotent: this.isIdempotent(call.function.name, args),
          description: this.describeCall(call.function.name, args),
        });
        const toolText = this.actionResultToText(actionResult, call.function.name);
        history.push({
          id: uuidv4(),
          role: 'tool',
          content: toolText,
          timestamp: Date.now(),
          toolCallId: call.id,
          name: call.function.name,
        });
        if (actionResult.outcome === 'denied') {
          return {
            kind: 'completed',
            summary: `The user did not approve ${call.function.name}, so I stopped. ${response.message.content || ''}`.trim(),
          };
        }
        if (actionResult.outcome === 'rejected') {
          return { kind: 'failed', error: `Body rejected the action: ${actionResult.error || 'policy violation'}`, code: 'REJECTED' };
        }
        if (!actionResult.success) {
          // Tool failed — let the model diagnose and adapt next iteration.
          logger.info('brain', `Action ${call.function.name} failed: ${(actionResult.error || '').slice(0, 200)}`);
        }
      }
    }

    return {
      kind: 'completed',
      summary: 'I reached the maximum number of reasoning steps for this task. Here is a summary of what was accomplished.',
    };
  }

  private describeBody(ctx: BrainTaskContext): string {
    if (ctx.tools.length === 0) return '';
    const names = ctx.tools.map((t) => t.function.name).join(', ');
    return `\n\nCONNECTED BODY: ${ctx.bodyName} (${ctx.bodyId}) with capabilities: ${ctx.capabilities.join(', ')}.\nAvailable actions on this Body: ${names}.`;
  }

  private parseArgs(call: ToolCall): Record<string, unknown> {
    try {
      const parsed = JSON.parse(call.function.arguments || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Reads are idempotent; writes/delete/launch are not — the Body also
   * enforces its own replay policy, this is only a hint. */
  private isIdempotent(tool: string, args: Record<string, unknown>): boolean {
    if (tool === 'filesystem') {
      const op = args.operation;
      return op === 'read' || op === 'list' || op === 'exists' || op === 'info';
    }
    if (tool === 'system-info' || tool === 'search' || tool === 'clipboard') return true;
    if (tool === 'screenshot') return true;
    return false;
  }

  private describeCall(tool: string, args: Record<string, unknown>): string {
    if (tool === 'terminal') return `Run: ${String(args.command || '').slice(0, 120)}`;
    if (tool === 'filesystem') return `${args.operation} ${String(args.path || '')}`;
    return `${tool} ${JSON.stringify(args).slice(0, 120)}`;
  }

  private actionResultToText(result: ActionResult, tool: string): string {
    if (result.outcome === 'denied') {
      return `Tool result (${tool}): The user denied permission for this action. Do not retry it; explain what was blocked and offer alternatives.`;
    }
    if (result.outcome === 'rejected') {
      return `Tool error (${tool}): the Body rejected this action (${result.error || 'policy violation'}). Do not retry it.`;
    }
    if (result.success) {
      return `Tool result (${tool}): ${budgetToolResultOutput(result.output || '')}`;
    }
    return `Tool error (${tool}): ${budgetToolResultOutput(result.error || 'Unknown error')}`;
  }
}
