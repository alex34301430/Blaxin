import { AIProvider } from './base.js';
export class GoogleProvider extends AIProvider {
    id = 'google';
    name = 'Google AI';
    baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    apiKeyRequired = true;
    async fetchModels() {
        if (!this.apiKey)
            throw new Error('API key required');
        try {
            const response = await fetch(`${this.baseUrl}/models?key=${this.apiKey}`);
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            return (data.models || [])
                .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
                .map(m => ({
                id: m.name.replace('models/', ''),
                name: m.displayName || m.name.replace('models/', ''),
                provider: 'google',
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
        const systemMsg = request.messages.find(m => m.role === 'system');
        const contents = request.messages
            .filter(m => m.role !== 'system')
            .map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }));
        const body = {
            contents,
            generationConfig: {
                maxOutputTokens: request.maxTokens || 4096,
            },
        };
        if (systemMsg) {
            body.systemInstruction = { parts: [{ text: systemMsg.content }] };
        }
        if (request.tools && request.tools.length > 0) {
            body.tools = [{
                    functionDeclarations: request.tools.map(t => ({
                        name: t.function.name,
                        description: t.function.description,
                        parameters: t.function.parameters,
                    })),
                }];
        }
        const modelId = request.model || 'gemini-2.0-flash';
        try {
            const response = await fetch(`${this.baseUrl}/models/${modelId}:generateContent?key=${this.apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData?.error?.message || `HTTP ${response.status}`);
            }
            const data = await response.json();
            const candidate = data.candidates?.[0];
            let content = '';
            const toolCalls = [];
            for (const part of candidate?.content?.parts || []) {
                if (part.text)
                    content += part.text;
                if (part.functionCall) {
                    toolCalls.push({
                        id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                        type: 'function',
                        function: {
                            name: part.functionCall.name,
                            arguments: JSON.stringify(part.functionCall.args || {}),
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
                usage: data.usageMetadata ? {
                    promptTokens: data.usageMetadata.promptTokenCount || 0,
                    completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                    totalTokens: data.usageMetadata.totalTokenCount || 0,
                } : undefined,
                model: request.model,
                provider: 'google',
            };
        }
        catch (error) {
            this.handleError(error, 'chat completion');
        }
    }
}
//# sourceMappingURL=google.js.map