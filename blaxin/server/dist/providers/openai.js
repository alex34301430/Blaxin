import { AIProvider, parseToolCalls } from './base.js';
export class OpenAIProvider extends AIProvider {
    id = 'openai';
    name = 'OpenAI';
    baseUrl = 'https://api.openai.com/v1';
    apiKeyRequired = true;
    async fetchModels() {
        if (!this.apiKey)
            throw new Error('API key required');
        try {
            const response = await fetch(`${this.baseUrl}/models`, {
                headers: this.getAuthHeaders(),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            const chatModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo', 'o1', 'o1-mini', 'o1-pro'];
            return data.data
                .filter(m => chatModels.some(cm => m.id.startsWith(cm)) || m.id.includes('gpt'))
                .map(m => ({
                id: m.id,
                name: m.id,
                provider: 'openai',
                isFree: false,
                isAvailable: true,
                capabilities: ['chat', 'function-calling', 'vision'],
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
        if (request.temperature !== undefined) {
            body.temperature = request.temperature;
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
                provider: 'openai',
            };
        }
        catch (error) {
            this.handleError(error, 'chat completion');
        }
    }
}
//# sourceMappingURL=openai.js.map