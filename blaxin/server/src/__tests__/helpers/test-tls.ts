// BLAXIN test TLS helper
// =============================================================
// Generates a THROWAWAY CA + server certificate pair with openssl for
// WSS tests. The keys are created per-run in a temp dir and are used
// ONLY by automated tests — they are never device identities, never
// committed, and never used outside tests.
// =============================================================

import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { networkInterfaces } from 'os';

const exec = promisify(execFile);

export interface TestTls {
  dir: string;
  caCertPath: string;
  caKeyPath: string;
  serverCertPath: string;
  serverKeyPath: string;
  caCert: string;
  serverCert: string;
  serverKey: string;
  /** DNS/IP names the server cert is valid for. */
  san: { dns: string[]; ips: string[] };
}

/** All non-internal IPv4 addresses of this machine (the LAN face that a
 * "second machine" would connect to). */
export function localIpv4Addresses(): string[] {
  const out: string[] = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

async function openssl(args: string[]): Promise<void> {
  try {
    await exec('openssl', args, { timeout: 20_000 });
  } catch (error: any) {
    const stderr: string = error?.stderr || error?.message || String(error);
    throw new Error(`openssl failed: ${stderr.split('\n').slice(-4).join('\n')}`);
  }
}

/**
 * Create a throwaway root CA + server certificate in `dir`.
 *
 * SANs: always localhost + 127.0.0.1, plus any extra dns/ip names given.
 * The cert lives 2 days and is for automated tests only.
 */
export async function generateTestTls(
  dir: string,
  extras: { dns?: string[]; ips?: string[] } = {},
): Promise<TestTls> {
  mkdirSync(dir, { recursive: true });
  const caCertPath = join(dir, 'ca.pem');
  const caKeyPath = join(dir, 'ca.key');
  const serverCertPath = join(dir, 'server.pem');
  const serverKeyPath = join(dir, 'server.key');
  const serverCsrPath = join(dir, 'server.csr');

  const dns = ['localhost', ...(extras.dns ?? [])];
  const ips = ['127.0.0.1', '127.0.0.2', ...(extras.ips ?? [])];

  // Root CA (self-signed, CA:TRUE).
  await openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-keyout', caKeyPath, '-out', caCertPath,
    '-days', '2',
    '-subj', '/CN=Blaxin Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);

  // Server key + CSR.
  await openssl([
    'req', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-keyout', serverKeyPath, '-out', serverCsrPath,
    '-subj', '/CN=blaxin-test-server',
  ]);

  // Sign with the test CA (serverAuth + SAN list).
  const sanValues = [
    ...dns.map((d) => `DNS:${d}`),
    ...ips.map((i) => `IP:${i}`),
  ].join(',');
  const extFile = join(dir, 'san.cnf');
  writeFileSync(extFile, [
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    `subjectAltName=${sanValues}`,
    '',
  ].join('\n'));
  await openssl([
    'x509', '-req', '-in', serverCsrPath,
    '-CA', caCertPath, '-CAkey', caKeyPath, '-CAcreateserial',
    '-out', serverCertPath, '-days', '2', '-sha256',
    '-extfile', extFile,
  ]);

  return {
    dir,
    caCertPath,
    caKeyPath,
    serverCertPath,
    serverKeyPath,
    caCert: readFileSync(caCertPath, 'utf8'),
    serverCert: readFileSync(serverCertPath, 'utf8'),
    serverKey: readFileSync(serverKeyPath, 'utf8'),
    san: { dns, ips },
  };
}
