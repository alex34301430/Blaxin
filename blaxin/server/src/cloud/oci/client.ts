// BLAXIN OCI REST client
// =============================================================
// Thin, signed wrapper over the OCI REST API (core services group:
// /20160918). Performs REAL discovery — tenancy, region, compartments,
// availability domains, shapes, instances and limits — and maps every
// response onto the provider-neutral CloudProvider types.
//
// Hard rules:
//   - credentials are stored encrypted at rest (see secret-store) and
//     are never logged, echoed, or included in error messages
//   - pagination is followed via the opc-next-page header so discovery
//     is complete for tenancies of any size
//   - every network failure produces a clear error, never a guess
// =============================================================

import {
  CloudProvider, CloudCredentialsStatus, CloudInstance, CloudQuotaSummary,
  CloudResourceShape, CloudResourceInventory, LaunchInstanceRequest,
} from '../cloud-provider.js';
import { OciCredentials, signRequest, credentialsWellFormed } from './signer.js';
import { loadOciCredentials, saveOciCredentials, clearOciCredentials } from './secret-store.js';

const API = '/20160918';

/** An API error carrying the HTTP status, so callers can distinguish
 * "resource not found" (404) from hard failures. Message is sanitized
 * and never contains credentials. */
export class OciHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'OciHttpError';
  }
}

/** One signed OCI API call. Throws Error with a sanitized message.
 * Returns the parsed body plus the raw response headers (needed for
 * opc-next-page pagination). */
async function ociCall<T>(
  cred: OciCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data: T; headers: Record<string, string> }> {
  const host = `iaas.${cred.region}.oraclecloud.com`;
  const bodyText = body === undefined ? null : JSON.stringify(body);
  const { headers } = signRequest(cred, {
    method,
    path,
    host,
    body: bodyText,
  });
  const url = `https://${host}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: bodyText ?? undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error: any) {
    throw new Error(`OCI request failed (network): ${error.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    // Surface status + a short API message; NEVER echo the request or
    // credentials (the API error body contains only Oracle's message).
    let apiMessage = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string; code?: string };
      if (j.message) apiMessage = j.message + (j.code ? ` (${j.code})` : '');
    } catch { /* keep raw slice */ }
    if (res.status === 401) {
      throw new Error(`OCI authentication failed: check the tenancy OCID, user OCID, fingerprint, key and region (401)`);
    }
    if (res.status === 403) {
      throw new Error(`OCI authorization failed: the user lacks permissions for this call (403)`);
    }
    if (res.status === 429) {
      throw new Error('OCI rate limited (429): too many requests, retry shortly');
    }
    // 404 = "not found / NotAuthorizedOrNotFound": a status-carrying error
    // so callers (e.g. getInstance) can treat a missing resource as null
    // while hard failures keep their status for honest surfacing.
    throw new OciHttpError(res.status, `OCI API error ${res.status}: ${apiMessage}`);
  }
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return { data: (text ? JSON.parse(text) : null) as T, headers: out };
}

/** Follow opc-next-page to gather every page. Bounded page count. */
async function ociList<T>(cred: OciCredentials, path: string): Promise<T[]> {
  const out: T[] = [];
  let nextPath: string | null = path;
  let guard = 0;
  while (nextPath && guard < 100) {
    guard++;
    const page: { data: T[]; headers: Record<string, string> } = await ociCall<T[]>(cred, 'GET', nextPath);
    if (Array.isArray(page.data)) out.push(...page.data);
    const nextPage: string | undefined = page.headers['opc-next-page'];
    if (nextPage) {
      const sep: string = nextPath.includes('?') ? '&' : '?';
      // Replace any previous page marker rather than appending forever.
      nextPath = nextPath.includes('page=')
        ? `${nextPath.split('&page=')[0]}${sep}page=${encodeURIComponent(nextPage)}`
        : `${nextPath}${sep}page=${encodeURIComponent(nextPage)}`;
    } else {
      nextPath = null;
    }
  }
  return out;
}

interface OciShapeRaw {
  shape?: string;
  'gpu-description'?: string;
  'max-vpus-per-ocpu'?: number;
  ocpus?: number;
  'memory-in-gbs'?: number;
  'network-ports'?: number;
  'is-live-migration-supported'?: boolean;
  processor?: { description?: string };
  gpus?: number;
  'gpu-memory-in-mbs'?: number;
}

interface OciInstanceRaw {
  id?: string;
  'display-name'?: string;
  shape?: string;
  'lifecycle-state'?: string;
  region?: string;
  'compartment-id'?: string;
  'availability-domain'?: string;
  'shape-config'?: { ocpus?: number; 'memory-in-gbs'?: number };
}

interface OciLimitRaw {
  'service-name'?: string;
  name?: string;
  'availability-domain'?: string;
  'scope-name'?: string;
  value?: number;
  used?: number;
}

function normArch(processorDescription: string | undefined, shapeName: string | undefined): CloudResourceShape['architecture'] {
  const text = `${processorDescription || ''} ${shapeName || ''}`.toLowerCase();
  if (text.includes('a1') || text.includes('aarch') || text.includes('ampere') || text.includes('arm')) return 'aarch64';
  if (text.includes('x86') || text.includes('intel') || text.includes('amd') || text.includes('epyc')) return 'x86_64';
  return 'other';
}

function instanceState(raw: string | undefined): CloudInstance['state'] {
  switch (raw) {
    case 'RUNNING': return 'running';
    case 'STARTING': case 'PROVISIONING': return 'provisioning';
    case 'STOPPED': case 'STOPPING': return 'stopped';
    case 'TERMINATED': case 'TERMINATING': return 'terminated';
    default: return 'other';
  }
}

/** Deterministic, uniquified instance name for a deployment token.
 * Same token ⇒ same name ⇒ launchInstance can find its previous work
 * instead of creating a duplicate. Never contains secrets. */
export function instanceNameForToken(token: string): string {
  return `blaxin-${token.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)}`;
}

function mapInstance(raw: OciInstanceRaw, compartmentId: string): CloudInstance {
  return {
    id: raw.id || '',
    name: raw['display-name'] || raw.id || '',
    shapeId: raw.shape || 'unknown',
    state: instanceState(raw['lifecycle-state']),
    publicIp: null, // filled by the deployment manager from the VNIC
    architecture: normArch(undefined, raw.shape),
    ocpus: raw['shape-config']?.ocpus ?? null,
    memoryBytes: raw['shape-config']?.['memory-in-gbs']
      ? raw['shape-config']!['memory-in-gbs']! * 1024 * 1024 * 1024
      : null,
    gpus: /\.GPU\./i.test(raw.shape || '') ? 1 : 0,
    compartmentId: raw['compartment-id'] || compartmentId,
    ad: raw['availability-domain'] || null,
  };
}

/** The OCI CloudProvider implementation. */
export class OciCloudProvider implements CloudProvider {
  readonly id = 'oci';
  readonly name = 'Oracle Cloud';

  credentialsStatus(): CloudCredentialsStatus {
    const cred = loadOciCredentials();
    if (!cred) {
      return { configured: false, missing: ['tenancy OCID', 'user OCID', 'API key fingerprint', 'private key', 'region'] };
    }
    const check = credentialsWellFormed(cred);
    return { configured: check.ok, missing: check.missing };
  }

  async clearCredentials(): Promise<void> {
    clearOciCredentials();
  }

  private cred(): OciCredentials {
    const cred = loadOciCredentials();
    if (!cred) throw new Error('OCI is not configured. Connect an Oracle Cloud account first.');
    return cred;
  }

  async validateCredentials(): Promise<{ tenancyName: string | null; region: string | null; user: string | null }> {
    const cred = this.cred();
    const check = credentialsWellFormed(cred);
    if (!check.ok) throw new Error(`OCI credentials incomplete: missing ${check.missing.join(', ')}`);
    // Real call: listing availability domains proves the key works.
    await ociCall<Array<{ name?: string }>>(cred, 'GET', `${API}/availabilityDomains`);
    // (response shape unused; the successful call is the proof)
    return { tenancyName: cred.tenancyName ?? null, region: cred.region, user: cred.user };
  }

  async discoverTopology(): Promise<{
    region: string;
    regions: string[];
    compartments: Array<{ id: string; name: string; isDefault: boolean }>;
    availabilityDomains: Array<{ name: string; compartmentId: string }>;
  }> {
    const cred = this.cred();
    const compartments = await ociList<{ id?: string; name?: string; 'compartment-id'?: string }>(
      cred,
      `${API}/compartments?compartmentId=${encodeURIComponent(cred.tenancy)}&accessLevel=ACCESSIBLE&compartmentIdInSubtree=true&lifecycleState=ACTIVE`,
    );
    const tenancyCompartment = { id: cred.tenancy, name: 'root', isDefault: true };
    const comps = [
      tenancyCompartment,
      ...compartments
        .filter((c) => c.id && c.name)
        .map((c) => ({ id: c.id!, name: c.name!, isDefault: false })),
    ];
    const ads = await ociCall<Array<{ name?: string; 'compartment-id'?: string }>>(cred, 'GET', `${API}/availabilityDomains`);
    return {
      region: cred.region,
      regions: [cred.region],
      compartments: comps,
      availabilityDomains: ads.data
        .filter((a) => a.name)
        .map((a) => ({ name: a.name!, compartmentId: a['compartment-id'] || cred.tenancy })),
    };
  }

  async discoverShapes(compartmentId: string): Promise<CloudResourceShape[]> {
    const cred = this.cred();
    const raw = await ociList<OciShapeRaw>(cred, `${API}/shapes?compartmentId=${encodeURIComponent(compartmentId)}`);
    const shapes: CloudResourceShape[] = [];
    for (const s of raw) {
      if (!s.shape) continue;
      const gpus = Number(s.gpus ?? 0) || (/\.GPU\./i.test(s.shape) ? 1 : 0);
      shapes.push({
        id: s.shape,
        architecture: normArch(s.processor?.description, s.shape),
        ocpus: typeof s.ocpus === 'number' ? s.ocpus : null,
        memoryBytes: typeof s['memory-in-gbs'] === 'number' ? s['memory-in-gbs'] * 1024 * 1024 * 1024 : null,
        gpus,
        vramBytesPerGpu: typeof s['gpu-memory-in-mbs'] === 'number' ? s['gpu-memory-in-mbs'] * 1024 * 1024 : null,
        limitKnown: false,
        availableCount: null,
        storageBytes: null,
      });
    }
    return shapes;
  }

  async listInstances(compartmentId: string): Promise<CloudInstance[]> {
    const cred = this.cred();
    const raw = await ociList<OciInstanceRaw>(cred, `${API}/instances?compartmentId=${encodeURIComponent(compartmentId)}`);
    return raw
      .filter((i) => i.id && i['lifecycle-state'] !== 'TERMINATED')
      .map((i) => mapInstance(i, compartmentId));
  }

  async getInstance(instanceId: string): Promise<CloudInstance | null> {
    const cred = this.cred();
    try {
      const { data: inst } = await ociCall<OciInstanceRaw>(cred, 'GET', `${API}/instances/${encodeURIComponent(instanceId)}`);
      if (!inst || !inst.id) return null;
      return mapInstance(inst, inst['compartment-id'] || '');
    } catch (error: any) {
      // Authorized-but-missing resources are null; auth problems are
      // plain Errors and keep propagating.
      if (error instanceof OciHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async launchInstance(req: LaunchInstanceRequest): Promise<CloudInstance> {
    const cred = this.cred();
    const displayName = instanceNameForToken(req.deploymentToken);

    // Idempotency: find our previous instance for this token first.
    const existing = await this.listInstances(req.compartmentId);
    const mine = existing.find((i) => i.name === displayName);
    if (mine && mine.state !== 'terminated') {
      return mine;
    }

    const shapeConfig: Record<string, number> = {};
    if (req.ocpus !== null) shapeConfig.ocpus = req.ocpus;
    if (req.memoryInGbs !== null) shapeConfig['memory-in-gbs'] = req.memoryInGbs;

    const metadata: Record<string, string> = {};
    if (req.sshPublicKey) metadata.ssh_authorized_keys = req.sshPublicKey;
    // OCI cloud-init: base64 user_data inside metadata (per OCI docs).
    if (req.cloudInitBase64) metadata.user_data = req.cloudInitBase64;

    const sourceDetails: Record<string, unknown> = {
      // The image OCID is resolved by the caller from the platform image
      // list — never a guessed value.
      imageId: req.imageId,
      bootVolumeSizeInGBs: req.bootVolumeSizeInGbs ?? 50,
    };

    const body: Record<string, unknown> = {
      compartmentId: req.compartmentId,
      availabilityDomain: req.availabilityDomain,
      shape: req.shapeId,
      displayName,
      sourceDetails,
    };
    if (Object.keys(shapeConfig).length > 0) body['shape-config'] = shapeConfig;
    if (Object.keys(metadata).length > 0) body.metadata = metadata;

    try {
      const { data: created } = await ociCall<OciInstanceRaw>(cred, 'POST', `${API}/instances`, body);
      if (!created || !created.id) throw new Error('OCI returned no instance id');
      return mapInstance(created, req.compartmentId);
    } catch (error: any) {
      // Capacity errors are common and actionable — surface them honestly.
      if (/Out of host capacity/i.test(error.message || '')) {
        throw new Error('OCI has no burstable capacity for this shape in this AD right now (Out of host capacity). Try a different AD, shape, or retry later.');
      }
      throw error;
    }
  }

  async terminateInstance(instanceId: string): Promise<void> {
    const cred = this.cred();
    try {
      await ociCall<unknown>(cred, 'DELETE', `${API}/instances/${encodeURIComponent(instanceId)}`);
    } catch (error: any) {
      // Idempotent: terminating a terminated instance is success.
      if (/404/.test(error.message || '')) return;
      throw error;
    }
  }

  async discoverQuota(compartmentId: string): Promise<CloudQuotaSummary[]> {
    const cred = this.cred();
    // Real limits API (service limits): per-AD limits for compute.
    const { data: limits } = await ociCall<OciLimitRaw[]>(cred, 'GET', `${API}/limits?compartmentId=${encodeURIComponent(compartmentId)}&serviceName=compute`);
    const out: CloudQuotaSummary[] = [];
    for (const l of limits) {
      out.push({
        service: l['service-name'] || 'compute',
        scope: l['availability-domain'] || l['scope-name'] || 'region',
        limit: typeof l.value === 'number' ? l.value : null,
        used: typeof l.used === 'number' ? l.used : null,
        available: typeof l.value === 'number' && typeof l.used === 'number' ? l.value - l.used : null,
      });
    }
    return out;
  }

  inventoryForShape(shape: CloudResourceShape, _compartmentId: string): CloudResourceInventory {
    const cred = this.cred();
    return {
      schemaVersion: 1,
      scope: 'cloud',
      provider: this.id,
      region: cred.region,
      instanceId: null,
      shapeId: shape.id,
      os: { platform: 'linux', release: 'Oracle Linux (provisioned)', family: 'linux' },
      architecture: shape.architecture,
      cpu: {
        cores: shape.ocpus ? shape.ocpus * 2 : 0,
        physicalCores: shape.ocpus,
        model: shape.id,
        clockMhz: null,
        flags: { avx2: shape.architecture === 'x86_64' ? true : false, avx512: false, neon: shape.architecture === 'aarch64' },
      },
      memoryBytes: shape.memoryBytes ?? 0,
      gpus: shape.gpus > 0
        ? [{
            name: shape.id,
            vramBytes: shape.vramBytesPerGpu ? shape.vramBytesPerGpu * shape.gpus : null,
            kind: 'nvidia-cuda',
          }]
        : [],
      storage: { freeBytes: null, totalBytes: null },
      detectedAt: Date.now(),
    };
  }
}

/** Resolve the newest Canonical Ubuntu platform image for an
 * architecture from the REAL platform-images API (never a guessed
 * OCID). Tries the shape-qualified query first (returns matching
 * images), then falls back to a shape-agnostic query. */
export async function resolveOciPlatformImageId(arch: CloudResourceShape['architecture']): Promise<string> {
  const cred = loadOciCredentials();
  if (!cred) throw new Error('OCI is not configured. Connect an Oracle Cloud account first.');

  const shapeHint = arch === 'aarch64' ? 'VM.Standard.A1.Flex' : 'VM.Standard.E5.Flex';
  const base = `${API}/images?compartmentId=${encodeURIComponent(cred.tenancy)}&operatingSystem=${encodeURIComponent('Canonical Ubuntu')}&sortBy=${encodeURIComponent('-time-created')}`;
  const attempts = [`${base}&shape=${encodeURIComponent(shapeHint)}`, base];

  for (const url of attempts) {
    try {
      const { data } = await ociCall<Array<{ id?: string; 'display-name'?: string }>>(cred, 'GET', url);
      const image = (data || []).find((i) => i && i.id);
      if (image && image.id) return image.id;
    } catch (error: any) {
      // A region may reject the shape-qualified query; try the plain one.
      if (/404/.test(error.message || '')) continue;
      throw error;
    }
  }
  throw new Error('No Canonical Ubuntu platform image was found in this tenancy. Check that images are visible to your user.');
}

// Re-export credential storage helpers so callers have one import point
// without the API client reaching into secret storage internals.
export { saveOciCredentials, loadOciCredentials, clearOciCredentials, ociCredentialSummary } from './secret-store.js';
