import { AIRequest, AIResponse, ModelInfo } from '../types.js';
import { AIProvider } from './base.js';
export declare class GoogleProvider extends AIProvider {
    readonly id: "google";
    readonly name = "Google AI";
    readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta";
    readonly apiKeyRequired = true;
    fetchModels(): Promise<ModelInfo[]>;
    chat(request: AIRequest): Promise<AIResponse>;
}
//# sourceMappingURL=google.d.ts.map