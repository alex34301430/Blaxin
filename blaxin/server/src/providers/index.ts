import { ProviderId, ModelInfo } from '../types.js';
import { AIProvider, ProviderError, ProviderHealth } from './base.js';
import { OpenRouterProvider } from './openrouter.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { GroqProvider } from './groq.js';
import { TogetherProvider } from './together.js';
import { OllamaProvider } from './ollama.js';
import { credentialStore } from '../utils/credentials.js';
import { logger } from '../utils/logger.js';

export { AIProvider, ProviderError } from './base.js';

// ── Fallback Order ──────────────────────────────────────────────

const FALLBACK_ORDER: ProviderId[] = [
  'openrouter', 'openai', 'anthropic', 'google', 'groq', 'together', 'ollama',
];

// ── Health Check Interval ───────────────────────────────────────

const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Provider Registry ───────────────────────────────────────────

class ProviderRegistry {
  private providers: Map<ProviderId, AIProvider> = new Map();
  private modelsCache: Map<ProviderId, ModelInfo[]> = new Map();
  private activeProvider: ProviderId | null = null;
  private activeModel: string | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.register(new OpenRouterProvider());
    this.register(new OpenAIProvider());
    this.register(new AnthropicProvider());
    this.register(new GoogleProvider());
    this.register(new GroqProvider());
    this.register(new TogetherProvider());
    this.register(new OllamaProvider());
  }

  private register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
    logger.info('providers', `Registered provider: ${provider.name}`);
  }

  getProvider(id: ProviderId): AIProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    return provider;
  }

  getAllProviders(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  async initializeAll(): Promise<void> {
    for (const provider of this.providers.values()) {
      try {
        await provider.initialize();
      } catch (error) {
        logger.warn('providers', `Failed to initialize ${provider.name}`, error);
      }
    }

    // Start periodic health checks
    this.startHealthChecks();
  }

  private startHealthChecks(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(async () => {
      for (const provider of this.providers.values()) {
        if (!provider.apiKeyRequired || provider.hasApiKey()) {
          try {
            await provider.healthCheck();
          } catch {}
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    logger.info('providers', 'Periodic health checks enabled');
  }

  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  async validateKey(providerId: ProviderId, apiKey: string): Promise<{ valid: boolean; error?: string }> {
    const provider = this.getProvider(providerId);
    return provider.validateKey(apiKey);
  }

  async saveKey(providerId: ProviderId, apiKey: string): Promise<{ valid: boolean; error?: string }> {
    const validation = await this.validateKey(providerId, apiKey);
    if (validation.valid) {
      credentialStore.save(providerId, apiKey);
      const provider = this.getProvider(providerId);
      (provider as any).apiKey = apiKey;
      logger.info('providers', `API key saved for ${provider.name}`);
    }
    return validation;
  }

  removeKey(providerId: ProviderId): void {
    credentialStore.remove(providerId);
    const provider = this.getProvider(providerId);
    (provider as any).apiKey = null;
    logger.info('providers', `API key removed for ${provider.name}`);
  }

  getKeyStatus(): Record<string, { hasKey: boolean; maskedKey?: string }> {
    return credentialStore.getAll();
  }

  async fetchModels(providerId: ProviderId): Promise<ModelInfo[]> {
    const provider = this.getProvider(providerId);
    try {
      const models = await provider.fetchModels();
      this.modelsCache.set(providerId, models);
      return models;
    } catch (error: any) {
      logger.error('providers', `Failed to fetch models for ${provider.name}`, error);
      throw error;
    }
  }

  async fetchAllAvailableModels(): Promise<ModelInfo[]> {
    const allModels: ModelInfo[] = [];
    const statuses = this.getKeyStatus();

    for (const provider of this.providers.values()) {
      if (provider.apiKeyRequired && !statuses[provider.id]?.hasKey) continue;
      if (provider.id === 'ollama') {
        try {
          const models = await provider.fetchModels();
          allModels.push(...models);
        } catch {}
        continue;
      }
      try {
        const models = await provider.fetchModels();
        allModels.push(...models);
      } catch {
        // Skip providers that fail
      }
    }

    return allModels;
  }

  /**
   * Get fallback provider when active provider fails.
   * Returns the next healthy provider in the fallback chain.
   */
  getFallbackProvider(failedProviderId: ProviderId): AIProvider | null {
    const candidates = FALLBACK_ORDER.filter(id => id !== failedProviderId);
    
    for (const id of candidates) {
      const provider = this.providers.get(id);
      if (provider && provider.hasApiKey() && provider.isHealthy()) {
        logger.info('providers', `Fallback from ${failedProviderId} to ${provider.name}`);
        return provider;
      }
    }

    // If no healthy fallback, try any provider with a key
    for (const id of candidates) {
      const provider = this.providers.get(id);
      if (provider && provider.hasApiKey()) {
        logger.info('providers', `Fallback (unverified) from ${failedProviderId} to ${provider.name}`);
        return provider;
      }
    }

    return null;
  }

  /**
   * Get health status for all providers.
   */
  async getHealthStatus(): Promise<Array<{ id: ProviderId; name: string; health: ProviderHealth }>> {
    const statuses: Array<{ id: ProviderId; name: string; health: ProviderHealth }> = [];
    
    for (const provider of this.providers.values()) {
      const health = provider.getHealth();
      statuses.push({
        id: provider.id,
        name: provider.name,
        health,
      });
    }

    return statuses;
  }

  setActiveProvider(providerId: ProviderId): void {
    this.activeProvider = providerId;
    logger.info('providers', `Active provider set to ${providerId}`);
  }

  setActiveModel(modelId: string): void {
    this.activeModel = modelId;
    logger.info('providers', `Active model set to ${modelId}`);
  }

  getActiveProvider(): ProviderId | null {
    return this.activeProvider;
  }

  getActiveModel(): string | null {
    return this.activeModel;
  }

  getStatus(): Array<{ id: ProviderId; name: string; hasKey: boolean; maskedKey?: string; healthy?: boolean }> {
    return this.getAllProviders().map(p => {
      const keyStatus = credentialStore.get(p.id);
      return {
        id: p.id,
        name: p.name,
        hasKey: keyStatus !== null,
        maskedKey: keyStatus ? credentialStore.maskKey(keyStatus) : undefined,
        healthy: p.isHealthy(),
      };
    });
  }
}

export const providers = new ProviderRegistry();
