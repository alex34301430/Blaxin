import { AIRequest, AIResponse, ChatMessage, ModelInfo, ToolCall } from '../types.js';
import { AIProvider, parseToolCalls } from './base.js';
import { logger } from '../utils/logger.js';

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  pricing?: {
    prompt: string;
    completion: string;
    image?: string;
    request?: string;
  };
  context_length?: number;
  top_provider?: {
    max_completion_tokens?: number;
    max_tokens?: number;
  };
  architecture?: {
    modality?: string;
    tokenizer?: string;
    instruct_type?: string;
  };
}

export class OpenRouterProvider extends AIProvider {
  readonly id = 'openrouter' as const;
  readonly name = 'OpenRouter';
  readonly baseUrl = 'https://openrouter.ai/api/v1';
  readonly apiKeyRequired = true;

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      if (response.ok) return { valid: true };
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed. The OpenRouter API key is invalid or has been revoked. Check that the key is active at openrouter.ai/keys.' };
      }
      return { valid: false, error: `OpenRouter returned status ${response.status}` };
    } catch (error: any) {
      if (error?.cause?.code === 'ENOTFOUND') {
        return { valid: false, error: 'Network failure. Unable to reach openrouter.ai. Check your internet connection.' };
      }
      return { valid: false, error: `Connection error: ${error?.message}` };
    }
  }

  async fetchModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) {
      throw new Error('API key required for OpenRouter model discovery');
    }

    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as { data: OpenRouterModel[] };
      const models: ModelInfo[] = [];

      for (const model of data.data || []) {
        const promptPrice = parseFloat(model.pricing?.prompt || '0');
        const completionPrice = parseFloat(model.pricing?.completion || '0');
        const isFree = promptPrice === 0 && completionPrice === 0;
        
        const capabilities: ModelInfo['capabilities'] = ['chat'];
        
        if (model.architecture?.modality) {
          if (model.architecture.modality.includes('image')) capabilities.push('vision');
          if (model.architecture.modality.includes('multimodal')) capabilities.push('multimodal');
        }

        // Models with tool/function calling support - most modern models support this
        const name = model.name.toLowerCase();
        const id = model.id.toLowerCase();
        if (name.includes('gpt') || name.includes('claude') || name.includes('gemini') || 
            name.includes('llama') || name.includes('mistral') || name.includes('qwen') ||
            name.includes('deepseek') || name.includes('command')) {
          capabilities.push('function-calling');
        }

        if (name.includes('code') || name.includes('coder') || name.includes('codestral')) {
          capabilities.push('code-generation');
        }

        // Reasoning models
        if (name.includes('o1') || name.includes('o3') || name.includes('o4') ||
            name.includes('deepseek-r1') || name.includes('reason') ||
            id.includes('o1') || id.includes('o3') || id.includes('deepseek-r1')) {
          capabilities.push('reasoning');
        }

        models.push({
          id: model.id,
          name: model.name,
          provider: 'openrouter',
          pricing: {
            prompt: promptPrice,
            completion: completionPrice,
          },
          isFree,
          isAvailable: true,
          capabilities,
          contextWindow: model.context_length,
          maxOutput: model.top_provider?.max_completion_tokens || model.top_provider?.max_tokens,
          description: model.description,
        });
      }

      // Sort: free first, then by context window
      models.sort((a, b) => {
        if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        return (b.contextWindow || 0) - (a.contextWindow || 0);
      });

      logger.info('openrouter', `Discovered ${models.length} models (${models.filter(m => m.isFree).length} free)`);
      return models;
    } catch (error: any) {
      logger.error('openrouter', 'Failed to fetch models', error);
      throw error;
    }
  }

  async chat(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey) throw new Error('API key required');

    const body: any = {
      model: request.model,
      messages: this.formatMessages(request),
      max_tokens: request.maxTokens || 4096,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://blaxin.ai',
          'X-Title': 'BLAXIN',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData?.error?.message || `HTTP ${response.status}`;
        
        if (response.status === 401) {
          throw new Error(`Authentication failed: ${errorMsg}`);
        }
        if (response.status === 429) {
          throw new Error(`Rate limit exceeded: ${errorMsg}`);
        }
        if (response.status === 404) {
          throw new Error(`Model not found: ${request.model}. The model may have been removed from OpenRouter.`);
        }
        throw new Error(errorMsg);
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      
      if (!choice) {
        throw new Error('No response from model');
      }

      const toolCalls = parseToolCalls(choice.message?.content, choice.message?.tool_calls);

      return {
        message: {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          content: choice.message?.content || '',
          timestamp: Date.now(),
        },
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: data.usage ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        } : undefined,
        model: request.model,
        provider: 'openrouter',
      };
    } catch (error: any) {
      this.handleError(error, 'chat completion');
    }
  }
}
