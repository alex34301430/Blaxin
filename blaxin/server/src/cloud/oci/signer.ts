// BLAXIN OCI request signing
// =============================================================
// Implements the official OCI REST API request signing ("signature
// version 1"): an RSA-SHA256 signature over the canonical request
// carried in the Authorization header.
//
//   authorization: Signature headers="(request-target) host date
//   x-content-sha256 content-type content-length" keyId=... algorithm=
//   rsa-sha256 signature=...
//
// Security rules:
//   - the private key never leaves this module except through sign()
//   - no credential value is ever logged or included in errors
//   - PEM is accepted raw or as a base64 DER blob (OCI config style)
// =============================================================

import { createSign, createHash, createPrivateKey, KeyObject } from 'crypto';

export interface OciCredentials {
  tenancy: string;   // ocid1.tenancy.oc1..
  user: string;      // ocid1.user.oc1..
  fingerprint: string; // xx:xx:… (SHA1 of the public key)
  /** PEM text or base64 DER of the private key. */
  privateKey: string;
  /** Region identifier, e.g. "us-ashburn-1". */
  region: string;
  /** Human tenancy name when known (from validation). */
  tenancyName?: string;
}

const SIGN_HEADERS = ['(request-target)', 'host', 'date', 'x-content-sha256', 'content-type', 'content-length'];

/** Accept both PEM and the base64 DER form used in ~/.oci/config. */
function loadPrivateKey(pemOrDer: string): KeyObject {
  if (pemOrDer.includes('-----BEGIN')) {
    return createPrivateKey(pemOrDer);
  }
  const der = Buffer.from(pemOrDer, 'base64');
  const pem = [
    '-----BEGIN PRIVATE KEY-----',
    ...der.toString('base64').match(/.{1,64}/g) || [],
    '-----END PRIVATE KEY-----',
  ].join('\n');
  return createPrivateKey(pem);
}

/** Validate the shape of a keyId ("tenancy/user/fingerprint"). */
function keyId(cred: OciCredentials): string {
  return `${cred.tenancy}/${cred.user}/${cred.fingerprint}`;
}

export interface SignRequestInput {
  method: string;
  /** Path with query, e.g. /20160918/instances?compartmentId=… */
  path: string;
  host: string;
  body?: string | null;
  contentType?: string;
}

export interface SignedRequest {
  headers: Record<string, string>;
}

/** Produce the signed headers for one API call. */
export function signRequest(cred: OciCredentials, input: SignRequestInput): SignedRequest {
  const method = input.method.toUpperCase();
  const date = new Date().toUTCString();
  const body = input.body ?? '';
  const contentType = input.contentType ?? (body ? 'application/json' : '');
  const contentLength = String(Buffer.byteLength(body, 'utf-8'));

  const headers: Record<string, string> = { date, host: input.host };
  const hasBody = body.length > 0;
  if (hasBody) {
    headers['x-content-sha256'] = createHash('sha256').update(body, 'utf-8').digest('base64');
    headers['content-type'] = contentType;
    headers['content-length'] = contentLength;
  }

  // Canonical request-target: lowercase method + path(+query).
  const requestTarget = `${method.toLowerCase()} ${input.path}`;

  // Header list in the exact order OCI requires; only include the body
  // headers when a body exists.
  const headerNames = (hasBody ? SIGN_HEADERS : SIGN_HEADERS.filter((h) => !h.startsWith('x-content') && h !== 'content-length' && h !== 'content-type'));

  const signingString = headerNames
    .map((h) => {
      if (h === '(request-target)') return `${h}: ${requestTarget}`;
      const value = (headers as Record<string, string>)[h];
      if (value === undefined) throw new Error(`Missing header for signature: ${h}`);
      return `${h}: ${value}`;
    })
    .join('\n');

  const signer = createSign('RSA-SHA256');
  signer.update(signingString, 'utf-8');
  const signature = signer.sign(loadPrivateKey(cred.privateKey)).toString('base64');

  headers.authorization = [
    `Signature version="1"`,
    `keyId="${keyId(cred)}"`,
    `algorithm="rsa-sha256"`,
    `headers="${headerNames.join(' ')}"`,
    `signature="${signature}"`,
  ].join(', ');

  return { headers };
}

/** Structural credential check (never talks to the network). */
export function credentialsWellFormed(cred: OciCredentials): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!cred.tenancy || !/^ocid1\.tenancy\.oc1\.[a-z0-9.]+$/i.test(cred.tenancy)) missing.push('tenancy OCID');
  if (!cred.user || !/^ocid1\.user\.oc1\.[a-z0-9.]+$/i.test(cred.user)) missing.push('user OCID');
  if (!cred.fingerprint || !/^[0-9a-f]{2}(:[0-9a-f]{2}){15}$/i.test(cred.fingerprint)) missing.push('key fingerprint');
  if (!cred.privateKey) missing.push('private key');
  if (!cred.region || !/^[a-z]{2}-[a-z]+-\d+$/.test(cred.region)) missing.push('region');
  return { ok: missing.length === 0, missing };
}
