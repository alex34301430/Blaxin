import { AIProvider, parseToolCalls } from './base.js';
export class TogetherProvider extends AIProvider {
    id = 'together';
    name = 'Together AI';
    baseUrl = 'https://api.together.xyz/v1';
    apiKeyRequired = true;
    async fetchModels() {
        if (!this.apiKey)
            throw new Error('API key required');
        try {
            const response = await fetch(`${this.baseUrl}/models`, {
                headers: this.getAuthHeaders(),
            });
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            return (data.data || [])
                .filter(m => m.id && !m.id.includes('embedding') && !m.id.includes('rerank'))
                .slice(0, 100)
                .map(m => ({
                id: m.id,
                name: m.display_name || m.id,
                provider: 'together',
                pricing: m.pricing ? {
                    prompt: parseFloat(m.pricing.prompt || '0'),
                    completion: parseFloat(m.pricing.completion || '0'),
                } : undefined,
                isFree: false,
                isAvailable: true,
                capabilities: ['chat'],
            }));
        }
        catch (error) {
            this.handleError(error, 'model listing');
        }
    }
    async chat(request) {
        if (!this.apiKey)
            throw new Error('API key required');
        const body = {
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
            if (!choice)
                throw new Error('No response from model');
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
                provider: 'together',
            };
        }
        catch (error) {
            this.handleError(error, 'chat completion');
        }
    }
}
//# sourceMappingURL=together.js.map