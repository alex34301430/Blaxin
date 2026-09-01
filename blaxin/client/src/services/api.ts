const API_BASE = '/api';

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Network error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  
  return response.json();
}

export const api = {
  // Health
  health: () => fetchAPI<{ status: string; version: string }>('/health'),

  // Diagnostics
  diagnostics: () => fetchAPI<any>('/diagnostics'),

  // Providers
  getProviders: () => fetchAPI<Array<{ id: string; name: string; hasKey: boolean; maskedKey?: string }>>('/providers'),
  
  validateKey: (providerId: string, apiKey: string) =>
    fetchAPI<{ valid: boolean; error?: string }>(`/providers/${providerId}/validate`, {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    }),

  saveKey: (providerId: string, apiKey: string) =>
    fetchAPI<{ valid: boolean; error?: string }>(`/providers/${providerId}/save-key`, {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    }),

  removeKey: (providerId: string) =>
    fetchAPI(`/providers/${providerId}/key`, { method: 'DELETE' }),

  // Models
  getModels: (providerId: string) =>
    fetchAPI<Array<any>>(`/providers/${providerId}/models`),

  getAllModels: () => fetchAPI<Array<any>>('/models'),

  setActiveModel: (providerId: string, modelId: string) =>
    fetchAPI('/models/active', {
      method: 'POST',
      body: JSON.stringify({ providerId, modelId }),
    }),

  // Tools
  getTools: () => fetchAPI<Array<{ name: string; description: string }>>('/tools'),
  
  getToolStatus: () => fetchAPI<Record<string, boolean>>('/tools/status'),

  toggleTool: (name: string, enabled: boolean) =>
    fetchAPI(`/tools/${name}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  // Agent
  sendMessage: (message: string) =>
    fetchAPI('/agent/message', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  stopAgent: () =>
    fetchAPI('/agent/stop', { method: 'POST' }),

  clearAgent: () =>
    fetchAPI('/agent/clear', { method: 'POST' }),

  getHistory: () => fetchAPI<Array<any>>('/agent/history'),
};
