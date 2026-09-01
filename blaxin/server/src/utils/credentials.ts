import { ProviderId, ProviderCredentials } from '../types.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const CREDENTIALS_FILE = join(process.cwd(), '.blaxin-credentials');
const ENCRYPTION_KEY_ENV = 'BLAXIN_SECRET';

function getEncryptionKey(): Buffer {
  const envKey = process.env[ENCRYPTION_KEY_ENV];
  if (envKey) {
    return Buffer.from(envKey, 'hex');
  }
  // Derive from a default key - in production this should be set properly
  return scryptSync('blaxin-default-encryption-key', 'blaxin-salt-16bytes', 32);
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

interface StoredCredentials {
  [providerId: string]: string; // encrypted apiKey
}

export const credentialStore = {
  save(providerId: ProviderId, apiKey: string): void {
    let stored: StoredCredentials = {};
    try {
      if (existsSync(CREDENTIALS_FILE)) {
        const raw = readFileSync(CREDENTIALS_FILE, 'utf-8');
        stored = JSON.parse(raw);
      }
    } catch {}
    stored[providerId] = encrypt(apiKey);
    writeFileSync(CREDENTIALS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
  },

  get(providerId: ProviderId): string | null {
    try {
      if (!existsSync(CREDENTIALS_FILE)) return null;
      const raw = readFileSync(CREDENTIALS_FILE, 'utf-8');
      const stored: StoredCredentials = JSON.parse(raw);
      const encrypted = stored[providerId];
      if (!encrypted) return null;
      return decrypt(encrypted);
    } catch {
      return null;
    }
  },

  remove(providerId: ProviderId): void {
    try {
      if (!existsSync(CREDENTIALS_FILE)) return;
      const raw = readFileSync(CREDENTIALS_FILE, 'utf-8');
      const stored: StoredCredentials = JSON.parse(raw);
      delete stored[providerId];
      writeFileSync(CREDENTIALS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
    } catch {}
  },

  has(providerId: ProviderId): boolean {
    return this.get(providerId) !== null;
  },

  maskKey(apiKey: string): string {
    if (apiKey.length <= 8) return '••••••••';
    return apiKey.slice(0, 6) + '••••••••' + apiKey.slice(-4);
  },

  getAll(): Record<string, { hasKey: boolean; maskedKey?: string }> {
    try {
      if (!existsSync(CREDENTIALS_FILE)) return {};
      const raw = readFileSync(CREDENTIALS_FILE, 'utf-8');
      const stored: StoredCredentials = JSON.parse(raw);
      const result: Record<string, { hasKey: boolean; maskedKey?: string }> = {};
      for (const [providerId, encrypted] of Object.entries(stored)) {
        try {
          const key = decrypt(encrypted);
          result[providerId] = { hasKey: true, maskedKey: this.maskKey(key) };
        } catch {
          result[providerId] = { hasKey: false };
        }
      }
      return result;
    } catch {
      return {};
    }
  },
};
