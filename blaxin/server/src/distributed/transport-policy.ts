// BLAXIN Brain transport policy (Body side)
// =============================================================
// Decides whether a Brain URL may be dialed and how. This closes the
// documented plaintext-MITM gap:
//
//   - wss:// is REQUIRED for any non-loopback Brain address (remote
//     machines, LAN, VPS, …). TLS certificates are always validated
//     against the system roots or an explicitly configured CA file
//     (BLAXIN_BRAIN_CA_FILE) — never silently skipped.
//   - ws:// remains allowed for loopback (localhost / 127.x / ::1),
//     which is the local-development topology.
//   - An EXPLICIT operator override (BLAXIN_BRAIN_ALLOW_INSECURE=1)
//     re-enables plaintext to non-loopback addresses and disables cert
//     verification for development only; every use is surfaced in state
//     and logs so it can never happen by accident.
// =============================================================

export type BrainUrlScheme = 'ws' | 'wss';

export interface BrainUrlInfo {
  scheme: BrainUrlScheme;
  /** hostname without brackets/port, lowercase. */
  hostname: string;
  /** host:port as written (no default port added). */
  host: string;
  loopback: boolean;
}

export type BrainUrlVerdict =
  | { ok: true; info: BrainUrlInfo }
  | { ok: false; code: 'BAD_URL' | 'CREDENTIALS_IN_URL' | 'PLAINTEXT_REMOTE'; error: string };

/** True for loopback hostnames (localhost, 127.x, ::1). IPv4-mapped
 * loopback (::ffff:127.0.0.1) counts as loopback too. */
export function isLoopbackHost(hostname: string): boolean {
  // Node keeps the brackets on IPv6 hostnames (e.g. "[::1]"); normalize.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1') return true;
  if (h === '::ffff:127.0.0.1') return true;
  if (/^127\./.test(h)) return true;
  return false;
}

export const PLAINTEXT_REMOTE_ERROR =
  'Refusing a plaintext ws:// connection to a non-local Brain address — an ' +
  'attacker on the network could impersonate the Brain (MITM). Use wss:// ' +
  '(a TLS certificate for the Brain, and BLAXIN_BRAIN_CA_FILE on the Body when ' +
  'the certificate is from a private CA). For local development only you may ' +
  'set BLAXIN_BRAIN_ALLOW_INSECURE=1 to allow plaintext explicitly.';

/** Parse + classify a Brain URL without any policy (scheme + loopback). */
export function classifyBrainUrl(raw: string): BrainUrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'BAD_URL', error: 'Invalid Brain URL — expected ws:// or wss://host:port/ws/brain' };
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { ok: false, code: 'BAD_URL', error: 'Brain URL must start with ws:// or wss://' };
  }
  if (url.username || url.password) {
    return { ok: false, code: 'CREDENTIALS_IN_URL', error: 'Brain URL must not contain embedded credentials' };
  }
  const scheme: BrainUrlScheme = url.protocol === 'wss:' ? 'wss' : 'ws';
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const host = url.host.toLowerCase();
  return {
    ok: true,
    info: {
      scheme,
      hostname,
      host,
      loopback: isLoopbackHost(hostname),
    },
  };
}

/** Policy gate: may this Body dial this Brain URL? */
export function validateBrainUrl(
  raw: string,
  options: { allowInsecure?: boolean } = {},
): BrainUrlVerdict {
  const verdict = classifyBrainUrl(raw);
  if (!verdict.ok) return verdict;
  const { info } = verdict;
  // Plaintext is only acceptable on the loopback device, or when the
  // operator explicitly opted into insecure development mode.
  if (info.scheme === 'ws' && !info.loopback && !options.allowInsecure) {
    return { ok: false, code: 'PLAINTEXT_REMOTE', error: PLAINTEXT_REMOTE_ERROR };
  }
  return verdict;
}
