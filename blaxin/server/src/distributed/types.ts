// BLAXIN distributed architecture — shared types
// =============================================================
// BLAXIN is split into a BODY (the desktop execution device) and a
// BRAIN (the external intelligence). This module holds the types both
// sides speak: identity, connection states, capabilities, wire
// messages and the device registry record.
//
// The Brain reasons/plans and requests *structured actions*; the Body
// validates every action against its own capability + policy layer and
// executes it locally. The Brain never runs arbitrary commands on the
// Body.
// =============================================================

export const DEVICE_ROLE_BODY = 'body' as const;
export const DEVICE_ROLE_BRAIN = 'brain' as const;
export type DeviceRole = typeof DEVICE_ROLE_BODY | typeof DEVICE_ROLE_BRAIN;

/** Human-safe device id, e.g. BLX-BODY-8F2A or BLX-BRAIN-3C91. */
export type DeviceId = string;

export const BODY_ID_PREFIX = 'BLX-BODY-';
export const BRAIN_ID_PREFIX = 'BLX-BRAIN-';

/** Connection lifecycle states (see transport.ts for the state machine). */
export type ConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'AUTHENTICATING'
  | 'CONNECTED'
  | 'DEGRADED'
  | 'RECONNECTING'
  | 'REVOKED'
  | 'INCOMPATIBLE'
  | 'ERROR';

export const CONNECTION_STATES: readonly ConnectionState[] = [
  'DISCONNECTED', 'CONNECTING', 'AUTHENTICATING', 'CONNECTED', 'DEGRADED',
  'RECONNECTING', 'REVOKED', 'INCOMPATIBLE', 'ERROR',
];

/** Canonical body capabilities. Every capability maps to one or more
 * local tools on the Body; the Brain must never assume a capability
 * exists before the Body advertises it. */
export type BodyCapability =
  | 'filesystem'
  | 'terminal'
  | 'browser'
  | 'screenshot'
  | 'computer-control'
  | 'microphone'
  | 'camera'
  | 'clipboard'
  | 'search'
  | 'system-info';

export const KNOWN_CAPABILITIES: readonly BodyCapability[] = [
  'filesystem', 'terminal', 'browser', 'screenshot', 'computer-control',
  'microphone', 'camera', 'clipboard', 'search', 'system-info',
];

export type CapabilitySet = BodyCapability[];

// ── Identity ────────────────────────────────────────────────────

/** A persistent device keypair + identity, stored only on its device. */
export interface DeviceIdentityRecord {
  role: DeviceRole;
  id: DeviceId;
  /** base64 Ed25519 public key (identity exchange). */
  publicKey: string;
  /** base64 Ed25519 secret key — never leaves this device. */
  secretKey: string;
  name: string;
  createdAt: number;
}

/** The public half of a device identity (safe to send over the wire). */
export interface PublicDeviceIdentity {
  role: DeviceRole;
  id: DeviceId;
  name: string;
  publicKey: string;
}

// ── Registry (Brain side) ───────────────────────────────────────

export type DeviceStatus = 'online' | 'offline' | 'revoked';

export interface RegisteredBody {
  bodyId: DeviceId;
  name: string;
  publicKey: string;
  capabilities: CapabilitySet;
  protocolMin: number;
  protocolMax: number;
  status: DeviceStatus;
  lastSeen: number;
  pairedAt: number;
  revokedAt?: number;
  /** Connection/session bookkeeping (never persisted secrets). */
  sessionId?: string;
  /** Highest action id the body has acknowledged for the active task. */
  lastAckedActionId?: string;
  activeTaskId?: string;
}

// ── Wire protocol ───────────────────────────────────────────────

/** Versioned message envelope. Every frame on the Brain↔Body socket. */
export interface WireMessage {
  /** Protocol version of THIS message (negotiated before use). */
  v: number;
  type: MessageType;
  /** Unique message id (replay protection). */
  id: string;
  /** Sender epoch ms. Rejected when too skewed from the receiver clock. */
  ts: number;
  from: DeviceRole;
  /** Sender device id (BLX-BRAIN-… / BLX-BODY-…). */
  deviceId: DeviceId;
  /** Optional request id echoed in replies for correlation. */
  req?: string;
  payload?: Record<string, unknown>;
}

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_MIN_SUPPORTED = 1;
export const PROTOCOL_MAX_SUPPORTED = 1;

/** Maximum serialized frame the transport accepts (before JSON parse). */
export const MAX_FRAME_BYTES = 512 * 1024;
/** Maximum payload object depth / string length guards. */
export const MAX_PAYLOAD_STRING = 200_000;
export const MAX_MESSAGE_SKEW_MS = 5 * 60 * 1000;
/** Replay-protection window: duplicate message ids inside it are dropped. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export const MESSAGE_TYPES = [
  'hello', 'pair_request', 'pair_accept', 'pair_reject',
  'auth_challenge', 'auth_response', 'auth_result',
  'ready', 'state_sync', 'state_sync_ack', 'ack',
  'capabilities', 'ping', 'pong',
  'task_start', 'task_update', 'task_action', 'action_result',
  'approval_required', 'approval_result', 'task_cancel',
  'task_complete', 'task_failed', 'error', 'revoked',
] as const;

export type MessageType = typeof MESSAGE_TYPES[number];

// Directional policy: which role may legally send which message.
// Anything not listed for a role is rejected as unknown/dangerous.
export const ALLOWED_SENDERS: Record<MessageType, DeviceRole[]> = {
  hello: [DEVICE_ROLE_BODY, DEVICE_ROLE_BRAIN],
  pair_request: [DEVICE_ROLE_BODY],
  pair_accept: [DEVICE_ROLE_BRAIN],
  pair_reject: [DEVICE_ROLE_BRAIN],
  auth_challenge: [DEVICE_ROLE_BODY, DEVICE_ROLE_BRAIN],
  auth_response: [DEVICE_ROLE_BODY, DEVICE_ROLE_BRAIN],
  auth_result: [DEVICE_ROLE_BODY, DEVICE_ROLE_BRAIN],
  ready: [DEVICE_ROLE_BRAIN],
  state_sync: [DEVICE_ROLE_BODY],
  state_sync_ack: [DEVICE_ROLE_BRAIN],
  ack: [DEVICE_ROLE_BODY, DEVICE_ROLE_BRAIN],
  capabilities: [DEVICE_ROLE_BODY, DEVICE_ROLE_BRAIN],
  ping: [DEVICE_ROLE_BODY, DEVICE_ROLE_BRAIN],
  pong: [DEVICE_ROLE_BODY, DEVICE_ROLE_BRAIN],
  task_start: [DEVICE_ROLE_BODY],
  task_update: [DEVICE_ROLE_BRAIN],
  task_action: [DEVICE_ROLE_BRAIN],
  action_result: [DEVICE_ROLE_BODY],
  approval_required: [DEVICE_ROLE_BODY],
  approval_result: [DEVICE_ROLE_BODY],
  task_cancel: [DEVICE_ROLE_BODY],
  task_complete: [DEVICE_ROLE_BRAIN],
  task_failed: [DEVICE_ROLE_BRAIN],
  error: [DEVICE_ROLE_BODY, DEVICE_ROLE_BRAIN],
  revoked: [DEVICE_ROLE_BRAIN],
};

// ── Task lifecycle (canonical, Brain-side authority) ────────────

/** Canonical task lifecycle. The Brain maps its internal driver states
 * onto these for every surface (registry, REST, UI, recovery). */
export type TaskLifecycle =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'CONNECTION_LOST'
  | 'UNKNOWN_OUTCOME'
  | 'RECOVERING';

export const TASK_LIFECYCLE_STATES: readonly TaskLifecycle[] = [
  'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED',
  'CONNECTION_LOST', 'UNKNOWN_OUTCOME', 'RECOVERING',
];

/** Map an internal driver state onto the canonical lifecycle. Unknown
 * states map to RUNNING (they are, by definition, in progress). */
export function taskLifecycleOf(state: string): TaskLifecycle {
  switch (state) {
    case 'queued': return 'QUEUED';
    case 'planning':
    case 'thinking':
    case 'executing':
    case 'observing': return 'RUNNING';
    case 'completed': return 'COMPLETED';
    case 'failed': return 'FAILED';
    case 'cancelled': return 'CANCELLED';
    case 'interrupted': return 'CONNECTION_LOST';
    case 'recovering': return 'RECOVERING';
    case 'unknown-outcome': return 'UNKNOWN_OUTCOME';
    default: return 'RUNNING';
  }
}

export function isTerminalLifecycle(state: TaskLifecycle): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED'
    || state === 'CONNECTION_LOST' || state === 'UNKNOWN_OUTCOME';
}

// ── Task / action payloads ──────────────────────────────────────

export type ActionResultOutcome = 'allowed' | 'denied' | 'rejected';

export interface TaskActionRequest {
  taskId: string;
  actionId: string;
  requestId: string;
  /** Structured action the Brain asks the Body to execute. */
  action: { tool: string; args: Record<string, unknown> };
  /**
   * true → safe to re-execute after reconnect (reads, idempotent writes).
   * false → the Body must NEVER blindly replay it; it verifies local
   * state first and reports UNKNOWN_STATE when it cannot prove whether
   * the action already ran.
   */
  idempotent: boolean;
  description: string;
}

export interface ActionResult {
  taskId: string;
  actionId: string;
  requestId: string;
  outcome: ActionResultOutcome;
  /** true when the tool actually ran on this request. */
  executed: boolean;
  /** true when answered from the persisted executed-action cache. */
  replay: boolean;
  success?: boolean;
  output?: string;
  error?: string;
}

export interface TaskUpdatePayload {
  taskId: string;
  state: string;
  description?: string;
  stepCount?: number;
}

/** Body → Brain: the user asked to stop this task. The Brain resolves
 * pending actions as CANCELLED and answers with task_failed CANCELLED
 * once the driver unwinds (never replays, never fabricates outcomes). */
export interface TaskCancelPayload {
  taskId: string;
}

// ── Heartbeat / timing ──────────────────────────────────────────

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;

/** Reconnect backoff (seconds). Jitter is applied per attempt. */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000, 60_000];
export const MAX_RECONNECT_BACKOFF_MS = 60_000;
