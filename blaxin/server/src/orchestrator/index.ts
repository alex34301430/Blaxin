import { v4 as uuidv4 } from 'uuid';
import {
  ChatMessage, AgentState, AgentTask, TaskStep, AIResponse, ToolCall,
  ProviderId, AppConfig, ToolResult, Tool, ToolDefinition,
} from '../types.js';
import { providers, AIProvider, ProviderError } from '../providers/index.js';
import { toolRegistry } from '../tools/index.js';
import { logger } from '../utils/logger.js';
import { getConfig, matchesAnyPattern } from '../utils/config.js';
import { sessionState } from '../utils/session-state.js';
import { memoryStore, MemoryType } from '../utils/memory.js';
import { classifyDirect, DirectAction } from '../router/direct.js';
import {
  budgetToolResultOutput, budgetAssistantMessage,
} from '../utils/context-budget.js';
import { telemetry, TaskMetrics } from '../utils/telemetry.js';

type EventCallback = (event: string, data: any) => void;

// ── Injectable Dependencies ─────────────────────────────────────
// The orchestrator talks to providers, tools, session state and memory
// through narrow structural interfaces. Tests and benchmarks inject
// fakes; the singletons are the defaults. This keeps the agent engine
// (body) independent of any concrete AI brain/provider implementation.

export interface ProviderRegistryLike {
  getActiveProvider(): ProviderId | null;
  getActiveModel(): string | null;
  getProvider(id: ProviderId): AIProvider;
  getFallbackProvider(failedProviderId: ProviderId): AIProvider | null;
  getFallbackModel(providerId: ProviderId): string | null;
}

export interface ToolRegistryLike {
  getToolDefinitions(): ToolDefinition[];
  getTool(name: string): Tool | undefined;
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  requiresConfirmation(name: string, args: Record<string, unknown>): boolean;
  getExecutionMode(name: string): 'parallel' | 'serial';
}

/** Loose persisted-message shape (the session file stores a subset). */
export interface ChatMessageLike {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  toolCallId?: string;
  name?: string;
}

export interface SessionStateLike {
  addMessage(message: ChatMessage): void;
  getHistory(): ChatMessageLike[];
  setHistory(history: ChatMessage[]): void;
  clearHistory(): void;
}

export interface MemoryStoreLike {
  add(type: MemoryType, content: string, options?: { source?: 'user' | 'agent' | 'system'; scope?: string }): unknown;
}

export interface OrchestratorDeps {
  providers: ProviderRegistryLike;
  toolRegistry: ToolRegistryLike;
  sessionState: SessionStateLike;
  memoryStore: MemoryStoreLike;
  getConfig: () => AppConfig;
}

const SYSTEM_PROMPT = `You are BLAXIN, an advanced AI desktop agent running on Linux. You can control the computer, execute terminal commands, manage files, browse the web, and complete complex multi-step tasks.

CAPABILITIES:
- Execute terminal/shell commands
- Read, write, create, delete, and manage files/directories
- Control the desktop GUI: mouse clicks, keyboard input, window management
- Take screenshots to observe the screen state
- Open and interact with web browsers
- Search the web for information
- Read/write the system clipboard
- Get system information (CPU, memory, disk, network)
- Launch and manage applications

BEHAVIOR:
1. ANALYZE the request before acting. Understand what the user wants.
2. PLAN your approach: break complex tasks into clear, sequential steps.
3. EXECUTE one tool action at a time.
4. OBSERVE the result of each tool call before proceeding.
5. VERIFY important outcomes (e.g., after writing a file, confirm it was written).
6. If an action fails, diagnose the failure and try a safe alternative.
7. For destructive operations (delete, overwrite), confirm with the user first.
8. Report progress clearly and concisely at each step.
9. Never expose API keys, secrets, or sensitive system information.
10. When a task is complete, provide a clear summary of what was done.

ERROR RECOVERY:
- If a tool fails, analyze WHY it failed before retrying
- For network errors: check connectivity, try again after a brief pause
- For permission errors: explain what permission is needed
- For missing tools: suggest installing the required tool
- For file not found: check the path, list the directory to find the correct file
- Never retry the exact same failed action more than once without changing approach
- If recovery is impossible, explain the limitation clearly

VERIFICATION:
- After launching an application, take a screenshot to confirm it opened
- After clicking a button/UI element, verify the expected change occurred
- After writing a file, verify the content was written correctly
- After running a command, check the exit code and output for errors
- After installing software, verify the installation succeeded

When using tools:
1. Think about which tool is needed and why
2. Provide the correct arguments with proper formatting
3. Wait for the tool result
4. Analyze the result - did it succeed? If not, why?
5. Decide the next step based on the result
6. Verify the outcome before moving on

Always provide a clear final answer when the task is complete.`;

// ── Execution State ─────────────────────────────────────────────

interface ExecutionStep {
  id: string;
  description: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  state: 'pending' | 'executing' | 'completed' | 'failed' | 'skipped' | 'retrying';
  result?: string;
  error?: string;
  attempts: number;
  startTime?: number;
  endTime?: number;
}

interface TaskPlan {
  id: string;
  objective: string;
  steps: ExecutionStep[];
  currentStepIndex: number;
  state: 'planning' | 'executing' | 'observing' | 'completed' | 'failed';
  startTime: number;
  endTime?: number;
  verificationRequired: boolean;
}

/** A tool call prepared for execution (steps are registered up front so
 * ordering is deterministic even when the calls run concurrently). */
interface PendingCall {
  call: ToolCall;
  args: Record<string, unknown>;
  step: ExecutionStep;
}

type ToolOutcome = 'proceed' | 'denied';

// ── Orchestrator ────────────────────────────────────────────────

export class AgentOrchestrator {
  private conversationHistory: ChatMessage[] = [];
  private currentTask: AgentTask | null = null;
  private currentPlan: TaskPlan | null = null;
  private state: AgentState = 'idle';
  private lastDescription: string | null = null;
  private eventCallback: EventCallback | null = null;
  private stepCount = 0;
  private consecutiveErrors = 0;
  private readonly MAX_CONSECUTIVE_ERRORS = 3;
  private readonly MAX_RETRIES_PER_STEP = 2;
  private readonly MAX_PARALLEL_TOOLS = 6;

  // Concurrency: only one agent task executes at a time. Additional
  // messages queue and run sequentially after the active task finishes.
  private busy = false;
  private pendingQueue: string[] = [];
  private readonly MAX_QUEUE_SIZE = 10;

  // Cancellation: stop() is honored at loop boundaries and aborts
  // any pending confirmation request.
  private stopRequested = false;

  // Confirmation gate: high-impact tool calls wait for user approval.
  private pendingConfirmations = new Map<string, (approved: boolean) => void>();
  private readonly CONFIRMATION_TIMEOUT_MS = 120000;

  // Loop detection: N consecutive identical successful tool actions
  // indicate the agent is stuck repeating itself.
  private repeatedActionCount = 0;
  private lastActionFingerprint = '';
  private loopAbortReason: string | null = null;
  private readonly MAX_REPEATED_ACTIONS = 3;

  // ── Per-run performance bookkeeping ──────────────────────────
  private runMetrics: {
    startedAt: number;
    queueWaitMs: number;
    kind: 'direct' | 'llm';
    modelCalls: number;
    modelMs: number;
    waves: number;
    parallelWaves: number;
    outcome: TaskMetrics['result'];
  } | null = null;

  constructor(private readonly deps: Partial<OrchestratorDeps> = {}) {
    // Restore conversation history from persisted state
    const savedHistory = this.session.getHistory();
    if (savedHistory.length > 0) {
      this.conversationHistory = savedHistory as ChatMessage[];
      logger.info('orchestrator', `Restored ${savedHistory.length} messages from session state`);
    }
  }

  // Dependency accessors (defaults to the production singletons).
  private get providers(): ProviderRegistryLike {
    return this.deps.providers ?? providers;
  }
  private get toolRegistry(): ToolRegistryLike {
    return this.deps.toolRegistry ?? toolRegistry;
  }
  private get session(): SessionStateLike {
    return this.deps.sessionState ?? sessionState;
  }
  private get memory(): MemoryStoreLike {
    return this.deps.memoryStore ?? memoryStore;
  }
  private configOf(): AppConfig {
    return this.deps.getConfig ? this.deps.getConfig() : getConfig();
  }

  setEventCallback(callback: EventCallback): void {
    this.eventCallback = callback;
  }

  private emit(event: string, data: any): void {
    if (this.eventCallback) {
      this.eventCallback(event, data);
    }
  }

  private setState(state: AgentState, description?: string): void {
    this.state = state;
    this.lastDescription = description ?? null;
    this.emit('agent-state', { state, description });
    logger.info('orchestrator', `State: ${state}${description ? ` - ${description}` : ''}`);
  }

  /** Latest human-readable state description (for reconnect payloads). */
  getCurrentDescription(): string | null {
    return this.lastDescription;
  }

  /**
   * Public entry point. Queues the message when another task is already
   * running so concurrent requests can never interleave shared state.
   */
  async processMessage(userMessage: string): Promise<void> {
    const queuedAt = Date.now();
    let queueWaitMs = 0;

    if (this.busy) {
      if (this.pendingQueue.length >= this.MAX_QUEUE_SIZE) {
        this.emit('error', {
          message: 'The task queue is full. Stop the current task or wait for it to finish.',
          code: 'QUEUE_FULL',
        });
        return;
      }
      this.pendingQueue.push(userMessage);
      this.emit('agent-state', {
        state: 'waiting',
        description: `Queued behind the current task (${this.pendingQueue.length} in queue)`,
      });
      return;
    }

    this.busy = true;
    try {
      queueWaitMs = Date.now() - queuedAt;
      this.runMetrics = {
        startedAt: Date.now(),
        queueWaitMs,
        kind: 'llm',
        modelCalls: 0,
        modelMs: 0,
        waves: 0,
        parallelWaves: 0,
        outcome: 'completed',
      };
      await this.runTask(userMessage);
    } finally {
      this.busy = false;
      this.stopRequested = false;
      this.runMetrics = null;
    }

    // Run anything that queued while this task was active. Called directly
    // (no setTimeout hop) — processMessage's busy guard makes re-entry safe.
    const next = this.pendingQueue.shift();
    if (next !== undefined) {
      this.setState('waiting', 'Starting next queued task...');
      await this.processMessage(next);
    }
  }

  /** True when a task (or queued work) is pending. */
  isBusy(): boolean {
    return this.busy || this.pendingQueue.length > 0;
  }

  /**
   * Respond to a confirmation request from the agent UI.
   * Approval grants one high-impact tool execution; denial skips it.
   */
  respondToConfirmation(stepId: string | undefined, approved: boolean): void {
    if (!stepId) {
      // Deny-all fallback if no specific step matches.
      for (const [, resolve] of this.pendingConfirmations) resolve(false);
      this.pendingConfirmations.clear();
      return;
    }
    const resolve = this.pendingConfirmations.get(stepId);
    if (resolve) {
      this.pendingConfirmations.delete(stepId);
      resolve(approved);
      logger.info('orchestrator', `Confirmation response for ${stepId}: ${approved ? 'approved' : 'denied'}`);
    }
  }

  // ── Task Runner ───────────────────────────────────────────────

  private async runTask(userMessage: string): Promise<void> {
    const config = this.configOf();

    // 1) Deterministic fast path first: unambiguous single-tool requests
    //    skip the model entirely. Works even with no provider configured,
    //    and still runs through the standard confirmation gate.
    if (config.agent.enableFastPath) {
      const action = classifyDirect(userMessage);
      if (action && this.canRunDirectAction(action)) {
        if (this.runMetrics) this.runMetrics.kind = 'direct';
        const handled = await this.runDirectTask(userMessage, action);
        if (handled) return; // completed (or denied) without any model call
      }
      // Otherwise the tool failed; fall through to the LLM loop so the
      // agent can diagnose and recover. History was rolled back.
    }

    // A rolled-back direct attempt must not mislabel this LLM run.
    if (this.runMetrics) this.runMetrics.kind = 'llm';

    const providerId = this.providers.getActiveProvider();
    const modelId = this.providers.getActiveModel();

    if (!providerId || !modelId) {
      this.emit('error', {
        message: 'No AI provider or model configured. Please configure a provider in Settings.',
        code: 'NO_PROVIDER',
      });
      if (this.runMetrics) this.runMetrics.outcome = 'no-provider';
      // Still close the run so the failed attempt is visible in metrics.
      this.finishRunTask();
      return;
    }

    const provider = this.providers.getProvider(providerId);
    if (!provider.hasApiKey() && provider.apiKeyRequired) {
      this.emit('error', {
        message: `No API key configured for ${provider.name}. Please add your API key in Settings.`,
        code: 'NO_API_KEY',
      });
      if (this.runMetrics) this.runMetrics.outcome = 'no-provider';
      // Still close the run so the failed attempt is visible in metrics.
      this.finishRunTask();
      return;
    }

    // Add user message to history
    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    };
    this.conversationHistory.push(userMsg);
    this.session.addMessage(userMsg);
    this.emit('agent-message', userMsg);

    // Create task + plan
    const taskId = uuidv4();
    this.currentTask = {
      id: taskId,
      instruction: userMessage,
      state: 'thinking',
      steps: [],
      currentStep: 0,
      startTime: Date.now(),
    };
    this.currentPlan = {
      id: uuidv4(),
      objective: userMessage,
      steps: [],
      currentStepIndex: 0,
      state: 'planning',
      startTime: Date.now(),
      verificationRequired: true,
    };

    this.consecutiveErrors = 0;
    this.repeatedActionCount = 0;
    this.lastActionFingerprint = '';
    this.loopAbortReason = null;
    this.stopRequested = false;
    this.setState('planning', 'Planning the approach...');
    this.stepCount = 0;

    try {
      await this.executeLoop(provider, modelId, config.agent.maxSteps, providerId);
    } catch (error: any) {
      logger.error('orchestrator', 'Agent loop failed', error);
      this.emit('error', {
        message: `Agent error: ${error.message}`,
        code: 'AGENT_ERROR',
      });
      this.setState('error', error.message);
      if (this.runMetrics) this.runMetrics.outcome = 'error';
    }

    this.finishRunTask();
  }

  /**
   * Record durable lessons and close task timings after a run. Failed
   * actions are remembered so future tasks can avoid repeating them.
   * (Secrets are never stored.)
   */
  private finishRunTask(): void {
    if (this.currentTask) {
      this.currentTask.endTime = Date.now();
      if (this.currentTask.state === 'thinking' || this.currentTask.state === 'planning' || this.currentTask.state === 'executing') {
        this.currentTask.state = 'completed';
      }
    }
    if (this.currentPlan) {
      this.currentPlan.endTime = Date.now();
      if (this.currentPlan.state === 'planning' || this.currentPlan.state === 'executing') {
        this.currentPlan.state = 'completed';
      }
    }

    const taskSteps = this.currentTask?.steps || [];
    const failedSteps = taskSteps.filter((s) => s.state === 'failed');
    const userMessage = this.currentTask?.instruction || '';
    if (failedSteps.length > 0 && this.runMetrics?.kind !== 'direct') {
      const detail = failedSteps
        .map((s) => `${s.description}: ${s.error || 'unknown error'}`)
        .join('; ')
        .slice(0, 1500);
      this.memory.add('action-result', `Task failed: ${userMessage} — ${detail}`, {
        source: 'agent',
        scope: 'failure',
      });
    }

    this.recordMetrics();
  }

  private recordMetrics(): void {
    if (!this.runMetrics) return;
    const m = this.runMetrics;
    // Plan steps carry timing fields (ExecutionStep); fall back to task
    // steps when the plan is gone.
    const steps: ExecutionStep[] = this.currentPlan?.steps ||
      ((this.currentTask?.steps || []) as ExecutionStep[]);
    const tools = steps
      .filter((s) => s.toolName && s.startTime)
      .map((s) => ({
        name: s.toolName as string,
        ms: s.endTime ? s.endTime - (s.startTime as number) : 0,
        attempts: s.attempts,
        state: s.state,
      }));

    telemetry.record({
      taskId: this.currentTask?.id || 'unknown',
      kind: m.kind,
      message: (this.currentTask?.instruction || '').slice(0, 120),
      startedAt: m.startedAt,
      queueWaitMs: m.queueWaitMs,
      totalMs: Date.now() - m.startedAt,
      modelCalls: m.modelCalls,
      modelMs: m.modelMs,
      toolCalls: tools.length,
      waves: m.waves,
      parallelWaves: m.parallelWaves,
      tools,
      result: m.outcome,
    });

    this.emit('task-complete', {
      taskId: this.currentTask?.id,
      kind: m.kind,
      totalMs: Date.now() - m.startedAt,
      modelCalls: m.modelCalls,
      toolCalls: tools.length,
    });
  }

  // ── Deterministic Fast Path ───────────────────────────────────

  /** A direct action is runnable when its tool exists and is enabled. */
  private canRunDirectAction(action: DirectAction): boolean {
    const tool = this.toolRegistry.getTool(action.tool);
    return tool !== undefined;
  }

  /**
   * Execute a classified single-tool request without any model call.
   * Returns true when the task reached a terminal state itself (success
   * or user denial); false when the tool failed and the request should
   * be handed to the LLM loop.
   */
  private async runDirectTask(userMessage: string, action: DirectAction): Promise<boolean> {
    const config = this.configOf();
    const historyMark = this.conversationHistory.length;

    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    };
    this.conversationHistory.push(userMsg);
    this.session.addMessage(userMsg);
    this.emit('agent-message', userMsg);

    const taskId = uuidv4();
    this.currentTask = {
      id: taskId,
      instruction: userMessage,
      state: 'executing',
      steps: [],
      currentStep: 0,
      startTime: Date.now(),
    };
    this.currentPlan = {
      id: uuidv4(),
      objective: userMessage,
      steps: [],
      currentStepIndex: 0,
      state: 'executing',
      startTime: Date.now(),
      verificationRequired: false,
    };
    this.consecutiveErrors = 0;
    this.repeatedActionCount = 0;
    this.lastActionFingerprint = '';
    this.loopAbortReason = null;
    this.stopRequested = false;
    this.setState('executing', action.summary);

    const toolCall: ToolCall = {
      id: `direct_${uuidv4()}`,
      type: 'function',
      function: {
        name: action.tool,
        arguments: JSON.stringify(action.args),
      },
    };

    // Assistant message carrying the tool call. Stored (not broadcast —
    // its content is empty) so provider replay semantics stay intact.
    const assistantMsg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [toolCall],
    };
    this.conversationHistory.push(assistantMsg);
    this.session.addMessage(assistantMsg);

    const pc = this.prepareToolCall(toolCall);
    if (!pc) {
      // Argument parse failure — should not happen for router-built args.
      this.rollbackDirect(historyMark);
      return false;
    }

    // Confirmation gate (identical policy to the LLM path).
    const decision = await this.checkConfirmationGate(pc, config);
    if (decision === 'denied') {
      this.settleDenied(pc);
      this.completeDirectTask(action, null, true);
      return true;
    }

    const result = await this.runTool(pc);
    if (!result.success) {
      // Failed deterministic action: roll back this attempt entirely and
      // let the LLM loop diagnose/recover (it may explain or adapt).
      this.rollbackDirect(historyMark);
      return false;
    }

    // Record the tool outcome exactly like the LLM path would (step
    // state, tool-result history entry, progress events, loop detection).
    this.settleResult(pc, result);
    this.completeDirectTask(action, result, false);
    return true;
  }

  /** Remove all history entries added by a failed direct attempt. */
  private rollbackDirect(historyMark: number): void {
    this.conversationHistory = this.conversationHistory.slice(0, historyMark);
    try {
      this.session.setHistory(this.conversationHistory);
    } catch (e) {
      logger.warn('orchestrator', `Failed to roll back session history: ${(e as Error).message}`);
    }
    this.currentTask = null;
    this.currentPlan = null;
  }

  /** Synthesize the final assistant message for a direct action. */
  private completeDirectTask(action: DirectAction, result: ToolResult | null, denied: boolean): void {
    let content: string;
    if (denied) {
      content = `I skipped that action — permission was not granted for ${action.tool}. Let me know if you would like to approve it or do something else.`;
    } else {
      const output = (result?.output || '').trim();
      if (action.tool === 'filesystem' && action.args.operation === 'read') {
        content = `Here is the content of ${String(action.args.path || 'the file')}:\n\n\`\`\`\n${output || '(empty file)'}\n\`\`\``;
      } else if (action.tool === 'filesystem' && action.args.operation === 'list') {
        content = output ? `Contents of ${String(action.args.path || 'the directory')}:\n\n${output}` : 'The directory is empty.';
      } else if (action.tool === 'system-info') {
        content = output;
      } else if (action.tool === 'clipboard') {
        content = output ? `Your clipboard contains:\n\n${output}` : 'Your clipboard is empty.';
      } else {
        content = output ? `Done. ${output}` : `Done — ${action.summary.replace(/…$/, '').toLowerCase()} completed with no output.`;
      }
    }

    const finalMsg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: budgetAssistantMessage(content),
      timestamp: Date.now(),
    };
    this.conversationHistory.push(finalMsg);
    this.session.addMessage(finalMsg);
    this.emit('agent-message', finalMsg);
    this.setState('completed', 'Task completed');
    if (this.runMetrics) this.runMetrics.outcome = denied ? 'denied' : 'completed';
    this.finishRunTask();
  }

  // ── Agent Loop ────────────────────────────────────────────────

  private async executeLoop(
    provider: AIProvider,
    modelId: string,
    maxSteps: number,
    providerId?: ProviderId,
  ): Promise<void> {
    while (this.stepCount < maxSteps && !this.stopRequested && !this.loopAbortReason) {
      this.stepCount++;

      // Build messages for the AI with improved context management
      const messages = this.buildMessages();

      // Get tool definitions
      const tools = this.toolRegistry.getToolDefinitions();

      this.setState('thinking', `Thinking (step ${this.stepCount})...`);

      try {
        const modelStart = Date.now();
        const response = await provider.chat({
          messages,
          model: modelId,
          provider: providerId || provider.id,
          tools: tools.length > 0 ? tools : undefined,
          maxTokens: 4096,
          temperature: 0.7,
        });
        if (this.runMetrics) {
          this.runMetrics.modelCalls++;
          this.runMetrics.modelMs += Date.now() - modelStart;
        }

        // Reset consecutive errors on successful response
        this.consecutiveErrors = 0;

        // Handle tool calls
        if (response.toolCalls && response.toolCalls.length > 0) {
          // Add the assistant message — including its tool calls — to
          // history. Providers require tool results to reference the
          // originating assistant tool_calls, so this message must carry
          // them when replayed on the next request.
          const assistantMsg: ChatMessage = {
            id: uuidv4(),
            role: 'assistant',
            content: response.message.content || '',
            timestamp: Date.now(),
            toolCalls: this.limitToolCallsForHistory(response.toolCalls),
          };
          this.conversationHistory.push(assistantMsg);
          this.session.addMessage(assistantMsg);
          this.emit('agent-message', assistantMsg);

          if (response.message.content) {
            this.emit('activity', { type: 'thinking', content: response.message.content });
          }

          // Execute the tool calls — batching independent calls into
          // parallel waves while preserving call order in history.
          await this.executeToolCallWave(response.toolCalls);

          if (this.loopAbortReason) {
            const loopMsg: ChatMessage = {
              id: uuidv4(),
              role: 'assistant',
              content: `I stopped because I appear to be repeating the same action without making progress: ${this.loopAbortReason}\n\n${this.getExecutionSummary()}`,
              timestamp: Date.now(),
            };
            this.conversationHistory.push(loopMsg);
            this.session.addMessage(loopMsg);
            this.emit('agent-message', loopMsg);
            this.setState('completed', 'Stopped: repeated action detected');
            if (this.runMetrics) this.runMetrics.outcome = 'stopped';
            return;
          }

          if (this.stopRequested) {
            this.setState('idle', 'Stopped by user');
            if (this.runMetrics) this.runMetrics.outcome = 'stopped';
            return;
          }

          // After tool execution, add an observation prompt
          if (this.stepCount < maxSteps - 1) {
            this.setState('observing', 'Analyzing results...');
          }
        } else {
          // No tool calls - this is the final response
          const assistantMsg: ChatMessage = {
            id: uuidv4(),
            role: 'assistant',
            content: budgetAssistantMessage(response.message.content),
            timestamp: Date.now(),
          };
          this.conversationHistory.push(assistantMsg);
          this.session.addMessage(assistantMsg);
          this.emit('agent-message', assistantMsg);

          this.setState('completed', 'Task completed');
          return;
        }
      } catch (error: any) {
        if (error instanceof ProviderError) {
          this.consecutiveErrors++;
          this.emit('error', {
            message: error.message,
            code: error.code,
            details: `Provider: ${error.providerId}`,
          });

          if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
            this.setState('error', `Too many consecutive errors (${this.consecutiveErrors}). Stopping.`);
            if (this.runMetrics) this.runMetrics.outcome = 'error';
            return;
          }

          // Wait before retrying on rate limit
          if (error.code === 'RATE_LIMIT') {
            await this.sleep(5000);
          } else if (error.code === 'NETWORK_ERROR' || error.code === 'SERVER_ERROR' || error.code === 'TIMEOUT') {
            // Try fallback provider
            const fallback = this.providers.getFallbackProvider(providerId!);
            if (fallback && fallback.hasApiKey()) {
              logger.warn('orchestrator', `Falling back from ${providerId} to ${fallback.id}`);
              this.emit('activity', { type: 'thinking', content: `Switching to ${fallback.name} due to connection issues...` });
              provider = fallback;
              providerId = fallback.id;
              // The fallback provider may not offer the active model —
              // pick one it actually has (see getFallbackModel).
              const fallbackModel = this.providers.getFallbackModel(fallback.id);
              if (fallbackModel) {
                modelId = fallbackModel;
                logger.info('orchestrator', `Fallback model for ${fallback.id}: ${fallbackModel}`);
              }
              await this.sleep(1000);
            } else {
              await this.sleep(2000);
            }
          } else {
            this.setState('error', error.message);
            if (this.runMetrics) this.runMetrics.outcome = 'error';
            return;
          }
        } else {
          throw error;
        }
      }
    }

    // Reached max steps
    const summaryMsg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: `I've reached the maximum number of steps (${maxSteps}) for this task. Here's a summary of what was accomplished:\n\n${this.getExecutionSummary()}`,
      timestamp: Date.now(),
    };
    this.conversationHistory.push(summaryMsg);
    this.session.addMessage(summaryMsg);
    this.emit('agent-message', summaryMsg);
    this.setState('completed', 'Reached step limit');
    if (this.runMetrics) this.runMetrics.outcome = 'step-limit';
  }

  private buildMessages(): ChatMessage[] {
    // Improved context management: keep more context for recent messages,
    // less for older ones. Include task plan if available.
    const maxHistory = 30;
    const recentHistory = this.conversationHistory.slice(-maxHistory);

    const messages: ChatMessage[] = [
      {
        id: 'system',
        role: 'system',
        content: SYSTEM_PROMPT + this.getTaskContext(),
        timestamp: Date.now(),
      },
      ...recentHistory,
    ];

    return messages;
  }

  private getTaskContext(): string {
    if (!this.currentPlan) return '';

    const completedSteps = this.currentPlan.steps.filter(s => s.state === 'completed');
    const failedSteps = this.currentPlan.steps.filter(s => s.state === 'failed');

    if (completedSteps.length === 0 && failedSteps.length === 0) return '';

    let context = '\n\nCURRENT TASK CONTEXT:\n';
    context += `Objective: ${this.currentPlan.objective}\n`;

    if (completedSteps.length > 0) {
      context += 'Completed steps:\n';
      for (const step of completedSteps) {
        context += `  ✓ ${step.description}\n`;
      }
    }

    if (failedSteps.length > 0) {
      context += 'Failed steps (consider alternative approaches):\n';
      for (const step of failedSteps) {
        context += `  ✗ ${step.description}: ${step.error || 'Unknown error'}\n`;
      }
    }

    return context;
  }

  // ── Tool Call Execution (serial + parallel waves) ─────────────

  /**
   * Execute a batch of tool calls from one model response. Independent
   * calls (parallel-safe tools, no confirmation needed, no path conflicts)
   * run concurrently in waves; everything else runs alone. Results always
   * settle in the original call order so replay semantics stay intact.
   */
  private async executeToolCallWave(toolCalls: ToolCall[]): Promise<void> {
    const config = this.configOf();

    // Prepare all calls up front so step order is deterministic even when
    // calls later run concurrently.
    const pending: PendingCall[] = [];
    for (const call of toolCalls) {
      if (this.stopRequested || this.loopAbortReason) break;
      const pc = this.prepareToolCall(call);
      if (pc) pending.push(pc);
    }

    const waves = this.planWaves(pending, config);
    if (this.runMetrics) {
      this.runMetrics.waves += waves.length;
      this.runMetrics.parallelWaves += waves.filter((w) => w.length > 1).length;
    }

    for (const wave of waves) {
      if (this.stopRequested || this.loopAbortReason) break;
      await this.runWave(wave, config);
    }

    // Any calls that were prepared but never ran (stop/abort mid-batch)
    // need tool-result entries so provider replay semantics stay intact.
    const settled = new Set<string>();
    for (const pc of pending) {
      if (pc.step.state === 'completed' || pc.step.state === 'failed' ||
          pc.step.state === 'skipped') {
        settled.add(pc.step.id);
      }
    }
    if (settled.size < pending.length) {
      for (const pc of pending) {
        if (!settled.has(pc.step.id)) {
          this.settleStopped(pc);
        }
      }
    }
  }

  /**
   * Split prepared calls into execution waves. A call runs alone when it:
   *  - needs user confirmation (approval prompts must never overlap), or
   *  - is a serial-mode tool (X display / clipboard / browser / terminal),
   *  - mutates the filesystem (write/delete/rename — same-path races).
   */
  private planWaves(pending: PendingCall[], config: AppConfig): PendingCall[][] {
    const waves: PendingCall[][] = [];
    let current: PendingCall[] = [];

    const flush = () => {
      if (current.length > 0) {
        waves.push(current);
        current = [];
      }
    };

    for (const pc of pending) {
      if (this.mustRunAlone(pc, config)) {
        flush();
        waves.push([pc]);
      } else {
        current.push(pc);
        if (current.length >= this.MAX_PARALLEL_TOOLS) flush();
      }
    }
    flush();
    return waves;
  }

  private mustRunAlone(pc: PendingCall, config: AppConfig): boolean {
    const name = pc.call.function.name;
    if (this.toolRegistry.getExecutionMode(name) === 'serial') return true;
    if (config.agent.enableParallelTools === false) return true;

    if (config.agent.requireConfirmation &&
        this.toolRegistry.requiresConfirmation(name, pc.args)) {
      return true;
    }
    if (name === 'terminal') {
      const command = String(pc.args.command || '');
      if (matchesAnyPattern(command, config.agent.confirmationPatterns)) return true;
    }
    // Filesystem mutations must not race other calls touching the same path.
    if (name === 'filesystem') {
      const op = pc.args.operation as string;
      if (op === 'write' || op === 'delete' || op === 'rename') return true;
    }
    return false;
  }

  /** Run one wave: either a single serial call or a concurrent batch. */
  private async runWave(wave: PendingCall[], config: AppConfig): Promise<void> {
    const parallel = wave.length > 1;
    if (!parallel) {
      const pc = wave[0];
      const decision = await this.checkConfirmationGate(pc, config);
      if (decision === 'denied') {
        this.settleDenied(pc);
        return;
      }
      const result = await this.runTool(pc);
      this.settleResult(pc, result);
      return;
    }

    // Parallel wave: all calls are gate-free by construction (planWaves).
    // Announce each in order, run bodies concurrently, then settle in
    // original order so history/progress streams stay deterministic.
    for (const pc of wave) {
      this.announceExecution(pc);
    }
    const outcomes = await Promise.all(wave.map((pc) => this.runToolBody(pc)));
    for (let i = 0; i < wave.length; i++) {
      this.settleResult(wave[i], outcomes[i]);
    }
  }

  /** Parse args and register the step (order preserved). */
  private prepareToolCall(toolCall: ToolCall): PendingCall | null {
    const toolName = toolCall.function.name;
    let toolArgs: Record<string, unknown>;
    try {
      toolArgs = JSON.parse(toolCall.function.arguments);
    } catch {
      toolArgs = {};
      logger.warn('orchestrator', `Failed to parse tool arguments for ${toolName}`);
    }

    const step: ExecutionStep = {
      id: toolCall.id,
      description: this.describeToolAction(toolName, toolArgs),
      toolName,
      toolArgs,
      state: 'pending',
      attempts: 1,
    };

    if (this.currentTask) {
      this.currentTask.steps.push(step);
      this.currentTask.currentStep = this.currentTask.steps.length;
    }
    if (this.currentPlan) {
      this.currentPlan.steps.push(step);
      this.currentPlan.currentStepIndex = this.currentPlan.steps.length;
      this.currentPlan.state = 'executing';
    }

    return { call: toolCall, args: toolArgs, step };
  }

  /**
   * Check whether the tool call needs user approval and wait for the
   * decision. Denied actions are skipped, never run.
   */
  private async checkConfirmationGate(pc: PendingCall, config: AppConfig): Promise<ToolOutcome> {
    const toolName = pc.call.function.name;
    const toolNeedsConfirmation = this.toolRegistry.requiresConfirmation(toolName, pc.args);
    // Additional pattern-based gate from config: destructive words inside
    // terminal commands (rm, sudo, shutdown, ...) always require approval.
    const command = toolName === 'terminal' ? String((pc.args.command as string) || '') : '';
    const patternNeedsConfirmation = matchesAnyPattern(command, config.agent.confirmationPatterns);
    if (!config.agent.requireConfirmation || (!toolNeedsConfirmation && !patternNeedsConfirmation)) {
      return 'proceed';
    }

    const description = `Execute ${toolName}: ${pc.step.description}`;
    const actionJson = JSON.stringify({ tool: toolName, args: pc.args });
    this.emit('confirmation-required', {
      taskId: this.currentTask?.id,
      stepId: pc.call.id,
      description,
      action: actionJson,
    });
    logger.info('orchestrator', `Confirmation required for ${toolName}`);

    const approved = await this.requestConfirmation(pc.call.id, description, actionJson);
    return approved ? 'proceed' : 'denied';
  }

  /** Record a denied tool call as skipped (never executed). */
  private settleDenied(pc: PendingCall): void {
    const { step, call, args } = pc;
    step.state = 'skipped';
    step.result = 'Action denied by user.';
    step.error = 'User denied the confirmation request.';
    step.endTime = Date.now();
    this.emit('tool-execution', {
      toolName: call.function.name,
      args,
      state: 'skipped',
      result: 'Denied by user',
      stepId: step.id,
    });
    const deniedMsg: ChatMessage = {
      id: uuidv4(),
      role: 'tool',
      content: `Tool error (${call.function.name}): The user denied permission for this action. Do not retry it; explain what was blocked and offer alternatives.`,
      timestamp: Date.now(),
      toolCallId: call.id,
      name: call.function.name,
    };
    this.conversationHistory.push(deniedMsg);
    this.session.addMessage(deniedMsg);
  }

  /** Announce a tool call that is about to execute (UI feedback). */
  private announceExecution(pc: PendingCall): void {
    const toolName = pc.call.function.name;
    this.setState('executing', pc.step.description);
    this.emit('tool-execution', { toolName, args: pc.args, state: 'executing' });
    this.emit('activity', { type: 'executing', content: pc.step.description });
  }

  /** Execute a single tool with the shared announce/emit wrapper. */
  private async runTool(pc: PendingCall): Promise<ToolResult> {
    this.announceExecution(pc);
    return this.runToolBody(pc);
  }

  /**
   * Execute the tool (plus retries for transient errors). Emits retry
   * activity; the final result is handled by settleResult so parallel
   * waves can settle in deterministic order.
   */
  private async runToolBody(pc: PendingCall): Promise<ToolResult> {
    const toolName = pc.call.function.name;
    const config = this.configOf();

    // Immediate feedback + visible activity row.
    pc.step.state = 'executing';
    pc.step.startTime = Date.now();
    this.emit('tool-execution', { toolName, args: pc.args, state: 'executing' });

    // Execute the tool with retry for transient errors.
    // (The assistant message carrying this tool call was already added to
    // the history by the caller; here we only append the tool result, which
    // pairs with the assistant's tool_calls when replayed.)
    const maxRetries = Math.max(0, config.agent.maxRetries - 1);
    let result = await this.toolRegistry.execute(toolName, pc.args);
    let retries = 0;

    while (!result.success && retries < Math.min(this.MAX_RETRIES_PER_STEP, maxRetries) &&
           this.isRetryableError(result.error || '')) {
      retries++;
      pc.step.state = 'retrying';
      pc.step.attempts++;
      logger.info('orchestrator', `Retrying tool ${toolName} (attempt ${retries + 1})`);
      this.emit('activity', { type: 'retrying', content: `Retrying ${toolName} (attempt ${retries + 1})...` });
      await this.sleep(1000 * retries); // Exponential backoff
      result = await this.toolRegistry.execute(toolName, pc.args);
    }
    pc.step.endTime = Date.now();
    return result;
  }

  /** Record the outcome of one tool call in deterministic order. */
  private settleResult(pc: PendingCall, result: ToolResult): void {
    const { step, call, args } = pc;
    const toolName = call.function.name;
    step.state = result.success ? 'completed' : 'failed';
    step.result = result.output?.slice(0, 1000);
    step.error = result.error;
    step.endTime = Date.now();

    this.emit('tool-execution', {
      toolName,
      args,
      state: step.state,
      result: result.output?.slice(0, 500),
      stepId: step.id,
    });
    if (this.currentPlan && this.currentTask) {
      this.emit('task-progress', { ...this.currentTask, steps: [...this.currentTask.steps] });
    }

    // Add tool result to conversation (bounded — see context-budget).
    const resultContent = result.success
      ? `Tool result (${toolName}): ${budgetToolResultOutput(result.output)}`
      : `Tool error (${toolName}): ${budgetToolResultOutput(result.error || 'Unknown error')}`;

    const resultMsg: ChatMessage = {
      id: uuidv4(),
      role: 'tool',
      content: resultContent,
      timestamp: Date.now(),
      toolCallId: call.id,
      name: toolName,
    };
    this.conversationHistory.push(resultMsg);
    this.session.addMessage(resultMsg);

    // Track consecutive errors
    if (result.success) {
      this.consecutiveErrors = 0;
    } else {
      this.consecutiveErrors++;
      if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
        logger.warn('orchestrator', `Too many consecutive errors (${this.consecutiveErrors}), may stop soon`);
      }
    }

    logger.info('orchestrator', `Tool ${toolName}: ${step.state} (${step.attempts} attempts, ${step.endTime! - step.startTime!}ms)`);

    // Loop detection: flag identical consecutive successful actions.
    // The fingerprint is capped so large payloads (file writes) never
    // dominate the comparison.
    const fingerprint = `${toolName}:${JSON.stringify(args).slice(0, 500)}`;
    if (result.success) {
      if (fingerprint === this.lastActionFingerprint) {
        this.repeatedActionCount++;
      } else {
        this.repeatedActionCount = 1;
        this.lastActionFingerprint = fingerprint;
      }
      if (this.repeatedActionCount >= this.MAX_REPEATED_ACTIONS) {
        this.loopAbortReason = `repeated the same action ${this.repeatedActionCount} times in a row (${toolName})`;
        logger.warn('orchestrator', `Loop detected: ${this.loopAbortReason}`);
      }
    } else {
      this.repeatedActionCount = 0;
      this.lastActionFingerprint = '';
    }
  }

  /** Mark a prepared-but-never-run call (stop/abort) as skipped. */
  private settleStopped(pc: PendingCall): void {
    const { step, call, args } = pc;
    step.state = 'skipped';
    step.error = 'Cancelled: the agent was stopped before this tool ran.';
    step.endTime = Date.now();
    this.emit('tool-execution', {
      toolName: call.function.name,
      args,
      state: 'skipped',
      result: 'Cancelled',
      stepId: step.id,
    });
    const cancelledMsg: ChatMessage = {
      id: uuidv4(),
      role: 'tool',
      content: `Tool result (${call.function.name}): cancelled before execution — the task was stopped.`,
      timestamp: Date.now(),
      toolCallId: call.id,
      name: call.function.name,
    };
    this.conversationHistory.push(cancelledMsg);
    this.session.addMessage(cancelledMsg);
  }

  /**
   * Keep tool-call arguments bounded when persisting history. Arguments
   * may contain large payloads (file writes etc.). If a payload exceeds
   * the cap it is replaced with `{}` so replayed messages stay parseable.
   */
  private limitToolCallsForHistory(toolCalls: ToolCall[]): ToolCall[] {
    const MAX_ARG_CHARS = 10000;
    return toolCalls.map((tc) => {
      const args = tc.function.arguments || '';
      if (args.length <= MAX_ARG_CHARS) return tc;
      try {
        JSON.parse(args); // if parseable we could truncate content, but be safe
      } catch { /* not parseable anyway */ }
      return {
        ...tc,
        function: { ...tc.function, arguments: '{}' },
      };
    });
  }

  /**
   * Wait for the user to approve or deny a high-impact action.
   * Defaults to DENY when the request times out or the agent is stopped,
   * so dangerous operations never run silently.
   */
  private requestConfirmation(stepId: string, description: string, action: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (approved: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingConfirmations.delete(stepId);
        this.setState('executing', approved ? 'Approved — continuing...' : 'Denied — skipping action');
        resolve(approved);
      };

      this.pendingConfirmations.set(stepId, settle);
      this.setState('requires-confirmation', `Approval needed: ${description}`);

      const timer = setTimeout(() => {
        logger.warn('orchestrator', `Confirmation for ${stepId} timed out, denying by default`);
        settle(false);
      }, this.CONFIRMATION_TIMEOUT_MS);
    });
  }

  private isRetryableError(error: string): boolean {
    const retryable = ['timeout', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'network', 'temporary', 'EPIPE'];
    return retryable.some(r => error.toLowerCase().includes(r));
  }

  private describeToolAction(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case 'terminal': {
        const cmd = (args.command as string || '').slice(0, 80);
        return `Running: ${cmd}`;
      }
      case 'screenshot':
        return 'Taking screenshot...';
      case 'computer-control': {
        const action = args.action as string;
        if (action === 'mouse_click') return `Clicking at (${args.x}, ${args.y})`;
        if (action === 'type_text') return `Typing text...`;
        if (action === 'key_press') return `Pressing key: ${args.key}`;
        if (action === 'launch_app') return `Launching: ${args.app}`;
        if (action === 'list_windows') return 'Listing open windows...';
        return `Computer control: ${action}`;
      }
      case 'filesystem': {
        const op = args.operation as string;
        const path = (args.path as string || '').split('/').pop() || args.path;
        return `File ${op}: ${path}`;
      }
      case 'browser': {
        if (args.action === 'search') return `Searching: ${args.query}`;
        if (args.action === 'open_url') return `Opening: ${(args.url as string || '').slice(0, 60)}`;
        return `Browser: ${args.action}`;
      }
      case 'clipboard':
        return args.action === 'read' ? 'Reading clipboard...' : 'Writing to clipboard...';
      case 'search':
        return `Searching web: ${args.query}`;
      case 'system-info':
        return `Getting ${args.info} system info...`;
      default:
        return `Using ${toolName}...`;
    }
  }

  private getExecutionSummary(): string {
    if (!this.currentTask || this.currentTask.steps.length === 0) {
      return 'No steps were executed.';
    }

    const completed = this.currentTask.steps.filter(s => s.state === 'completed');
    const failed = this.currentTask.steps.filter(s => s.state === 'failed');

    let summary = `Executed ${this.currentTask.steps.length} steps:\n`;
    summary += `  ✓ ${completed.length} succeeded\n`;
    if (failed.length > 0) {
      summary += `  ✗ ${failed.length} failed\n`;
      for (const step of failed) {
        summary += `    - ${step.description}: ${step.error || 'Unknown error'}\n`;
      }
    }

    return summary;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getState(): AgentState {
    return this.state;
  }

  getCurrentTask(): AgentTask | null {
    return this.currentTask;
  }

  getConversationHistory(): ChatMessage[] {
    return this.conversationHistory;
  }

  clearHistory(): void {
    this.conversationHistory = [];
    this.currentTask = null;
    this.currentPlan = null;
    this.pendingQueue = [];
    this.stepCount = 0;
    this.consecutiveErrors = 0;
    this.repeatedActionCount = 0;
    this.lastActionFingerprint = '';
    this.loopAbortReason = null;
    this.session.clearHistory();
    this.setState('idle');
    logger.info('orchestrator', 'History cleared');
  }

  stop(): void {
    this.stopRequested = true;
    this.stepCount = this.configOf().agent.maxSteps; // Force exit loop
    // Deny any pending confirmations so waiting actions never execute.
    for (const [, resolve] of this.pendingConfirmations) resolve(false);
    this.pendingConfirmations.clear();
    this.setState('idle', 'Stopped by user');
    if (this.runMetrics && this.runMetrics.outcome === 'completed') {
      this.runMetrics.outcome = 'stopped';
    }
  }
}

export const orchestrator = new AgentOrchestrator();
