import { getApiBase } from './endpoints';

// BLAXIN API client.
//
// Error handling contract:
// - Never surface raw engine-level parse errors (WebKitGTK throws
//   "The string did not match the expected pattern." when response.json()
//   meets an empty/non-JSON body). We always read the body as text and
//   parse it ourselves, translating failures into human-readable errors.
// - Never echo secrets. Server responses already avoid keys, but the
//   error message shown to the user must stay useful even on failure.

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function httpStatusLabel(status: number): string {
  if (status === 0) return 'Network error';
  if (status === 400) return 'Bad request (HTTP 400)';
  if (status === 401) return 'Unauthorized (HTTP 401)';
  if (status === 403) return 'Forbidden (HTTP 403)';
  if (status === 404) return 'Not found (HTTP 404)';
  if (status === 429) return 'Rate limited (HTTP 429)';
  if (status >= 500) return `Server error (HTTP ${status})`;
  return `HTTP ${status}`;
}

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${getApiBase()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      `Could not reach the BLAXIN backend (${reason}). Check that the backend is running.`,
      0,
    );
  }

  // Read as text first so we never hand a broken body to response.json().
  const text = await response.text().catch(() => '');

  let data: any = null;
  let bodyIsJson = false;
  if (text) {
    try {
      data = JSON.parse(text);
      bodyIsJson = true;
    } catch {
      bodyIsJson = false;
    }
  }

  if (!response.ok) {
    const serverMessage = data && (data.error || data.message);
    const message = typeof serverMessage === 'string' && serverMessage
      ? serverMessage
      : `${httpStatusLabel(response.status)} while contacting the BLAXIN backend.`;
    throw new ApiError(message, response.status, data?.code);
  }

  // A 2xx with a non-JSON (or empty) body means the request hit the wrong
  // server (e.g. an asset server instead of the backend). Report that
  // explicitly instead of letting the engine throw a cryptic parse error.
  if (!bodyIsJson && text.trim().length > 0) {
    throw new ApiError(
      'The BLAXIN backend returned an unexpected response. The server may be misconfigured.',
      response.status,
      'INVALID_RESPONSE',
    );
  }
  if (!bodyIsJson && text.trim().length === 0) {
    throw new ApiError(
      'The BLAXIN backend returned an empty response. Check that the backend is running.',
      response.status,
      'EMPTY_RESPONSE',
    );
  }

  return data as T;
}

export const api = {
  // Health
  health: () => fetchAPI<{ status: string; version: string; uptime: number }>('/health'),

  // Update check
  updateCheck: () =>
    fetchAPI<{
      updateAvailable: boolean;
      currentVersion?: string;
      latestVersion?: string;
      majorUpdate?: boolean;
      releaseName?: string;
      releaseNotes?: string;
      releaseDate?: string;
      downloadUrl?: string;
      assets?: Array<{ name: string; size: number; downloadUrl: string; contentType: string }>;
      error?: string;
    }>('/update/check'),

  // Diagnostics
  diagnostics: () => fetchAPI<any>('/diagnostics'),

  // Providers
  getProviders: () => fetchAPI<Array<{ id: string; name: string; hasKey: boolean; maskedKey?: string }>>('/providers'),

  validateKey: (providerId: string, apiKey: string) =>
    fetchAPI<{ valid: boolean; error?: string; code?: string }>(`/providers/${providerId}/validate`, {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    }),

  saveKey: (providerId: string, apiKey: string, opts?: { skipValidation?: boolean }) =>
    fetchAPI<{ valid: boolean; error?: string; code?: string }>(`/providers/${providerId}/save-key`, {
      method: 'POST',
      body: JSON.stringify({ apiKey, skipValidation: opts?.skipValidation }),
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

  // Memory
  getMemory: () => fetchAPI<Array<any>>('/memory'),
  clearMemory: () => fetchAPI('/memory', { method: 'DELETE' }),

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
