// BLAXIN pairing codes
// =============================================================
// A pairing code is the ONE-TIME bootstrap credential a Body presents
// to a Brain to establish the initial trusted relationship. It is:
//   - cryptographically random (8 chars from a 36-char alphabet ≈ 41 bits)
//   - short-lived (default 5 minutes)
//   - single-use (consumed on first successful use)
//   - rate limited (bounded attempts per code / per remote address)
//   - held in memory only — never persisted, never logged
//
// After a successful pair the relationship is bound to the exchanged
// Ed25519 public keys; the code itself is invalidated and can never be
// used again. It is NOT the permanent credential.
// =============================================================

import { randomBytes } from 'crypto';

export interface PairingSession {
  code: string;
  expiresAt: number;
  /** Consumed by a successful pair (or cancelled by a new code). */
  consumed: boolean;
  attempts: number;
  maxAttempts: number;
}

export interface PairingOptions {
  /** Lifetime of a generated code (ms). */
  ttlMs?: number;
  /** Max wrong-code attempts before the code is invalidated. */
  maxAttempts?: number;
  now?: () => number;
}

export const PAIRING_DEFAULT_TTL_MS = 5 * 60 * 1000;
export const PAIRING_DEFAULT_MAX_ATTEMPTS = 5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 confusion

export function formatPairingCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function randomPairingCode(): string {
  // 8 chars over a 36-char alphabet (bijective rejection-free sampling
  // is unnecessary here: 256 bits of input → 8 chars is a massive excess).
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/** Strip the dash from a formatted code, uppercased (user-friendly input). */
export function normalizePairingCode(input: string): string {
  return (input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/**
 * Manages the single active pairing code on a Brain. Generating a new
 * code invalidates the previous one (a code can never be reused).
 */
export class PairingManager {
  private session: PairingSession | null = null;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(options: PairingOptions = {}) {
    this.ttlMs = options.ttlMs ?? PAIRING_DEFAULT_TTL_MS;
    this.maxAttempts = options.maxAttempts ?? PAIRING_DEFAULT_MAX_ATTEMPTS;
    this.now = options.now ?? Date.now;
  }

  /** Generate a fresh code (invalidating any previous one). */
  generate(): { code: string; formatted: string; expiresInMs: number } {
    const code = randomPairingCode();
    this.session = {
      code,
      expiresAt: this.now() + this.ttlMs,
      consumed: false,
      attempts: 0,
      maxAttempts: this.maxAttempts,
    };
    return { code, formatted: formatPairingCode(code), expiresInMs: this.ttlMs };
  }

  /** The current active code with its remaining lifetime (display only). */
  current(): { formatted: string; expiresInSec: number; remainingAttempts: number } | null {
    const s = this.activeSession();
    if (!s) return null;
    return {
      formatted: formatPairingCode(s.code),
      expiresInSec: Math.max(0, Math.ceil((s.expiresAt - this.now()) / 1000)),
      remainingAttempts: Math.max(0, s.maxAttempts - s.attempts),
    };
  }

  /**
   * Validate and (on success) consume the presented code.
   * Returns a machine code on failure so callers can distinguish
   * EXPIRED / INVALID / RATE_LIMITED / ALREADY_USED.
   */
  tryConsume(input: string): { ok: true } | { ok: false; code: 'EXPIRED' | 'INVALID' | 'RATE_LIMITED' | 'NO_CODE' } {
    // Expiry is checked explicitly here (an expired code must be reported
    // as EXPIRED rather than silently treated as "no code").
    if (!this.session) return { ok: false, code: 'NO_CODE' };
    const s = this.session;
    if (s.consumed) return { ok: false, code: 'NO_CODE' };
    if (this.now() >= s.expiresAt) {
      this.session = null;
      return { ok: false, code: 'EXPIRED' };
    }
    if (s.attempts >= s.maxAttempts) {
      // The code is burned by the rate limit: it can never be used.
      this.session = null;
      return { ok: false, code: 'RATE_LIMITED' };
    }
    const presented = normalizePairingCode(input);
    if (presented !== s.code) {
      s.attempts++;
      return { ok: false, code: 'INVALID' };
    }
    // Correct code: consume it immediately (single use).
    s.consumed = true;
    return { ok: true };
  }

  /** Invalidate any active code (revoke pairing mode). */
  invalidate(): void {
    this.session = null;
  }

  isPairingActive(): boolean {
    return this.activeSession() !== null;
  }

  /** Number of failed attempts so far on the active code (tests/UI). */
  failedAttempts(): number {
    return this.activeSession()?.attempts ?? 0;
  }

  private activeSession(): PairingSession | null {
    if (!this.session || this.session.consumed) return null;
    if (this.now() >= this.session.expiresAt) {
      this.session = null;
      return null;
    }
    return this.session;
  }
}
