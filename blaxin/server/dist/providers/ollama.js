import { AIProvider, parseToolCalls } from './base.js';
import { logger } from '../utils/logger.js';
export class OllamaProvider extends AIProvider {
    id = 'ollama';
    name = 'Ollama (Local)';
    baseUrl = 'http://localhost:11434';
    apiKeyRequired = false;
    async initialize() {
        // Ollama doesn't need an API key
        logger.info('ollama', 'Ollama provider initialized (local)');
    }
    async validateKey(_apiKey) {
        try {
            const response = await fetch('http://localhost:11434/api/tags');
            if (response.ok)
                return { valid: true };
            return { valid: false, error: 'Ollama is not running. Start it with: ollama serve' };
        }
        catch {
            return { valid: false, error: 'Ollama is not running on localhost:11434. Start it with: ollama serve' };
        }
    }
    async fetchModels() {
        try {
            const response = await fetch('http://localhost:11434/api/tags');
            if (!response.ok)
                throw new Error('Ollama not running');
            const data = await response.json();
            return (data.models || []).map(m => ({
                id: m.name,
                name: m.name,
                provider: 'ollama',
                isFree: true,
                isAvailable: true,
                capabilities: ['chat'],
            }));
        }
        catch (error) {
            logger.warn('ollama', 'Failed to fetch models - is Ollama running?');
            return [];
        }
    }
    async chat(request) {
        const systemMsg = request.messages.find(m => m.role === 'system');
        const nonSystemMsgs = request.messages.filter(m => m.role !== 'system');
        const body = {
            model: request.model,
            messages: [
                ...(systemMsg ? [{ role: 'system', content: systemMsg.content }] : []),
                ...nonSystemMsgs.map(m => ({ role: m.role, content: m.content })),
            ],
            stream: false,
            options: {
                num_predict: request.maxTokens || 4096,
            },
        };
        if (request.tools && request.tools.length > 0) {
            body.tools = request.tools.map(t => ({
                type: 'function',
                function: {
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters,
                },
            }));
        }
        try {
            const response = await fetch('http://localhost:11434/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData?.error || `HTTP ${response.status}`);
            }
            const data = await response.json();
            let content = data.message?.content || '';
            const toolCalls = parseToolCalls(content, data.message?.tool_calls);
            return {
                message: {
                    id: `msg_${Date.now()}`,
                    role: 'assistant',
                    content,
                    timestamp: Date.now(),
                },
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                usage: data.prompt_eval_count ? {
                    promptTokens: data.prompt_eval_count,
                    completionTokens: data.eval_count || 0,
                    totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
                } : undefined,
                model: request.model,
                provider: 'ollama',
            };
        }
        catch (error) {
            this.handleError(error, 'chat completion');
        }
    }
}
//# sourceMappingURL=ollama.js.map