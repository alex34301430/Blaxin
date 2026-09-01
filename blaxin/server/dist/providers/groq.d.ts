import { AIRequest, AIResponse, ModelInfo } from '../types.js';
import { AIProvider } from './base.js';
export declare class GroqProvider extends AIProvider {
    readonly id: "groq";
    readonly name = "Groq";
    readonly baseUrl = "https://api.groq.com/openai/v1";
    readonly apiKeyRequired = true;
    fetchModels(): Promise<ModelInfo[]>;
    chat(request: AIRequest): Promise<AIResponse>;
}
//# sourceMappingURL=groq.d.ts.map