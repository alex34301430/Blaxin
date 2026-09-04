// BLAXIN persistent device identity
// =============================================================
// Every Brain (BLX-BRAIN-XXXX) and every Body (BLX-BODY-XXXX) carries
// a persistent Ed25519 keypair. The private key NEVER leaves the
// device: it is stored mode-0600 in the local data dir and is never
// logged, never sent over the wire, never included in telemetry.
// Peers authenticate by signing fresh challenges with this key.
//
// Device ids are derived from the public key (sha256 → uppercase hex,
// formatted BLX-<ROLE>-XXXX), so a device cannot claim an id it does
// not own the key for.
// =============================================================

import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync,
  sign, verify, randomBytes,
} from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import {
  BODY_ID_PREFIX, BRAIN_ID_PREFIX, DeviceId, DeviceIdentityRecord,
  DeviceRole, DEVICE_ROLE_BODY, DEVICE_ROLE_BRAIN,
} from './types.js';

/** Derive the short device id from a base64 Ed25519 public key. */
export function deriveDeviceId(role: DeviceRole, publicKeyB64: string): DeviceId {
  const digest = createHash('sha256').update(publicKeyB64).digest('hex').toUpperCase();
  const prefix = role === DEVICE_ROLE_BRAIN ? BRAIN_ID_PREFIX : BODY_ID_PREFIX;
  return `${prefix}${digest.slice(0, 4)}`;
}

/** Generate a brand-new keypair (used when no persisted identity exists). */
export function generateKeypair(): { publicKey: string; secretKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    secretKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/** Recover the public key from a persisted PKCS8 private key (DER). */
export function publicKeyFromSecret(secretKeyB64: string): string {
  const key = createPrivateKey({
    key: Buffer.from(secretKeyB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
}

/** Sign a UTF-8 message with this device's Ed25519 key. */
export function signData(secretKeyB64: string, data: string): string {
  const key = createPrivateKey({
    key: Buffer.from(secretKeyB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return sign(null, Buffer.from(data, 'utf8'), key).toString('base64');
}

/** Verify an Ed25519 signature over `data` against a peer public key. */
export function verifySignature(publicKeyB64: string, data: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(data, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export function randomChallenge(): string {
  return randomBytes(32).toString('hex');
}

export interface DeviceIdentity {
  role: DeviceRole;
  id: DeviceId;
  name: string;
  publicKey: string;
  readonly secretKey: string;
}

export interface IdentityStoreOptions {
  /** Absolute path of the identity JSON file. */
  filePath: string;
  role: DeviceRole;
  name: string;
  now?: () => number;
}

/**
 * Load (or create on first run) a device identity persisted at filePath.
 * The file is written mode 0600 and contains the private key — it must
 * live in the local data dir and never enter version control.
 */
export function loadOrCreateIdentity(options: IdentityStoreOptions): DeviceIdentity {
  const { filePath, role, name } = options;
  const now = options.now ?? Date.now;
  let record: DeviceIdentityRecord | null = null;

  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as DeviceIdentityRecord;
      if (
        parsed && parsed.role === role && typeof parsed.publicKey === 'string' &&
        typeof parsed.secretKey === 'string' && typeof parsed.id === 'string' &&
        parsed.publicKey.length > 0 && parsed.secretKey.length > 0
      ) {
        // Re-derive and sanity-check the id so a tampered file is ignored.
        const derived = deriveDeviceId(role, parsed.publicKey);
        if (derived === parsed.id && publicKeyFromSecret(parsed.secretKey) === parsed.publicKey) {
          record = parsed;
        }
      }
    }
  } catch {
    record = null;
  }

  if (!record) {
    const kp = generateKeypair();
    record = {
      role,
      id: deriveDeviceId(role, kp.publicKey),
      publicKey: kp.publicKey,
      secretKey: kp.secretKey,
      name,
      createdAt: now(),
    };
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      writeFileSync(filePath, JSON.stringify(record, null, 2), { mode: 0o600 });
    } catch {
      // Identity stays in memory; persistence failure is logged upstream.
    }
  }

  return {
    role: record.role,
    id: record.id,
    name: record.name || name,
    publicKey: record.publicKey,
    secretKey: record.secretKey,
  };
}

/** Canonical id format guard used by the protocol layer. */
export function isValidDeviceId(id: string): boolean {
  return /^BLX-(BODY|BRAIN)-[A-Z0-9]{4,12}$/.test(id);
}
