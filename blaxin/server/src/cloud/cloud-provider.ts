// BLAXIN cloud provider abstraction
// =============================================================
// The provider-neutral contract every cloud backend implements. OCI is
// the first complete implementation; AWS/Azure/GCP plug in here later
// without touching provisioning, recommendation or the Brain.
//
// The Core (Brain, recommendation, provisioning state machine) depends
// ONLY on this interface — never on OCI-specific structures.
// =============================================================

import { ResourceInventory } from '../models/resource-inventory.js';

// ── Discovery (normalized, provider-neutral shapes) ─────────────

export interface CloudResourceShape {
  /** Provider shape name, e.g. "VM.Standard.A1.Flex". */
  id: string;
  /** Normalized architecture. */
  architecture: 'x86_64' | 'aarch64' | 'other';
  ocpus: number | null;
  /** RAM in bytes. */
  memoryBytes: number | null;
  /** GPUs attached to this shape. */
  gpus: number;
  /** VRAM per GPU in bytes (null when unknown). */
  vramBytesPerGpu: number | null;
  /** True when this shape can be created in the current quota/capacity. */
  limitKnown: boolean;
  /** Remaining quota for this shape (instances), null when unknown. */
  availableCount: number | null;
  /** Local disk in bytes attached by default, null when unknown. */
  storageBytes: number | null;
}

export interface CloudInstance {
  id: string;
  name: string;
  shapeId: string;
  /** Normalized lifecycle state. */
  state: 'provisioning' | 'running' | 'stopped' | 'terminated' | 'other';
  /** Public IP when assigned (never persisted as a secret — it routes
   * only through the Brain's outbound SSH tunnel). */
  publicIp: string | null;
  architecture: 'x86_64' | 'aarch64' | 'other';
  ocpus: number | null;
  memoryBytes: number | null;
  gpus: number;
  compartmentId: string;
  /** Availability domain. */
  ad: string | null;
}

export interface CloudQuotaSummary {
  /** Service, e.g. "compute". */
  service: string;
  /** Human scope (region/AD/compartment). */
  scope: string;
  limit: number | null;
  used: number | null;
  available: number | null;
}

// ── Inventory mapping ───────────────────────────────────────────

/** The neutral inventory a cloud machine offers (mirrors the local
 * ResourceInventory shape so the recommendation engine can consume
 * both without branching). */
export interface CloudResourceInventory extends ResourceInventory {
  scope: 'cloud';
  /** Provider id (e.g. "oci"), region and instance context. */
  provider: string;
  region: string | null;
  instanceId: string | null;
  shapeId: string | null;
}

// ── Provider contract ───────────────────────────────────────────

export type CloudProviderId = string;

export interface CloudCredentialsStatus {
  configured: boolean;
  /** Human description of what is missing, when not configured. */
  missing: string[];
}

export interface CloudProvider {
  readonly id: CloudProviderId;
  readonly name: string;

  /** Are credentials present (never returns their values)? */
  credentialsStatus(): CloudCredentialsStatus;

  /** Remove stored credentials (user-initiated). */
  clearCredentials(): Promise<void>;

  /** Validate credentials against the live API. Throws with a clear
   * message on failure; never logs or returns secrets. */
  validateCredentials(): Promise<{ tenancyName: string | null; region: string | null; user: string | null }>;

  /** Discover tenancy structure: regions/ADs/compartments. */
  discoverTopology(): Promise<{
    region: string;
    regions: string[];
    compartments: Array<{ id: string; name: string; isDefault: boolean }>;
    availabilityDomains: Array<{ name: string; compartmentId: string }>;
  }>;

  /** Discover available shapes with quota/limit where accessible.
   * availability lists ADs where the shape had capacity at discovery
   * time; a missing AD name is "unknown", never an assumption. */
  discoverShapes(compartmentId: string): Promise<CloudResourceShape[]>;

  /** List existing instances in a compartment. */
  listInstances(compartmentId: string): Promise<CloudInstance[]>;

  /** Get one instance (state polling during provisioning). */
  getInstance(instanceId: string): Promise<CloudInstance | null>;

  /** Launch an instance. Implementations MUST be idempotent: passing the
   * same deploymentToken twice returns the existing instance instead of
   * creating a duplicate. Returns the instance (created or existing). */
  launchInstance(req: LaunchInstanceRequest): Promise<CloudInstance>;

  /** Terminate an instance (idempotent: terminating a terminated
   * instance reports success). */
  terminateInstance(instanceId: string): Promise<void>;

  /** Service limits/quota for a compartment (best-effort). */
  discoverQuota(compartmentId: string): Promise<CloudQuotaSummary[]>;

  /** Build the neutral inventory for a shape in this cloud. */
  inventoryForShape(shape: CloudResourceShape, compartmentId: string): CloudResourceInventory;
}

// ── Instance launch request ─────────────────────────────────────

export interface LaunchInstanceRequest {
  compartmentId: string;
  /** Availability domain (provider-specific name). */
  availabilityDomain: string;
  shapeId: string;
  /** OCPUs for flexible shapes; null = shape default. */
  ocpus: number | null;
  /** RAM in GB for flexible shapes; null = shape default. */
  memoryInGbs: number | null;
  /** Human display name. */
  displayName: string;
  /** Provider image OCID/id to boot (resolved by the caller from the
   * provider's platform image list — never a guessed value). */
  imageId: string;
  /** Boot volume size in GB (provider default when null). */
  bootVolumeSizeInGbs?: number | null;
  /** Idempotency token: same token ⇒ same instance (provider maps it
   * to a deterministic, uniquified name it can find again). */
  deploymentToken: string;
  /** cloud-init user-data (base64) to bootstrap the model server. */
  cloudInitBase64: string | null;
  /** SSH public key authorized on the instance (NOT the private key). */
  sshPublicKey: string | null;
}

// ── Deployment record (provider-neutral, persisted by the manager) ──

export type DeploymentState =
  | 'DISCOVERING' | 'VALIDATING' | 'PREPARING' | 'INSTALLING_RUNTIME'
  | 'DOWNLOADING_MODEL' | 'VERIFYING_MODEL' | 'STARTING_SERVER' | 'HEALTH_CHECK'
  | 'CONNECTING_BRAIN' | 'INFERENCE_TEST' | 'READY' | 'FAILED' | 'CANCELLED';

export const TERMINAL_DEPLOYMENT_STATES: readonly DeploymentState[] = ['READY', 'FAILED', 'CANCELLED'];

export interface DeploymentRecord {
  id: string;
  provider: CloudProviderId;
  /** Target shape + model chosen by the user. */
  shapeId: string;
  compartmentId: string;
  modelId: string;
  runtimeId: string;
  state: DeploymentState;
  /** Last human-readable step description (truthful). */
  detail: string;
  /** Instance id once created (null before). */
  instanceId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Error details when FAILED. */
  error?: string;
  /** The Brain provider endpoint once READY (loopback tunnel address). */
  endpoint?: string;
}
