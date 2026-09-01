import { AIRequest, AIResponse, ModelInfo } from '../types.js';
import { AIProvider } from './base.js';
export declare class TogetherProvider extends AIProvider {
    readonly id: "together";
    readonly name = "Together AI";
    readonly baseUrl = "https://api.together.xyz/v1";
    readonly apiKeyRequired = true;
    fetchModels(): Promise<ModelInfo[]>;
    chat(request: AIRequest): Promise<AIResponse>;
}
//# sourceMappingURL=together.d.ts.map