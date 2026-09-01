import { AIRequest, AIResponse, ModelInfo, ProviderId, ToolCall } from '../types.js';
export declare abstract class AIProvider {
    abstract readonly id: ProviderId;
    abstract readonly name: string;
    abstract readonly baseUrl: string;
    abstract readonly apiKeyRequired: boolean;
    protected apiKey: string | null;
    initialize(): Promise<void>;
    setApiKey(key: string): void;
    getApiKey(): string | null;
    hasApiKey(): boolean;
    validateKey(apiKey: string): Promise<{
        valid: boolean;
        error?: string;
    }>;
    abstract fetchModels(): Promise<ModelInfo[]>;
    abstract chat(request: AIRequest): Promise<AIResponse>;
    protected getAuthHeaders(): Record<string, string>;
    protected formatMessages(request: AIRequest): any[];
    protected handleError(error: any, context: string): never;
}
export declare class ProviderError extends Error {
    readonly code: string;
    readonly providerId: ProviderId;
    constructor(message: string, code: string, providerId: ProviderId);
}
export declare function parseToolCalls(content: string | null, toolCalls?: any[]): ToolCall[];
//# sourceMappingURL=base.d.ts.map