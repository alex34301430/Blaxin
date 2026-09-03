// BLAXIN Endpoint Resolution
// =============================================================
// BLAXIN can run in three deployment modes, each reaching the
// backend differently:
//
//   1. Development (vite)      — /api and /ws are same-origin and
//                                proxied by the vite dev server.
//   2. Web (nginx / Docker)    — the client and API are served from
//                                the same origin behind the reverse
//                                proxy, so relative URLs work.
//   3. Packaged Tauri desktop  — the bundled Node server listens on
//                                127.0.0.1:3001 while the UI is served
//                                from the tauri://localhost asset
//                                protocol. Relative URLs would never
//                                reach the backend in this mode, so we
//                                must target 127.0.0.1 explicitly.
//
// Detecting the wrong mode produced the classic symptom of the
// desktop app reaching the Tauri asset server instead of the Node
// backend: the HTTP layer returned an empty/non-JSON body, and the
// WebKitGTK webview surfaced "The string did not match the expected
// pattern." when response.json() was called on it — reported by
// users as "my valid API key was rejected" during setup.
// =============================================================

export const API_PORT = Number(
  (import.meta.env && import.meta.env.VITE_BLAXIN_API_PORT) || 3001,
);

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;

  // Tauri v2 injects its global before the page scripts run.
  if ('__TAURI_INTERNALS__' in window) return true;
  if ('__TAURI__' in window) return true;

  // Tauri v2 uses a custom protocol (tauri:// or http(s)://tauri.localhost).
  const protocol = window.location.protocol;
  if (protocol === 'tauri:') return true;

  if (protocol === 'http:' || protocol === 'https:') {
    const host = window.location.hostname;
    if (host === 'tauri.localhost') return true;
    // Android/iOS style webviews or renamed local hosts
    if (host.endsWith('.localhost') && host !== 'localhost') return true;
  }

  return false;
}

/** Base path for REST calls. Always ends with "/api" (no trailing slash). */
export function getApiBase(): string {
  if (isTauriRuntime()) {
    return `http://127.0.0.1:${API_PORT}/api`;
  }
  return '/api';
}

/** WebSocket URL for a given server path (e.g. "/ws"). */
export function getWsUrl(path = '/ws'): string {
  if (isTauriRuntime()) {
    return `ws://127.0.0.1:${API_PORT}${path}`;
  }
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}${path}`;
}
