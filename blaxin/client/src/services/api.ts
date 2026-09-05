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

export interface MetricsToolTiming {
  name: string;
  ms: number;
  attempts: number;
  state: string;
}

export interface MetricsTask {
  taskId: string;
  kind: 'direct' | 'llm';
  startedAt: number;
  queueWaitMs: number;
  totalMs: number;
  modelCalls: number;
  modelMs: number;
  toolCalls: number;
  waves: number;
  parallelWaves: number;
  tools: MetricsToolTiming[];
  result: string;
}

export interface MetricsSummary {
  samples: number;
  totalMs: { median: number; p95: number; min: number; max: number };
  queueWaitMs: { median: number; p95: number };
  modelMs: { median: number; p95: number };
  toolMs: { median: number; p95: number };
  modelCalls: number;
  toolCalls: number;
  totalModelMs: number;
  totalToolMs: number;
  waves: number;
  parallelWaves: number;
  direct: number;
  llm: number;
  errors: number;
  byKind: {
    direct: { count: number; medianMs: number; p95Ms: number };
    llm: { count: number; medianMs: number; p95Ms: number };
  };
}

export interface MetricsResponse {
  summary: MetricsSummary;
  tasks: MetricsTask[];
}

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

// ── Distributed Brain (external mode) ─────────────────────────

export interface BrainLinkStatus {
  state: string;
  phase: string;
  brainId: string | null;
  brainName: string | null;
  protocol: number | null;
  sessionId: string | null;
  connectedAt: number | null;
  lastError: string | null;
  url?: string;
  transport?: 'ws' | 'wss';
  secure?: boolean;
}

export interface BrainStatusResponse {
  mode: 'embedded' | 'external';
  bodyId: string | null;
  brain?: BrainLinkStatus | null;
  capabilities?: string[];
  task?: {
    id: string;
    state: string;
    instruction: string;
    steps?: Array<{ id: string; description: string; state: string }>;
  } | null;
}

export interface BrainDevice {
  bodyId: string;
  name: string;
  capabilities: string[];
  status: 'online' | 'offline' | 'revoked' | string;
  lastSeen?: number | null;
  pairedAt?: number | null;
  revokedAt?: number | null;
  protocol?: { min: number; max: number };
}

export interface BrainRegistrySnapshot {
  version: number;
  devices: BrainDevice[];
}

export interface BrainRegistryStatus {
  version: number;
  total: number;
  online: number;
  offline: number;
  revoked: number;
}

export interface BrainPairingCode {
  brainId: string;
  code: string;
  expiresInSec: number;
}

/** The Brain serves its HTTP admin plane on the same port as its WebSocket
 * endpoint, so a wss://brain URL implies https://admin on that host:port. */
export function adminBaseFromBrainUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const m = /^(wss|ws):\/\/([^/]+)(\/|$)/.exec(url.trim());
  if (!m) return null;
  const scheme = m[1] === 'wss' ? 'https' : 'http';
  return `${scheme}://${m[2]}`;
}

async function fetchUrl<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      `Could not reach ${url} (${reason}). Check that it is running and reachable from this browser.`,
      0,
    );
  }

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
      : `${httpStatusLabel(response.status)} while contacting ${url}.`;
    throw new ApiError(message, response.status, data?.code);
  }
  if (!bodyIsJson && text.trim().length > 0) {
    throw new ApiError('The server returned an unexpected (non-JSON) response. It may not be the expected service.', response.status, 'INVALID_RESPONSE');
  }
  if (!bodyIsJson && text.trim().length === 0) {
    throw new ApiError('The server returned an empty response.', response.status, 'EMPTY_RESPONSE');
  }
  return data as T;
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

/** Call the Brain's OWN loopback/allowlisted admin HTTP plane (pairing
 * code generation, device registry, revocation). The Brain's origin
 * policy decides whether this browser may — remote Brains require the
 * operator to allow the origin; same-machine/desktop Brains are allowed
 * by default. The Body API never proxies these (Bodies are not
 * privileged over other Bodies). */
/** Convert an admin base URL (http/https) to its WebSocket URL for the
 * registry realtime channel (the Brain serves both on the same port). */
export function registryWsUrl(base: string): string {
  const trimmed = trimBase(base);
  return `${trimmed.replace(/^http/, 'ws')}/ws/admin`;
}

export const brainAdmin = {
  startPairing: (base: string) =>
    fetchUrl<BrainPairingCode>(`${trimBase(base)}/pairing/start`, { method: 'POST', body: '{}' }),

  /** Authoritative registry snapshot (with the monotonic version). */
  listDevices: (base: string) =>
    fetchUrl<BrainRegistrySnapshot>(`${trimBase(base)}/devices`),

  /** Single Body details (selected-Body panel). */
  getDevice: (base: string, bodyId: string) =>
    fetchUrl<{ version: number; body: BrainDevice }>(`${trimBase(base)}/devices/${encodeURIComponent(bodyId)}`),

  /** Lightweight registry status summary. */
  registryStatus: (base: string) =>
    fetchUrl<BrainRegistryStatus>(`${trimBase(base)}/registry/status`),

  revokeDevice: (base: string, bodyId: string) =>
    fetchUrl<{ success: boolean; bodyId: string }>(`${trimBase(base)}/devices/${encodeURIComponent(bodyId)}/revoke`, { method: 'POST', body: '{}' }),
};

function trimBase(base: string): string {
  return base.trim().replace(/\/+$/, '');
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

  // Performance metrics
  metrics: (n?: number) =>
    fetchAPI<MetricsResponse>(`/metrics?n=${n ?? 50}`),

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

  // Distributed Brain (external mode)
  getBrainStatus: () => fetchAPI<BrainStatusResponse>('/brain/status'),

  connectBrain: (url?: string, code?: string) =>
    fetchAPI<{ success: boolean }>('/brain/connect', {
      method: 'POST',
      body: JSON.stringify({ url: url?.trim() || undefined, code: code?.trim() || undefined }),
    }),

  disconnectBrain: () =>
    fetchAPI<{ success: boolean }>('/brain/disconnect', { method: 'POST', body: '{}' }),

  reconnectBrain: () =>
    fetchAPI<{ success: boolean }>('/brain/reconnect', { method: 'POST', body: '{}' }),

  unpairBrain: () =>
    fetchAPI<{ success: boolean }>('/brain/unpair', { method: 'POST', body: '{}' }),
};
