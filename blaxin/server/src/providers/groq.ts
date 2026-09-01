import { AIRequest, AIResponse, ModelInfo } from '../types.js';
import { AIProvider, parseToolCalls } from './base.js';
import { logger } from '../utils/logger.js';

export class GroqProvider extends AIProvider {
  readonly id = 'groq' as const;
  readonly name = 'Groq';
  readonly baseUrl = 'https://api.groq.com/openai/v1';
  readonly apiKeyRequired = true;

  async fetchModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) throw new Error('API key required');
    
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.getAuthHeaders(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const data = await response.json() as { data: Array<{ id: string; owned_by: string }> };
      
      return data.data
        .filter(m => m.id.includes('llama') || m.id.includes('mixtral') || m.id.includes('gemma') || m.id.includes('whisper'))
        .map(m => ({
          id: m.id,
          name: m.id,
          provider: 'groq' as const,
          isFree: true, // Groq is generally free/very cheap
          isAvailable: true,
          capabilities: ['chat', 'function-calling'] as ModelInfo['capabilities'],
        }));
    } catch (error: any) {
      this.handleError(error, 'model listing');
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
    }

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.error?.message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      if (!choice) throw new Error('No response from model');

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
        provider: 'groq',
      };
    } catch (error: any) {
      this.handleError(error, 'chat completion');
    }
  }
}
