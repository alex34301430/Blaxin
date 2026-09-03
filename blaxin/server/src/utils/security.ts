// BLAXIN connection security
// =============================================================
// The backend is a local control plane for an autonomous agent: it can
// run shells, drive the desktop, and reach the filesystem. Malicious
// web pages must not be able to drive it from a browser.
//
// Browsers do not enforce same-origin policy on WebSocket upgrades, so
// we validate the Origin header on every connection. HTTP endpoints are
// protected by a matching CORS allowlist (browsers will not send
// state-changing cross-origin requests without a passing preflight).
//
// Allowed by default:
//   - non-browser clients (curl, the Node server itself): no Origin
//   - the packaged desktop app: tauri://localhost, http(s)://tauri.localhost
//   - local development & local nginx: http(s)://localhost:* ,
//     http(s)://127.0.0.1:* , http://[::1]:*
//
// Remote web deployments (nginx/docker behind a public domain) set
// BLAXIN_ALLOWED_ORIGINS to their public origin(s), e.g.
// "https://blaxin.example.com". For a fully open deployment you may set
// BLAXIN_ALLOWED_ORIGINS=* (documented; not recommended for shared hosts).
// =============================================================

export function normalizeOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  const trimmed = origin.trim();
  if (!trimmed || trimmed === 'null') return null;
  return trimmed.replace(/\/+$/, '');
}

function isLocalhostHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isTauriHost(hostname: string): boolean {
  return hostname === 'tauri.localhost' || hostname === 'tauri';
}

export function isOriginAllowed(origin: string | undefined, extraAllowed: string[] = []): boolean {
  const normalized = normalizeOrigin(origin);
  if (normalized === null) return true; // non-browser clients

  if (extraAllowed.includes('*')) return true;

  if (extraAllowed.some((entry) => {
    if (entry === normalized) return true;
    // Support simple wildcards on the host, e.g. https://*.example.com
    if (entry.includes('*')) {
      const escaped = entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`).test(normalized);
    }
    return false;
  })) {
    return true;
  }

  try {
    const url = new URL(normalized);
    // The Tauri custom protocol origin is tauri://localhost (host is
    // literally "localhost") while the http variant uses tauri.localhost.
    if (url.protocol === 'tauri:') {
      return isLocalhostHost(url.hostname) || isTauriHost(url.hostname);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return isLocalhostHost(url.hostname) || isTauriHost(url.hostname);
  } catch {
    // Origin-like strings that cannot be parsed are rejected.
    return false;
  }
}

/**
 * Decision function for the state-changing request guard.
 *
 * GET/HEAD/OPTIONS are read-only or preflight and are always allowed.
 * For state-changing methods (POST/PUT/DELETE):
 *   - A request WITHOUT an Origin header is a non-browser client (curl,
 *     local scripts, the Node server itself) and is allowed. Browsers
 *     always attach an Origin header to non-GET requests, so a malicious
 *     web page can never reach this branch.
 *   - A request WITH an Origin must match the allowlist (localhost
 *     origins, the Tauri desktop origin, or BLAXIN_ALLOWED_ORIGINS).
 */
export function isStateChangingRequestAllowed(
  method: string,
  origin: string | undefined,
  extraAllowed: string[] = [],
): boolean {
  const m = (method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  return isOriginAllowed(origin, extraAllowed);
}

/** Additional origins from BLAXIN_ALLOWED_ORIGINS (comma separated). */
export function getAllowedOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.BLAXIN_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Build an express-cors-friendly origin validator. */
export function corsOriginValidator(extraAllowed: string[] = []) {
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (isOriginAllowed(origin, extraAllowed)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  };
}
