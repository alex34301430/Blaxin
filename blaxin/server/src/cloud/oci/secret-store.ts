// BLAXIN OCI secret store
// =============================================================
// Encrypted-at-rest storage for OCI API credentials. Uses the same
// AES-256 envelope as the LLM credential store but a dedicated file and
// a dedicated namespace so OCI keys can be removed independently.
//
// Rules enforced here:
//   - the private key is written 0600, encrypted, never in plaintext
//   - nothing in this file ever appears in logs or REST responses
//   - removal is real: the file entry is deleted, not flagged
// =============================================================

import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { hostname, userInfo } from 'os';
import { dataPath } from '../../utils/paths.js';
import { OciCredentials } from './signer.js';

const OCI_FILE = dataPath('.blaxin-oci-credentials');
const ENCRYPTION_KEY_ENV = 'BLAXIN_SECRET';

function getEncryptionKey(): Buffer {
  const envKey = process.env[ENCRYPTION_KEY_ENV];
  if (envKey && envKey.length >= 64) {
    return Buffer.from(envKey, 'hex');
  }
  const machineId = `${hostname()}-${userInfo().username}-blaxin-oci-credential-key`;
  return scryptSync(machineId, 'blaxin-oci-v1-salt', 32);
}

function encrypt(text: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText: string): string {
  const key = getEncryptionKey();
  const [ivHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

interface StoredOci {
  /** One JSON blob per field, all encrypted. */
  tenancy?: string;
  user?: string;
  fingerprint?: string;
  privateKey?: string;
  region?: string;
  tenancyName?: string;
}

function readStore(): StoredOci {
  try {
    if (!existsSync(OCI_FILE)) return {};
    return JSON.parse(readFileSync(OCI_FILE, 'utf-8')) as StoredOci;
  } catch {
    return {};
  }
}

function writeStore(store: StoredOci): void {
  writeFileSync(OCI_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function saveOciCredentials(cred: OciCredentials): void {
  writeStore({
    tenancy: encrypt(cred.tenancy),
    user: encrypt(cred.user),
    fingerprint: encrypt(cred.fingerprint),
    privateKey: encrypt(cred.privateKey),
    region: encrypt(cred.region),
    ...(cred.tenancyName ? { tenancyName: encrypt(cred.tenancyName) } : {}),
  });
}

export function loadOciCredentials(): OciCredentials | null {
  const store = readStore();
  if (!store.tenancy || !store.user || !store.fingerprint || !store.privateKey || !store.region) {
    return null;
  }
  try {
    return {
      tenancy: decrypt(store.tenancy),
      user: decrypt(store.user),
      fingerprint: decrypt(store.fingerprint),
      privateKey: decrypt(store.privateKey),
      region: decrypt(store.region),
      ...(store.tenancyName ? { tenancyName: decrypt(store.tenancyName) } : {}),
    };
  } catch {
    return null;
  }
}

/** True when any OCI credential material exists on disk. */
export function hasOciCredentials(): boolean {
  const s = readStore();
  return Boolean(s.tenancy || s.user || s.fingerprint || s.privateKey || s.region);
}

/** Remove every OCI credential (user-initiated). The file is deleted. */
export function clearOciCredentials(): void {
  try { rmSync(OCI_FILE, { force: true }); } catch { /* already gone */ }
}

/** Masked summary safe to show in the UI / REST (no secret material). */
export function ociCredentialSummary(): { configured: boolean; region: string | null; tenancyMasked: string | null } {
  const cred = loadOciCredentials();
  if (!cred) return { configured: false, region: null, tenancyMasked: null };
  return {
    configured: true,
    region: cred.region,
    tenancyMasked: cred.tenancy.length > 18 ? `${cred.tenancy.slice(0, 14)}…${cred.tenancy.slice(-4)}` : '••••',
  };
}
