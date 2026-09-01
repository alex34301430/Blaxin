import { AIRequest, AIResponse, ModelInfo } from '../types.js';
import { AIProvider } from './base.js';
export declare class OpenRouterProvider extends AIProvider {
    readonly id: "openrouter";
    readonly name = "OpenRouter";
    readonly baseUrl = "https://openrouter.ai/api/v1";
    readonly apiKeyRequired = true;
    validateKey(apiKey: string): Promise<{
        valid: boolean;
        error?: string;
    }>;
    fetchModels(): Promise<ModelInfo[]>;
    chat(request: AIRequest): Promise<AIResponse>;
}
//# sourceMappingURL=openrouter.d.ts.map