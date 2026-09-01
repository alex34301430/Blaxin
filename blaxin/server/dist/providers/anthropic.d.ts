import { AIRequest, AIResponse, ModelInfo } from '../types.js';
import { AIProvider } from './base.js';
export declare class AnthropicProvider extends AIProvider {
    readonly id: "anthropic";
    readonly name = "Anthropic";
    readonly baseUrl = "https://api.anthropic.com/v1";
    readonly apiKeyRequired = true;
    fetchModels(): Promise<ModelInfo[]>;
    chat(request: AIRequest): Promise<AIResponse>;
}
//# sourceMappingURL=anthropic.d.ts.map