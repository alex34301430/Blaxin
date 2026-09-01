import { ProviderId, ModelInfo } from '../types.js';
import { AIProvider } from './base.js';
export { AIProvider, ProviderError } from './base.js';
declare class ProviderRegistry {
    private providers;
    private modelsCache;
    private activeProvider;
    private activeModel;
    constructor();
    private register;
    getProvider(id: ProviderId): AIProvider;
    getAllProviders(): AIProvider[];
    initializeAll(): Promise<void>;
    validateKey(providerId: ProviderId, apiKey: string): Promise<{
        valid: boolean;
        error?: string;
    }>;
    saveKey(providerId: ProviderId, apiKey: string): Promise<{
        valid: boolean;
        error?: string;
    }>;
    removeKey(providerId: ProviderId): void;
    getKeyStatus(): Record<string, {
        hasKey: boolean;
        maskedKey?: string;
    }>;
    fetchModels(providerId: ProviderId): Promise<ModelInfo[]>;
    fetchAllAvailableModels(): Promise<ModelInfo[]>;
    setActiveProvider(providerId: ProviderId): void;
    setActiveModel(modelId: string): void;
    getActiveProvider(): ProviderId | null;
    getActiveModel(): string | null;
    getStatus(): Array<{
        id: ProviderId;
        name: string;
        hasKey: boolean;
        maskedKey?: string;
    }>;
}
export declare const providers: ProviderRegistry;
//# sourceMappingURL=index.d.ts.map