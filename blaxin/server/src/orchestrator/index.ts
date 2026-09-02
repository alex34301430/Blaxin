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
  private eventCallback: EventCallback | null = null;
  private stepCount = 0;
  private consecutiveErrors = 0;
  private readonly MAX_CONSECUTIVE_ERRORS = 3;
  private readonly MAX_RETRIES_PER_STEP = 2;

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
    this.emit('agent-state', { state, description });
    logger.info('orchestrator', `State: ${state}${description ? ` - ${description}` : ''}`);
  }

  async processMessage(userMessage: string): Promise<void> {
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

    // Create task
    this.currentTask = {
      id: uuidv4(),
      instruction: userMessage,
      state: 'thinking',
      steps: [],
      currentStep: 0,
      startTime: Date.now(),
    };

    this.consecutiveErrors = 0;
    this.setState('thinking', 'Analyzing your request...');
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
      if (this.currentTask.state === 'thinking' || this.currentTask.state === 'executing') {
        this.currentTask.state = 'completed';
      }
    }

    if (this.currentPlan) {
      this.currentPlan.endTime = Date.now();
      if (this.currentPlan.state === 'planning' || this.currentPlan.state === 'executing') {
        this.currentPlan.state = 'completed';
      }
    }
  }

  private async executeLoop(
    provider: AIProvider,
    modelId: string,
    maxSteps: number,
    providerId?: ProviderId,
  ): Promise<void> {
    while (this.stepCount < maxSteps) {
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
          // Add assistant message with tool calls to history
          const assistantMsg: ChatMessage = {
            id: uuidv4(),
            role: 'assistant',
            content: response.message.content || '',
            timestamp: Date.now(),
          };
          this.conversationHistory.push(assistantMsg);
          sessionState.addMessage(assistantMsg);
          this.emit('agent-message', assistantMsg);

          if (response.message.content) {
            this.emit('activity', { type: 'thinking', content: response.message.content });
          }

          // Execute each tool call
          for (const toolCall of response.toolCalls) {
            await this.executeToolCall(toolCall, provider, modelId, maxSteps);
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

    // Check if confirmation is needed
    if (toolRegistry.requiresConfirmation(toolName, toolArgs)) {
      this.emit('confirmation-required', {
        taskId: this.currentTask?.id,
        stepId: toolCall.id,
        description: `Execute ${toolName}: ${step.description}`,
        action: JSON.stringify({ tool: toolName, args: toolArgs }),
      });
      logger.info('orchestrator', `Confirmation required for ${toolName}`);
    }

    // Describe the action in user-friendly terms
    this.setState('executing', step.description);
    this.emit('tool-execution', { toolName, args: toolArgs, state: 'executing' });
    this.emit('activity', { type: 'executing', content: step.description });

    // Add tool call to conversation
    const toolMsg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCallId: toolCall.id,
    };
    this.conversationHistory.push(toolMsg);
    sessionState.addMessage(toolMsg);

    // Execute the tool with retry for transient errors
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
    this.stepCount = 0;
    this.consecutiveErrors = 0;
    sessionState.clearHistory();
    this.setState('idle');
    logger.info('orchestrator', 'History cleared');
  }

  stop(): void {
    this.stepCount = getConfig().agent.maxSteps; // Force exit loop
    this.setState('idle', 'Stopped by user');
  }
}

export const orchestrator = new AgentOrchestrator();
