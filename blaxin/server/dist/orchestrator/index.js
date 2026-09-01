import { v4 as uuidv4 } from 'uuid';
import { providers, ProviderError } from '../providers/index.js';
import { toolRegistry } from '../tools/index.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
const SYSTEM_PROMPT = `You are BLAXIN, an advanced AI desktop agent. You can control the computer, execute terminal commands, manage files, browse the web, and complete complex multi-step tasks.

CAPABILITIES:
- Execute terminal commands
- Read, write, and manage files
- Control the desktop GUI (mouse, keyboard, windows)
- Take screenshots to observe the screen
- Open and interact with browsers
- Search the web
- Use the clipboard
- Get system information

BEHAVIOR:
- Break complex tasks into clear steps
- Execute one action at a time
- Verify results after important actions
- If an action fails, try an alternative approach
- Ask for confirmation before destructive operations
- Report progress clearly and concisely
- Never expose API keys or secrets

When using tools:
1. Think about which tool is needed
2. Provide the correct arguments
3. Wait for the result
4. Analyze the result
5. Decide the next step

Always provide a clear final answer when the task is complete.`;
export class AgentOrchestrator {
    conversationHistory = [];
    currentTask = null;
    state = 'idle';
    eventCallback = null;
    stepCount = 0;
    setEventCallback(callback) {
        this.eventCallback = callback;
    }
    emit(event, data) {
        if (this.eventCallback) {
            this.eventCallback(event, data);
        }
    }
    setState(state, description) {
        this.state = state;
        this.emit('agent-state', { state, description });
        logger.info('orchestrator', `State: ${state}${description ? ` - ${description}` : ''}`);
    }
    async processMessage(userMessage) {
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
        const userMsg = {
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
        }
        catch (error) {
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
    async executeLoop(provider, modelId, maxSteps, providerId) {
        while (this.stepCount < maxSteps) {
            this.stepCount++;
            // Build messages for the AI
            const messages = [
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
                    const assistantMsg = {
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
                }
                else {
                    // No tool calls - this is the final response
                    const assistantMsg = {
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
            }
            catch (error) {
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
    async executeToolCall(toolCall, provider, modelId, maxSteps) {
        const toolName = toolCall.function.name;
        let toolArgs;
        try {
            toolArgs = JSON.parse(toolCall.function.arguments);
        }
        catch {
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
            // For now, we'll proceed with confirmation. In production, this would wait.
            logger.info('orchestrator', `Confirmation required for ${toolName} but proceeding`);
        }
        this.setState('executing', `Using tool: ${toolName}`);
        this.emit('tool-execution', { toolName, args: toolArgs, state: 'executing' });
        // Add tool call to conversation
        const toolMsg = {
            id: uuidv4(),
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            toolCallId: toolCall.id,
        };
        this.conversationHistory.push(toolMsg);
        // Execute the tool
        const result = await toolRegistry.execute(toolName, toolArgs);
        this.emit('tool-execution', {
            toolName,
            args: toolArgs,
            state: result.success ? 'completed' : 'failed',
            result: result.output?.slice(0, 500),
        });
        // Add tool result to conversation
        const resultMsg = {
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
    getState() {
        return this.state;
    }
    getCurrentTask() {
        return this.currentTask;
    }
    getConversationHistory() {
        return this.conversationHistory;
    }
    clearHistory() {
        this.conversationHistory = [];
        this.currentTask = null;
        this.stepCount = 0;
        this.setState('idle');
        logger.info('orchestrator', 'History cleared');
    }
    stop() {
        this.stepCount = getConfig().agent.maxSteps; // Force exit loop
        this.setState('idle', 'Stopped by user');
    }
}
export const orchestrator = new AgentOrchestrator();
//# sourceMappingURL=index.js.map