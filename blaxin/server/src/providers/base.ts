import { AIRequest, AIResponse, ChatMessage, ModelInfo, ProviderId, ToolCall } from '../types.js';
import { credentialStore } from '../utils/credentials.js';
import { logger } from '../utils/logger.js';

// ── Provider Health ─────────────────────────────────────────────

export interface ProviderHealth {
  healthy: boolean;
  lastCheck: number;
  latencyMs?: number;
  error?: string;
  consecutiveFailures: number;
}

// ── Retry Helper ────────────────────────────────────────────────

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    retryableErrors?: string[];
  } = {},
): Promise<T> {
  const { maxRetries = 2, baseDelayMs = 1000, maxDelayMs = 10000, retryableErrors = [] } = options;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const msg = error?.message || String(error);
      const isRetryable = retryableErrors.some(e => msg.toLowerCase().includes(e.toLowerCase())) ||
        msg.includes('429') || msg.includes('502') || msg.includes('503') || msg.includes('ECONNRESET');
      
      if (attempt === maxRetries || !isRetryable) {
        throw error;
      }

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      logger.warn('provider', `Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${msg.slice(0, 100)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

// ── Fetch with Timeout ──────────────────────────────────────────

export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 30000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Base Provider ───────────────────────────────────────────────

export abstract class AIProvider {
  abstract readonly id: ProviderId;
  abstract readonly name: string;
  abstract readonly baseUrl: string;
  abstract readonly apiKeyRequired: boolean;

  protected apiKey: string | null = null;
  private health: ProviderHealth = {
    healthy: false,
    lastCheck: 0,
    consecutiveFailures: 0,
  };

  async initialize(): Promise<void> {
    this.apiKey = credentialStore.get(this.id);
    if (this.apiKeyRequired && !this.apiKey) {
      logger.warn(this.id, 'No API key configured');
    }
  }

  setApiKey(key: string): void {
    this.apiKey = key;
    credentialStore.save(this.id, key);
  }

  getApiKey(): string | null {
    return this.apiKey;
  }

  hasApiKey(): boolean {
    return this.apiKey !== null && this.apiKey.length > 0;
  }

  getHealth(): ProviderHealth {
    return { ...this.health };
  }

  isHealthy(): boolean {
    return this.health.healthy;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const result = await this.validateKey(this.apiKey || '');
      this.health = {
        healthy: result.valid,
        lastCheck: Date.now(),
        latencyMs: Date.now() - start,
        error: result.error,
        consecutiveFailures: result.valid ? 0 : this.health.consecutiveFailures + 1,
      };
    } catch (error: any) {
      this.health = {
        healthy: false,
        lastCheck: Date.now(),
        latencyMs: Date.now() - start,
        error: error.message,
        consecutiveFailures: this.health.consecutiveFailures + 1,
      };
    }
    return this.health;
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeoutMs: 10000,
      });
      if (response.ok) {
        return { valid: true };
      }
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed. The API key is invalid or has been revoked.' };
      }
      if (response.status === 403) {
        return { valid: false, error: 'Access denied. The API key may not have permission for this resource.' };
      }
      if (response.status === 429) {
        return { valid: false, error: 'Rate limited. Too many requests. Please wait and try again.' };
      }
      return { valid: false, error: `Validation failed with status ${response.status}` };
    } catch (error: any) {
      if (error?.cause?.code === 'ENOTFOUND') {
        return { valid: false, error: 'Network failure. Unable to reach the provider server. Check your internet connection.' };
      }
      if (error?.cause?.code === 'ECONNREFUSED') {
        return { valid: false, error: 'Connection refused. The provider server is not responding.' };
      }
      if (error.message?.includes('timed out')) {
        return { valid: false, error: 'Connection timed out. The provider may be unreachable.' };
      }
      return { valid: false, error: `Network error: ${error?.message || 'Unknown error'}` };
    }
  }

  abstract fetchModels(): Promise<ModelInfo[]>;
  abstract chat(request: AIRequest): Promise<AIResponse>;

  protected getAuthHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  protected formatMessages(request: AIRequest): any[] {
    return request.messages.map(m => ({
      role: m.role,
      content: m.content,
    }));
  }

  protected handleError(error: any, context: string): never {
    const msg = error?.message || String(error);
    
    if (msg.includes('401') || msg.includes('Unauthorized')) {
      throw new ProviderError('Authentication failed. Your API key is invalid or expired.', 'AUTH_FAILED', this.id);
    }
    if (msg.includes('429') || msg.includes('Rate limit')) {
      throw new ProviderError('Rate limit exceeded. Please wait before trying again.', 'RATE_LIMIT', this.id);
    }
    if (msg.includes('ENOTFOUND') || msg.includes('network')) {
      throw new ProviderError('Network failure. Check your internet connection.', 'NETWORK_ERROR', this.id);
    }
    if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
      throw new ProviderError('Provider server error. The service may be temporarily unavailable.', 'SERVER_ERROR', this.id);
    }
    if (msg.includes('timed out') || msg.includes('abort')) {
      throw new ProviderError('Request timed out. The provider may be slow or unreachable.', 'TIMEOUT', this.id);
    }
    
    throw new ProviderError(`Error in ${context}: ${msg}`, 'UNKNOWN', this.id);
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly providerId: ProviderId,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function parseToolCalls(content: string | null, toolCalls?: any[]): ToolCall[] {
  const calls: ToolCall[] = [];
  
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      calls.push({
        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        type: 'function',
        function: {
          name: tc.function?.name || tc.name || '',
          arguments: typeof tc.function?.arguments === 'string' 
            ? tc.function.arguments 
            : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
        },
      });
    }
  }
  
  return calls;
}
