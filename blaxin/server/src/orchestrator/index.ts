import { v4 as uuidv4 } from 'uuid';
import { 
  ChatMessage, AgentState, AgentTask, TaskStep, AIResponse, ToolCall,
  ProviderId
} from '../types.js';
import { providers, AIProvider, ProviderError } from '../providers/index.js';
import { toolRegistry } from '../tools/index.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { sessionState } from '../utils/session-state.js';
import { memoryStore } from '../utils/memory.js';

type EventCallback = (event: string, data: any) => void;

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

  constructor() {
    // Restore conversation history from persisted state
    const savedHistory = sessionState.getHistory();
    if (savedHistory.length > 0) {
      this.conversationHistory = savedHistory as ChatMessage[];
      logger.info('orchestrator', `Restored ${savedHistory.length} messages from session state`);
    }
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
      await this.runTask(userMessage);
    } finally {
      this.busy = false;
      this.stopRequested = false;
    }

    // Run anything that queued while this task was active.
    const next = this.pendingQueue.shift();
    if (next !== undefined) {
      this.setState('waiting', 'Starting next queued task...');
      // Defer to the next microtask so the caller can return.
      setTimeout(() => { this.processMessage(next); }, 0);
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

  private async runTask(userMessage: string): Promise<void> {
    const config = getConfig();
    const providerId = providers.getActiveProvider();
    const modelId = providers.getActiveModel();

    if (!providerId || !modelId) {
      this.emit('error', {
        message: 'No AI provider or model configured. Please configure a provider in Settings.',
        code: 'NO_PROVIDER',
      });
      return;
    }

    const provider = providers.getProvider(providerId);
    if (!provider.hasApiKey() && provider.apiKeyRequired) {
      this.emit('error', {
        message: `No API key configured for ${provider.name}. Please add your API key in Settings.`,
        code: 'NO_API_KEY',
      });
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
    sessionState.addMessage(userMsg);
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
    }

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

    // Record durable lessons: failed actions are remembered so future
    // tasks can avoid repeating them. (Secrets are never stored.)
    const taskSteps = this.currentTask?.steps || [];
    const failedSteps = taskSteps.filter((s) => s.state === 'failed');
    if (failedSteps.length > 0) {
      const detail = failedSteps
        .map((s) => `${s.description}: ${s.error || 'unknown error'}`)
        .join('; ')
        .slice(0, 1500);
      memoryStore.add('action-result', `Task failed: ${userMessage} — ${detail}`, {
        source: 'agent',
        scope: 'failure',
      });
    }
  }

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
      const tools = toolRegistry.getToolDefinitions();

      this.setState('thinking', `Thinking (step ${this.stepCount})...`);

      try {
        const response = await provider.chat({
          messages,
          model: modelId,
          provider: providerId || provider.id,
          tools: tools.length > 0 ? tools : undefined,
          maxTokens: 4096,
          temperature: 0.7,
        });

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
          sessionState.addMessage(assistantMsg);
          this.emit('agent-message', assistantMsg);

          if (response.message.content) {
            this.emit('activity', { type: 'thinking', content: response.message.content });
          }

          // Execute each tool call
          for (const toolCall of response.toolCalls) {
            if (this.stopRequested || this.loopAbortReason) break;
            await this.executeToolCall(toolCall, provider, modelId, maxSteps);
          }

          if (this.loopAbortReason) {
            const loopMsg: ChatMessage = {
              id: uuidv4(),
              role: 'assistant',
              content: `I stopped because I appear to be repeating the same action without making progress: ${this.loopAbortReason}\n\n${this.getExecutionSummary()}`,
              timestamp: Date.now(),
            };
            this.conversationHistory.push(loopMsg);
            sessionState.addMessage(loopMsg);
            this.emit('agent-message', loopMsg);
            this.setState('completed', 'Stopped: repeated action detected');
            return;
          }

          if (this.stopRequested) {
            this.setState('idle', 'Stopped by user');
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
            content: response.message.content,
            timestamp: Date.now(),
          };
          this.conversationHistory.push(assistantMsg);
          sessionState.addMessage(assistantMsg);
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
            return;
          }

          // Wait before retrying on rate limit
          if (error.code === 'RATE_LIMIT') {
            await this.sleep(5000);
          } else if (error.code === 'NETWORK_ERROR' || error.code === 'SERVER_ERROR' || error.code === 'TIMEOUT') {
            // Try fallback provider
            const fallback = providers.getFallbackProvider(providerId!);
            if (fallback && fallback.hasApiKey()) {
              logger.warn('orchestrator', `Falling back from ${providerId} to ${fallback.id}`);
              this.emit('activity', { type: 'thinking', content: `Switching to ${fallback.name} due to connection issues...` });
              provider = fallback;
              providerId = fallback.id;
              modelId = this.activeModelForProvider(fallback.id) || modelId;
              await this.sleep(1000);
            } else {
              await this.sleep(2000);
            }
          } else {
            this.setState('error', error.message);
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
    sessionState.addMessage(summaryMsg);
    this.emit('agent-message', summaryMsg);
    this.setState('completed', 'Reached step limit');
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

  private async executeToolCall(
    toolCall: ToolCall,
    provider: AIProvider,
    modelId: string,
    maxSteps: number,
  ): Promise<void> {
    const toolName = toolCall.function.name;
    let toolArgs: Record<string, unknown>;

    try {
      toolArgs = JSON.parse(toolCall.function.arguments);
    } catch {
      toolArgs = {};
      logger.warn('orchestrator', `Failed to parse tool arguments for ${toolName}`);
    }

    // Track this step
    const step: ExecutionStep = {
      id: toolCall.id,
      description: this.describeToolAction(toolName, toolArgs),
      toolName,
      toolArgs,
      state: 'executing',
      attempts: 1,
      startTime: Date.now(),
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

    // Check if confirmation is needed — and actually wait for the user's
    // decision before executing. Denied actions are skipped, never run.
    const config = getConfig();
    if (config.agent.requireConfirmation && toolRegistry.requiresConfirmation(toolName, toolArgs)) {
      const description = `Execute ${toolName}: ${step.description}`;
      const actionJson = JSON.stringify({ tool: toolName, args: toolArgs });
      this.emit('confirmation-required', {
        taskId: this.currentTask?.id,
        stepId: toolCall.id,
        description,
        action: actionJson,
      });
      logger.info('orchestrator', `Confirmation required for ${toolName}`);

      const approved = await this.requestConfirmation(toolCall.id, description, actionJson);
      if (!approved) {
        step.state = 'skipped';
        step.result = 'Action denied by user.';
        step.error = 'User denied the confirmation request.';
        step.endTime = Date.now();
        this.emit('tool-execution', {
          toolName,
          args: toolArgs,
          state: 'skipped',
          result: 'Denied by user',
          stepId: step.id,
        });
        const deniedMsg: ChatMessage = {
          id: uuidv4(),
          role: 'tool',
          content: `Tool error (${toolName}): The user denied permission for this action. Do not retry it; explain what was blocked and offer alternatives.`,
          timestamp: Date.now(),
          toolCallId: toolCall.id,
          name: toolName,
        };
        this.conversationHistory.push(deniedMsg);
        sessionState.addMessage(deniedMsg);
        return;
      }
    }

    this.setState('executing', step.description);

    // Describe the action in user-friendly terms
    this.setState('executing', step.description);
    this.emit('tool-execution', { toolName, args: toolArgs, state: 'executing' });
    this.emit('activity', { type: 'executing', content: step.description });

    // Execute the tool with retry for transient errors.
    // (The assistant message carrying this tool call was already added to
    // the history by the caller; here we only append the tool result, which
    // pairs with the assistant's tool_calls when replayed.)
    let result = await toolRegistry.execute(toolName, toolArgs);
    let retries = 0;

    while (!result.success && retries < this.MAX_RETRIES_PER_STEP && this.isRetryableError(result.error || '')) {
      retries++;
      step.state = 'retrying';
      step.attempts++;
      logger.info('orchestrator', `Retrying tool ${toolName} (attempt ${retries + 1})`);
      this.emit('activity', { type: 'retrying', content: `Retrying ${toolName} (attempt ${retries + 1})...` });
      await this.sleep(1000 * retries); // Exponential backoff
      result = await toolRegistry.execute(toolName, toolArgs);
    }

    // Update step state
    step.state = result.success ? 'completed' : 'failed';
    step.result = result.output?.slice(0, 1000);
    step.error = result.error;
    step.endTime = Date.now();

    this.emit('tool-execution', {
      toolName,
      args: toolArgs,
      state: step.state,
      result: result.output?.slice(0, 500),
      stepId: step.id,
    });
    if (this.currentPlan && this.currentTask) {
      this.emit('task-progress', { ...this.currentTask, steps: [...this.currentTask.steps] });
    }

    // Add tool result to conversation
    const resultContent = result.success
      ? `Tool result (${toolName}): ${result.output}`
      : `Tool error (${toolName}): ${result.error || 'Unknown error'}`;
    
    const resultMsg: ChatMessage = {
      id: uuidv4(),
      role: 'tool',
      content: resultContent,
      timestamp: Date.now(),
      toolCallId: toolCall.id,
      name: toolName,
    };
    this.conversationHistory.push(resultMsg);
    sessionState.addMessage(resultMsg);

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
    const fingerprint = `${toolName}:${JSON.stringify(toolArgs)}`;
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

  private activeModelForProvider(providerId: ProviderId): string | null {
    const model = providers.getActiveModel();
    if (!model) return null;
    // If model belongs to different provider, try to find a compatible one
    return model;
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
    sessionState.clearHistory();
    this.setState('idle');
    logger.info('orchestrator', 'History cleared');
  }

  stop(): void {
    this.stopRequested = true;
    this.stepCount = getConfig().agent.maxSteps; // Force exit loop
    // Deny any pending confirmations so waiting actions never execute.
    for (const [, resolve] of this.pendingConfirmations) resolve(false);
    this.pendingConfirmations.clear();
    this.setState('idle', 'Stopped by user');
  }
}

export const orchestrator = new AgentOrchestrator();
