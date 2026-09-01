export type ProviderId = 'openrouter' | 'openai' | 'anthropic' | 'google' | 'groq' | 'together' | 'ollama' | 'custom';
export interface ProviderConfig {
    id: ProviderId;
    name: string;
    baseUrl: string;
    apiKeyRequired: boolean;
    apiKeyPrefix?: string;
    description: string;
    icon?: string;
}
export interface ProviderCredentials {
    providerId: ProviderId;
    apiKey: string;
    baseUrl?: string;
}
export interface ModelInfo {
    id: string;
    name: string;
    provider: ProviderId;
    pricing?: {
        prompt: number;
        completion: number;
    };
    isFree: boolean;
    isAvailable: boolean;
    capabilities: ModelCapability[];
    contextWindow?: number;
    maxOutput?: number;
    description?: string;
}
export type ModelCapability = 'chat' | 'completion' | 'vision' | 'function-calling' | 'code-generation' | 'reasoning' | 'multimodal';
export interface ChatMessage {
    id: string;
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    timestamp: number;
    toolCallId?: string;
    name?: string;
}
export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
export interface AIRequest {
    messages: ChatMessage[];
    model: string;
    provider: ProviderId;
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
}
export interface AIResponse {
    message: ChatMessage;
    toolCalls?: ToolCall[];
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    model: string;
    provider: ProviderId;
}
export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
    data?: Record<string, unknown>;
}
export type AgentState = 'idle' | 'thinking' | 'planning' | 'executing' | 'observing' | 'waiting' | 'completed' | 'error' | 'requires-confirmation';
export interface AgentTask {
    id: string;
    instruction: string;
    state: AgentState;
    steps: TaskStep[];
    currentStep: number;
    startTime: number;
    endTime?: number;
    result?: string;
    error?: string;
}
export interface TaskStep {
    id: string;
    description: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    state: 'pending' | 'executing' | 'completed' | 'failed' | 'skipped';
    result?: string;
    error?: string;
}
export type WSEvent = {
    type: 'user-message';
    data: {
        content: string;
    };
} | {
    type: 'agent-message';
    data: ChatMessage;
} | {
    type: 'agent-state';
    data: {
        state: AgentState;
        description?: string;
    };
} | {
    type: 'tool-execution';
    data: {
        toolName: string;
        args: Record<string, unknown>;
        state: string;
    };
} | {
    type: 'task-progress';
    data: AgentTask;
} | {
    type: 'error';
    data: {
        message: string;
        code?: string;
        details?: string;
    };
} | {
    type: 'models-list';
    data: ModelInfo[];
} | {
    type: 'provider-status';
    data: {
        providerId: ProviderId;
        connected: boolean;
        error?: string;
    };
} | {
    type: 'confirmation-required';
    data: {
        taskId: string;
        stepId: string;
        description: string;
        action: string;
    };
} | {
    type: 'health-check';
    data: {
        status: string;
        uptime: number;
    };
};
export interface AppConfig {
    server: {
        port: number;
        host: string;
    };
    agent: {
        maxSteps: number;
        maxRetries: number;
        requireConfirmation: boolean;
        confirmationPatterns: string[];
    };
    tools: Record<string, boolean>;
    appearance: {
        theme: 'dark' | 'cyberpunk';
        accentColor: string;
    };
}
export interface Tool {
    name: string;
    description: string;
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<ToolResult>;
    requiresConfirmation?(args: Record<string, unknown>): boolean;
}
//# sourceMappingURL=types.d.ts.map