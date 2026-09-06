import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'blaxin-oci-client-'));
process.env.BLAXIN_DATA_DIR = TEST_DIR;

const { OciCloudProvider, resolveOciPlatformImageId, saveOciCredentials, clearOciCredentials } = await import('../../../src/cloud/oci/client.js');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CRED = {
  tenancy: 'ocid1.tenancy.oc1..aaaaaaaaexample',
  user: 'ocid1.user.oc1..aaaaaaaaexample',
  fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  region: 'us-ashburn-1',
};

const API = '/20160918';

/** Route-based fake OCI REST API. Returns raw JSON depending on path. */
function installFakeOci(routes: Array<{ match: (url: string, method: string) => boolean; respond: (url: string, method: string) => { status: number; body: unknown; headers?: Record<string, string> } }>) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const route = routes.find((r) => r.match(url.pathname + url.search, (init?.method || 'GET').toUpperCase()));
    if (!route) return new Response('{"code":"NotFound"}', { status: 404, headers: { 'content-type': 'application/json' } });
    const { status, body, headers } = route.respond(url.pathname + url.search, (init?.method || 'GET').toUpperCase());
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearOciCredentials();
});

describe('OCI REST client (signed, real shapes)', () => {
  it('discovers shapes with pagination and maps them to neutral resources', async () => {
    saveOciCredentials(CRED);
    installFakeOci([
      {
        match: (url) => url.startsWith(`${API}/shapes?`) && !url.includes('page='),
        respond: () => ({
          status: 200,
          body: [
            { shape: 'VM.Standard.E5.Flex', processor: { description: 'Intel Xeon' }, ocpus: 4, 'memory-in-gbs': 64 },
            { shape: 'VM.GPU.A10.2', gpus: 2, 'gpu-memory-in-mbs': 24576 },
          ],
          headers: { 'opc-next-page': 'abc123' },
        }),
      },
      {
        match: (url) => url.includes('page=abc123'),
        respond: () => ({
          status: 200,
          body: [{ shape: 'VM.Standard.A1.Flex', processor: { description: 'Ampere Altra ARM' }, ocpus: 4, 'memory-in-gbs': 24 }],
        }),
      },
    ]);

    const provider = new OciCloudProvider();
    const shapes = await provider.discoverShapes('ocid1.compartment.oc1..x');
    expect(shapes.length).toBe(3);
    const flex = shapes.find((s) => s.id === 'VM.Standard.E5.Flex')!;
    expect(flex.architecture).toBe('x86_64');
    expect(flex.ocpus).toBe(4);
    expect(flex.memoryBytes).toBe(64 * 1024 * 1024 * 1024);
    expect(flex.limitKnown).toBe(false); // honest: unknown until quota is read
    const gpu = shapes.find((s) => s.id === 'VM.GPU.A10.2')!;
    expect(gpu.gpus).toBe(2);
    expect(gpu.vramBytesPerGpu).toBe(24576 * 1024 * 1024);
    // Ampere → aarch64 classification
    expect(shapes.find((s) => s.id === 'VM.Standard.A1.Flex')!.architecture).toBe('aarch64');
  });

  it('maps instance lifecycle states and filters terminated instances', async () => {
    saveOciCredentials(CRED);
    installFakeOci([
      {
        match: (url) => url.startsWith(`${API}/instances?`),
        respond: () => ({
          status: 200,
          body: [
            { id: 'ocid1.instance.1', 'display-name': 'bax', shape: 'VM.Standard.A1.Flex', 'lifecycle-state': 'RUNNING', 'shape-config': { ocpus: 2, 'memory-in-gbs': 12 }, 'availability-domain': 'Uoc:PHX-AD-1' },
            { id: 'ocid1.instance.2', 'display-name': 'dead', shape: 'VM.Standard.E4.Flex', 'lifecycle-state': 'TERMINATED' },
            { id: 'ocid1.instance.3', 'display-name': 'boot', shape: 'VM.Standard.E4.Flex', 'lifecycle-state': 'PROVISIONING' },
          ],
        }),
      },
    ]);
    const provider = new OciCloudProvider();
    const instances = await provider.listInstances('ocid1.compartment.oc1..x');
    expect(instances.map((i) => i.id)).toEqual(['ocid1.instance.1', 'ocid1.instance.3']);
    const running = instances.find((i) => i.id === 'ocid1.instance.1')!;
    expect(running.state).toBe('running');
    expect(running.architecture).toBe('aarch64');
    expect(running.memoryBytes).toBe(12 * 1024 * 1024 * 1024);
    expect(running.ad).toBe('Uoc:PHX-AD-1');
  });

  it('treats a missing instance as null, not an error', async () => {
    saveOciCredentials(CRED);
    installFakeOci([{ match: (url) => url.includes('ocid1.instance.nope'), respond: () => ({ status: 404, body: { code: 'NotFound' } }) }]);
    const provider = new OciCloudProvider();
    expect(await provider.getInstance('ocid1.instance.nope')).toBeNull();
  });

  it('validates credentials with a real API call', async () => {
    saveOciCredentials(CRED);
    const fetchMock = installFakeOci([{ match: (url) => url.includes('/availabilityDomains'), respond: () => ({ status: 200, body: [{ name: 'Uoc:PHX-AD-1' }] }) }]);
    const provider = new OciCloudProvider();
    const info = await provider.validateCredentials();
    expect(info.region).toBe('us-ashburn-1');
    // the request must carry the signed Authorization header
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].headers).toMatchObject({ authorization: expect.stringContaining('Signature version="1"') });
  });

  it('maps quota/limits and computes availability truthfully', async () => {
    saveOciCredentials(CRED);
    installFakeOci([
      {
        match: (url) => url.includes(`${API}/limits?`),
        respond: () => ({
          status: 200,
          body: [
            { 'service-name': 'compute', name: 'standard-e5-core-count', 'availability-domain': 'Uoc:PHX-AD-1', value: 16, used: 6 },
            { 'service-name': 'compute', name: 'standard-a1-core-count', 'scope-name': 'REGION', value: 8, used: 8 },
          ],
        }),
      },
    ]);
    const provider = new OciCloudProvider();
    const quotas = await provider.discoverQuota('ocid1.compartment.oc1..x');
    expect(quotas.length).toBe(2);
    expect(quotas[0].limit).toBe(16);
    expect(quotas[0].used).toBe(6);
    expect(quotas[0].available).toBe(10);
    expect(quotas[1].available).toBe(0); // fully used — no fake headroom
  });

  it('launches idempotently: same deployment token reuses the instance', async () => {
    saveOciCredentials(CRED);
    let postCount = 0;
    const fetchMock = installFakeOci([
      {
        // list existing instances — the token-named instance already exists
        match: (url, method) => method === 'GET' && url.startsWith(`${API}/instances?`),
        respond: () => ({ status: 200, body: [{ id: 'ocid1.instance.existing', 'display-name': 'blaxin-token-1', 'lifecycle-state': 'RUNNING', shape: 'VM.Standard.A1.Flex' }] }),
      },
      {
        match: (url, method) => method === 'POST' && url === `${API}/instances`,
        respond: () => { postCount++; return { status: 200, body: { id: 'ocid1.instance.new', 'display-name': 'blaxin-token-1', 'lifecycle-state': 'PROVISIONING', shape: 'VM.Standard.A1.Flex' } }; },
      },
    ]);
    const provider = new OciCloudProvider();
    const req = {
      compartmentId: 'ocid1.compartment.oc1..x',
      availabilityDomain: 'Uoc:PHX-AD-1',
      shapeId: 'VM.Standard.A1.Flex',
      ocpus: null,
      memoryInGbs: null,
      displayName: 'BLAXIN model',
      imageId: 'ocid1.image..x',
      deploymentToken: 'token-1',
      cloudInitBase64: null,
      sshPublicKey: 'ssh-ed25519 AAAA test',
    };
    const first = await provider.launchInstance(req);
    expect(first.id).toBe('ocid1.instance.existing');
    // The GET returned it, so no POST was made.
    expect(postCount).toBe(0);
    expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes('/instances') && (c[1] as RequestInit).method === 'GET')).toBe(true);
  });

  it('surfaces capacity shortages honestly', async () => {
    saveOciCredentials(CRED);
    installFakeOci([
      { match: (url, method) => method === 'GET' && url.startsWith(`${API}/instances?`), respond: () => ({ status: 200, body: [] }) },
      { match: (url, method) => method === 'POST' && url === `${API}/instances`, respond: () => ({ status: 500, body: { code: 'InternalError', message: 'Out of host capacity' } }) },
    ]);
    const provider = new OciCloudProvider();
    await expect(provider.launchInstance({
      compartmentId: 'ocid1.compartment.oc1..x',
      availabilityDomain: 'Uoc:PHX-AD-1',
      shapeId: 'VM.Standard.A1.Flex',
      ocpus: null,
      memoryInGbs: null,
      displayName: 'BLAXIN model',
      imageId: 'ocid1.image..x',
      deploymentToken: 'token-2',
      cloudInitBase64: null,
      sshPublicKey: null,
    })).rejects.toThrow(/Out of host capacity/i);
  });

  it('maps auth failures to an actionable message that never echoes secrets', async () => {
    saveOciCredentials(CRED);
    installFakeOci([{ match: () => true, respond: () => ({ status: 401, body: { code: 'NotAuthenticated', message: 'wrong key' } }) }]);
    const provider = new OciCloudProvider();
    await expect(provider.validateCredentials()).rejects.toThrow(/OCI authentication failed/);
    await expect(provider.validateCredentials()).rejects.not.toThrow(/MII|PRIVATE|ocid1/);
  });

  it('resolves the newest Ubuntu platform image (real API, shape-qualified first)', async () => {
    saveOciCredentials(CRED);
    installFakeOci([
      {
        match: (url) => url.includes('/images?') && url.includes('shape='),
        respond: () => ({ status: 200, body: [{ id: 'ocid1.image.ubuntu2404', 'display-name': 'Canonical-Ubuntu-24.04' }] }),
      },
    ]);
    const provider = new OciCloudProvider();
    void provider;
    const imageId = await resolveOciPlatformImageId('x86_64');
    expect(imageId).toBe('ocid1.image.ubuntu2404');
  });

  it('fails honestly when no platform image exists', async () => {
    saveOciCredentials(CRED);
    installFakeOci([
      { match: (url) => url.includes('/images?'), respond: () => ({ status: 200, body: [] }) },
    ]);
    await expect(resolveOciPlatformImageId('aarch64')).rejects.toThrow(/No Canonical Ubuntu platform image/);
  });

  it('reports credentials as missing before any account is connected', () => {
    const status = new OciCloudProvider().credentialsStatus();
    expect(status.configured).toBe(false);
    expect(status.missing.length).toBeGreaterThan(0);
  });
});