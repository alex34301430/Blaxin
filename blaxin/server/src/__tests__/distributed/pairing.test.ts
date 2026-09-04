import { describe, it, expect } from 'vitest';
import {
  PairingManager, normalizePairingCode, formatPairingCode,
  PAIRING_DEFAULT_TTL_MS,
} from '../../distributed/pairing.js';

describe('pairing codes', () => {
  it('generates well-formed, distinct codes', () => {
    const p = new PairingManager();
    const a = p.generate();
    const b = p.generate();
    expect(a.formatted).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(a.code).not.toBe(b.code);
    // Generation invalidates the previous code (single active code).
    expect(p.current()?.formatted).toBe(b.formatted);
  });

  it('accepts a valid code once, and only once', () => {
    const p = new PairingManager();
    const { code, formatted } = p.generate();
    expect(p.tryConsume(code)).toEqual({ ok: true });
    // Reuse after successful consumption is refused.
    expect(p.tryConsume(code).ok).toBe(false);
    expect(p.tryConsume(formatted).ok).toBe(false);
  });

  it('accepts friendly input (lowercase, dashes, spaces) and rejects wrong codes', () => {
    const p = new PairingManager();
    const { code } = p.generate();
    expect(normalizePairingCode(`  ${code.toLowerCase()} `)).toBe(code);
    expect(normalizePairingCode(formatPairingCode(code))).toBe(code);
    const wrong = p.tryConsume('ZZZZ-ZZZZ');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe('INVALID');
  });

  it('expires after the TTL (fake clock)', () => {
    let now = 1_000_000;
    const p = new PairingManager({ now: () => now });
    const { code } = p.generate();
    now += PAIRING_DEFAULT_TTL_MS - 1;
    expect(p.tryConsume(code).ok).toBe(true); // still valid just before expiry
  });

  it('rejects an expired code (fake clock)', () => {
    let now = 1_000_000;
    const p = new PairingManager({ now: () => now });
    const { code } = p.generate();
    now += PAIRING_DEFAULT_TTL_MS + 1;
    const verdict = p.tryConsume(code);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('EXPIRED');
  });

  it('rate-limits wrong-code attempts and invalidates the code', () => {
    const p = new PairingManager({ maxAttempts: 3 });
    p.generate();
    // All maxAttempts wrong guesses are reported INVALID and count up.
    for (let i = 0; i < 3; i++) {
      const v = p.tryConsume('WRONG-WRONG');
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe('INVALID');
    }
    // The code is now rate-limited: even the real code is refused.
    const real = (p as unknown as { session: { code: string } | null }).session?.code as string;
    const after = p.tryConsume(real);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe('RATE_LIMITED');
    expect(p.current()).toBeNull(); // no longer pairable with this code
  });

  it('reports NO_CODE when no code is active and invalidate() clears it', () => {
    const p = new PairingManager();
    expect(p.tryConsume('ABCD-EFGH').ok).toBe(false);
    p.generate();
    p.invalidate();
    expect(p.isPairingActive()).toBe(false);
    expect(p.current()).toBeNull();
  });
});
