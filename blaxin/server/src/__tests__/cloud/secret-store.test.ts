import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'blaxin-oci-secrets-'));
process.env.BLAXIN_DATA_DIR = TEST_DIR;

// Import AFTER the env is set so the module-level secrets file path
// resolves inside the temp dir.
const store = await import('../../../src/cloud/oci/secret-store.js');

const PRIVATE_KEY_PEM = '-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEAtestonly\n-----END PRIVATE KEY-----';

const creds = {
  tenancy: 'ocid1.tenancy.oc1..aaaaaaaaexample',
  user: 'ocid1.user.oc1..aaaaaaaaexample',
  fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
  privateKey: PRIVATE_KEY_PEM,
  region: 'us-ashburn-1',
  tenancyName: 'secret-test-tenancy',
};

describe('OCI credential secret store (encrypted at rest)', () => {
  const file = join(TEST_DIR, '.blaxin-oci-credentials');

  beforeAll(() => store.clearOciCredentials());
  afterAll(() => store.clearOciCredentials());

  it('persists credentials encrypted — the key never appears in plaintext', () => {
    store.saveOciCredentials(creds);
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf-8');
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain('MIIBVAIBADANB');
    expect(raw).not.toContain('ocid1.tenancy');
    expect(raw).not.toContain('secret-test-tenancy');
    // every stored field is an iv:encrypted pair
    for (const value of Object.values(JSON.parse(raw))) {
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^[0-9a-f]{32}:[0-9a-f]+$/);
    }
  });

  it('writes the file with owner-only permissions', () => {
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('round-trips exactly (decrypt === what was saved)', () => {
    const loaded = store.loadOciCredentials();
    expect(loaded).not.toBeNull();
    expect(loaded!.tenancy).toBe(creds.tenancy);
    expect(loaded!.user).toBe(creds.user);
    expect(loaded!.fingerprint).toBe(creds.fingerprint);
    expect(loaded!.privateKey).toBe(PRIVATE_KEY_PEM);
    expect(loaded!.region).toBe(creds.region);
    expect(loaded!.tenancyName).toBe('secret-test-tenancy');
  });

  it('reports mounted/absent state without leaking the full value', () => {
    expect(store.hasOciCredentials()).toBe(true);
    const summary = store.ociCredentialSummary();
    expect(summary.configured).toBe(true);
    expect(summary.region).toBe('us-ashburn-1');
    // the full OCID never appears — only a structural prefix + tail
    expect(summary.tenancyMasked).not.toContain('ocid1.tenancy.oc1..aaaaaaaaexample');
    expect(summary.tenancyMasked!.endsWith('mple')).toBe(true);
    expect(summary.tenancyMasked!.length).toBeLessThan(creds.tenancy.length);
  });

  it('removal is real (file deleted, not flagged)', () => {
    store.clearOciCredentials();
    expect(existsSync(file)).toBe(false);
    expect(store.loadOciCredentials()).toBeNull();
    expect(store.hasOciCredentials()).toBe(false);
    expect(store.ociCredentialSummary().configured).toBe(false);
  });

  it('clearing twice is safe (idempotent)', () => {
    expect(() => store.clearOciCredentials()).not.toThrow();
  });
});