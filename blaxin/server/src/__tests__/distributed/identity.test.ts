import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  deriveDeviceId, generateKeypair, loadOrCreateIdentity, publicKeyFromSecret,
  signData, verifySignature, randomChallenge,
} from '../../distributed/identity.js';

describe('device identity', () => {
  it('derives stable BLX-ROLE-XXXX ids from a public key', () => {
    const kp = generateKeypair();
    const id = deriveDeviceId('brain', kp.publicKey);
    expect(id).toMatch(/^BLX-BRAIN-[A-Z0-9]{4}$/);
    expect(deriveDeviceId('brain', kp.publicKey)).toBe(id); // deterministic
    expect(deriveDeviceId('body', kp.publicKey)).toMatch(/^BLX-BODY-[A-Z0-9]{4}$/);
  });

  it('signs and verifies data (and rejects wrong keys / tampered data)', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const sig = signData(a.secretKey, 'hello brain');
    expect(verifySignature(a.publicKey, 'hello brain', sig)).toBe(true);
    expect(verifySignature(b.publicKey, 'hello brain', sig)).toBe(false); // wrong key
    expect(verifySignature(a.publicKey, 'hello braid', sig)).toBe(false); // tampered
    expect(verifySignature(a.publicKey, 'hello brain', '!!!not-base64!!!')).toBe(false);
  });

  it('derives the public key from a secret key', () => {
    const kp = generateKeypair();
    expect(publicKeyFromSecret(kp.secretKey)).toBe(kp.publicKey);
  });

  it('persists an identity mode-0600 and reloads it unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blaxin-id-'));
    const file = join(dir, 'identity.json');
    try {
      const created = loadOrCreateIdentity({ filePath: file, role: 'brain', name: 'Test Brain' });
      expect(created.id).toMatch(/^BLX-BRAIN-/);

      // Reload: identical identity, no regeneration.
      const reloaded = loadOrCreateIdentity({ filePath: file, role: 'brain', name: 'Test Brain' });
      expect(reloaded.id).toBe(created.id);
      expect(reloaded.publicKey).toBe(created.publicKey);
      expect(reloaded.secretKey).toBe(created.secretKey);

      const mode = statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);

      const raw = JSON.parse(readFileSync(file, 'utf-8'));
      expect(raw.role).toBe('brain');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotates to a fresh identity when the file was tampered with', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blaxin-id-'));
    const file = join(dir, 'identity.json');
    try {
      const created = loadOrCreateIdentity({ filePath: file, role: 'body', name: 'Body' });
      // Corrupt: swap the stored id for one that does not match the key.
      const raw = JSON.parse(readFileSync(file, 'utf-8'));
      raw.id = 'BLX-BODY-AAAA';
      writeFileSync(file, JSON.stringify(raw));
      // A tampered identity is NEVER trusted: a fresh keypair is created
      // (rotation) instead of accepting the lying record.
      const reloaded = loadOrCreateIdentity({ filePath: file, role: 'body', name: 'Body' });
      expect(reloaded.id).not.toBe('BLX-BODY-AAAA');
      expect(reloaded.id).toMatch(/^BLX-BODY-[A-Z0-9]{4}$/);
      // The new identity is itself persisted (round-trips on next load).
      const third = loadOrCreateIdentity({ filePath: file, role: 'body', name: 'Body' });
      expect(third.id).toBe(reloaded.id);
      expect(third.secretKey).toBe(reloaded.secretKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates unique challenges', () => {
    expect(randomChallenge()).not.toBe(randomChallenge());
    expect(randomChallenge()).toHaveLength(64);
  });
});
