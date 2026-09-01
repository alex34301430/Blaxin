import { AIRequest, AIResponse, ModelInfo } from '../types.js';
import { AIProvider } from './base.js';
import { logger } from '../utils/logger.js';

export class AnthropicProvider extends AIProvider {
  readonly id = 'anthropic' as const;
  readonly name = 'Anthropic';
  readonly baseUrl = 'https://api.anthropic.com/v1';
  readonly apiKeyRequired = true;

  async fetchModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) throw new Error('API key required');
    
    // Anthropic doesn't have a public model listing endpoint
    // Return known models
    return [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', isFree: false, isAvailable: true, capabilities: ['chat', 'vision', 'function-calling', 'code-generation'], contextWindow: 200000, maxOutput: 8192 },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: 'anthropic', isFree: false, isAvailable: true, capabilities: ['chat', 'vision', 'function-calling', 'code-generation'], contextWindow: 200000, maxOutput: 8192 },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'anthropic', isFree: false, isAvailable: true, capabilities: ['chat', 'vision', 'function-calling'], contextWindow: 200000, maxOutput: 8192 },
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', provider: 'anthropic', isFree: false, isAvailable: true, capabilities: ['chat', 'vision', 'function-calling', 'reasoning'], contextWindow: 200000, maxOutput: 4096 },
    ];
  }

  async chat(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey) throw new Error('API key required');

    // Extract system message
    const systemMsg = request.messages.find(m => m.role === 'system');
    const nonSystemMsgs = request.messages.filter(m => m.role !== 'system');

    const body: any = {
      model: request.model,
      max_tokens: request.maxTokens || 4096,
      messages: nonSystemMsgs.map(m => ({
        role: m.role,
        content: m.content,
      })),
    };

    if (systemMsg) {
      body.system = systemMsg.content;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    try {
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey!,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.error?.message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      
      let content = '';
      const toolCalls: any[] = [];
      
      for (const block of data.content || []) {
        if (block.type === 'text') {
          content += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      return {
        message: {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          content,
          timestamp: Date.now(),
        },
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: data.usage ? {
          promptTokens: data.usage.input_tokens,
          completionTokens: data.usage.output_tokens,
          totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        } : undefined,
        model: request.model,
        provider: 'anthropic',
      };
    } catch (error: any) {
      this.handleError(error, 'chat completion');
    }
  }
}
