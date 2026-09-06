import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createHash, createVerify } from 'crypto';
import { signRequest, credentialsWellFormed, OciCredentials } from '../../../src/cloud/oci/signer.js';

function makeCreds(): { cred: OciCredentials; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    cred: {
      tenancy: 'ocid1.tenancy.oc1..aaaaaaaaexample',
      user: 'ocid1.user.oc1..aaaaaaaaexample',
      fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      region: 'us-ashburn-1',
      tenancyName: 'example-tenancy',
    },
  };
}

/** Extract the base64 signature from the Authorization header and verify
 * it against the canonical signing string reconstructed from the headers. */
function verifySignature(publicKey: string, headers: Record<string, string>, requestTarget: string): boolean {
  const auth = headers.authorization;
  const sig = auth?.match(/signature="([^"]+)"/)?.[1];
  const headerList = auth?.match(/headers="([^"]+)"/)?.[1];
  expect(sig).toBeTruthy();
  expect(headerList).toBeTruthy();
  const signingString = headerList!.split(' ').map((h) => {
    if (h === '(request-target)') return `${h}: ${requestTarget}`;
    expect(headers[h]).toBeDefined();
    return `${h}: ${headers[h]}`;
  }).join('\n');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signingString, 'utf-8');
  return verifier.verify(publicKey, Buffer.from(sig!, 'base64'));
}

describe('OCI request signing (signature version 1)', () => {
  it('produces a signature that verifies against the public key (GET)', () => {
    const { cred, publicKey } = makeCreds();
    const { headers } = signRequest(cred, {
      method: 'GET',
      path: '/20160918/availabilityDomains',
      host: 'iaas.us-ashburn-1.oraclecloud.com',
    });
    expect(verifySignature(publicKey, headers, 'get /20160918/availabilityDomains')).toBe(true);
    // body-less requests omit content-length/x-content-sha256/content-type
    expect(Object.keys(headers)).not.toContain('content-length');
    expect(headers.authorization).toContain('keyId="ocid1.tenancy.oc1..aaaaaaaaexample/ocid1.user.oc1..aaaaaaaaexample/aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99"');
    expect(headers.authorization).toContain('algorithm="rsa-sha256"');
  });

  it('signs a POST body with the exact content hash and length', () => {
    const { cred, publicKey } = makeCreds();
    const body = JSON.stringify({ compartmentId: 'ocid1.compartment.oc1..x', displayName: 'BLAXIN test' });
    const { headers } = signRequest(cred, {
      method: 'POST',
      path: '/20160918/instances',
      host: 'iaas.us-ashburn-1.oraclecloud.com',
      body,
    });
    expect(headers['x-content-sha256']).toBe(createHash('sha256').update(body).digest('base64'));
    expect(headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(headers['content-type']).toBe('application/json');
    expect(verifySignature(publicKey, headers, 'post /20160918/instances')).toBe(true);
  });

  it('accepts base64-DER keys the way ~/.oci/config stores them', () => {
    const { cred } = makeCreds();
    const credDer: OciCredentials = { ...cred, privateKey: privateKeyPg() };
    expect(() => signRequest(credDer, { method: 'GET', path: '/x', host: 'h' })).not.toThrow();
  });

  it('fails loudly on a corrupt key', () => {
    const { cred } = makeCreds();
    expect(() => signRequest({ ...cred, privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }, { method: 'GET', path: '/x', host: 'h' })).toThrow();
  });

  it('validates credential structure without network access', () => {
    const { cred } = makeCreds();
    expect(credentialsWellFormed(cred).ok).toBe(true);
    expect(credentialsWellFormed({ ...cred, tenancy: 'not-an-ocid' }).ok).toBe(false);
    expect(credentialsWellFormed({ ...cred, fingerprint: 'aa:bb' }).ok).toBe(false);
    expect(credentialsWellFormed({ ...cred, region: 'mars-1' }).ok).toBe(false);
    expect(credentialsWellFormed({ ...cred, privateKey: '' }).ok).toBe(false);
  });
});

function privateKeyPg(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return pem.replace(/-----[A-Z ]+-----/g, '').replace(/\n/g, '');
}