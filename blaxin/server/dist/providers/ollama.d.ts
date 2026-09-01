import { AIRequest, AIResponse, ModelInfo } from '../types.js';
import { AIProvider } from './base.js';
export declare class OllamaProvider extends AIProvider {
    readonly id: "ollama";
    readonly name = "Ollama (Local)";
    readonly baseUrl = "http://localhost:11434";
    readonly apiKeyRequired = false;
    initialize(): Promise<void>;
    validateKey(_apiKey?: string): Promise<{
        valid: boolean;
        error?: string;
    }>;
    fetchModels(): Promise<ModelInfo[]>;
    chat(request: AIRequest): Promise<AIResponse>;
}
//# sourceMappingURL=ollama.d.ts.map