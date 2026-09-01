import { AIRequest, AIResponse, ModelInfo } from '../types.js';
import { AIProvider } from './base.js';
export declare class OpenAIProvider extends AIProvider {
    readonly id: "openai";
    readonly name = "OpenAI";
    readonly baseUrl = "https://api.openai.com/v1";
    readonly apiKeyRequired = true;
    fetchModels(): Promise<ModelInfo[]>;
    chat(request: AIRequest): Promise<AIResponse>;
}
//# sourceMappingURL=openai.d.ts.map