import { v4 as uuidv4 } from 'uuid';
import { 
  ChatMessage, AgentState, AgentTask, TaskStep, AIResponse, ToolCall,
  ProviderId
} from '../types.js';
import { providers, AIProvider, ProviderError } from '../providers/index.js';
import { toolRegistry } from '../tools/index.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';

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
- Break complex tasks into clear, sequential steps
- Execute one tool action at a time
- After executing a tool, analyze the result before proceeding
- If an action fails, diagnose the failure and try a safe alternative
- Verify important actions (e.g., after clicking, take a screenshot to confirm)
- For destructive operations (delete, overwrite), confirm with the user first
- Report progress clearly and concisely at each step
- Never expose API keys, secrets, or sensitive system information
- When a task is complete, provide a clear summary of what was done

ERROR RECOVERY:
- If a tool fails, analyze why it failed before retrying
- For network errors: check connectivity, try again after a brief pause
- For permission errors: explain what permission is needed
- For missing tools: suggest installing the required tool
- For file not found: check the path, list the directory to find the correct file
- Never retry the exact same failed action more than once
- If recovery is impossible, explain the limitation clearly

VERIFICATION:
- After launching an application, take a screenshot to confirm it opened
- After clicking a button/UI element, verify the expected change occurred
- After writing a file, verify the content was written correctly
- After running a command, check the exit code and output for errors

When using tools:
1. Think about which tool is needed and why
2. Provide the correct arguments with proper formatting
3. Wait for the tool result
4. Analyze the result - did it succeed? If not, why?
5. Decide the next step based on the result

Always provide a clear final answer when the task is complete.`;

export class AgentOrchestrator {
  private conversationHistory: ChatMessage[] = [];
  private currentTask: AgentTask | null = null;
  private state: AgentState = 'idle';
  private eventCallback: EventCallback | null = null;
  private stepCount = 0;

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

    this.setState('thinking', 'Processing your request...');
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
  }

  private async executeLoop(
    provider: AIProvider,
    modelId: string,
    maxSteps: number,
    providerId?: ProviderId,
  ): Promise<void> {
    while (this.stepCount < maxSteps) {
      this.stepCount++;

      // Build messages for the AI
      const messages: ChatMessage[] = [
        {
          id: 'system',
          role: 'system',
          content: SYSTEM_PROMPT,
          timestamp: Date.now(),
        },
        ...this.conversationHistory.slice(-20), // Keep last 20 messages for context
      ];

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
          this.emit('agent-message', assistantMsg);

          if (response.message.content) {
            this.emit('activity', { type: 'thinking', content: response.message.content });
          }

          // Execute each tool call
          for (const toolCall of response.toolCalls) {
            await this.executeToolCall(toolCall, provider, modelId, maxSteps);
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
          this.emit('agent-message', assistantMsg);

          this.setState('completed', 'Task completed');
          return;
        }
      } catch (error: any) {
        if (error instanceof ProviderError) {
          this.emit('error', {
            message: error.message,
            code: error.code,
            details: `Provider: ${error.providerId}`,
          });
          this.setState('error', error.message);
          return;
        }
        throw error;
      }
    }

    // Reached max steps
    this.emit('agent-message', {
      id: uuidv4(),
      role: 'assistant',
      content: `I've reached the maximum number of steps (${maxSteps}) for this task. Let me summarize what was accomplished.`,
      timestamp: Date.now(),
    });
    this.setState('completed', 'Reached step limit');
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
    }

    // Check if confirmation is needed
    if (toolRegistry.requiresConfirmation(toolName, toolArgs)) {
      this.emit('confirmation-required', {
        taskId: this.currentTask?.id,
        stepId: toolCall.id,
        description: `Execute ${toolName}`,
        action: JSON.stringify({ tool: toolName, args: toolArgs }),
      });
      logger.info('orchestrator', `Confirmation required for ${toolName} but proceeding`);
    }

    // Describe the action in user-friendly terms
    const actionDescription = this.describeToolAction(toolName, toolArgs);
    this.setState('executing', actionDescription);
    this.emit('tool-execution', { toolName, args: toolArgs, state: 'executing' });
    this.emit('activity', { type: 'executing', content: actionDescription });

    // Add tool call to conversation
    const toolMsg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCallId: toolCall.id,
    };
    this.conversationHistory.push(toolMsg);

    // Execute the tool with retry for transient errors
    let result = await toolRegistry.execute(toolName, toolArgs);
    let retries = 0;
    const maxRetries = 1; // Only retry once for transient errors

    while (!result.success && retries < maxRetries && this.isRetryableError(result.error || '')) {
      retries++;
      logger.info('orchestrator', `Retrying tool ${toolName} (attempt ${retries + 1})`);
      this.emit('activity', { type: 'retrying', content: `Retrying ${toolName}...` });
      await new Promise(r => setTimeout(r, 1000)); // Brief pause before retry
      result = await toolRegistry.execute(toolName, toolArgs);
    }

    this.emit('tool-execution', {
      toolName,
      args: toolArgs,
      state: result.success ? 'completed' : 'failed',
      result: result.output?.slice(0, 500),
    });

    // Add tool result to conversation
    const resultMsg: ChatMessage = {
      id: uuidv4(),
      role: 'tool',
      content: result.success
        ? `Tool result: ${result.output}`
        : `Tool error: ${result.error || 'Unknown error'}`,
      timestamp: Date.now(),
      toolCallId: toolCall.id,
      name: toolName,
    };
    this.conversationHistory.push(resultMsg);

    logger.info('orchestrator', `Tool ${toolName}: ${result.success ? 'success' : 'failed'}`);
  }

  private isRetryableError(error: string): boolean {
    const retryable = ['timeout', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'network', 'temporary'];
    return retryable.some(r => error.toLowerCase().includes(r));
  }

  private describeToolAction(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case 'terminal':
        return `Running: ${(args.command as string || '').slice(0, 60)}`;
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
      case 'filesystem':
        return `File operation: ${args.operation} on ${(args.path as string || '').split('/').pop()}`;
      case 'browser':
        if (args.action === 'search') return `Searching: ${args.query}`;
        if (args.action === 'open_url') return `Opening: ${args.url}`;
        return `Browser: ${args.action}`;
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
    this.stepCount = 0;
    this.setState('idle');
    logger.info('orchestrator', 'History cleared');
  }

  stop(): void {
    this.stepCount = getConfig().agent.maxSteps; // Force exit loop
    this.setState('idle', 'Stopped by user');
  }
}

export const orchestrator = new AgentOrchestrator();
