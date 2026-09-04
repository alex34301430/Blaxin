// BLAXIN distributed protocol
// =============================================================
// Strongly typed, validated wire protocol between a BLAXIN Body and a
// BLAXIN Brain (Brain Protocol v1).
//
// Guarantees implemented here:
//   - every inbound frame is validated against a strict envelope schema
//   - unsupported protocol versions are rejected before anything runs
//   - protocol ranges are negotiated (max supported version in the
//     intersection of both sides' ranges)
//   - unknown / direction-forbidden message types are rejected
//   - payload size + depth caps (no unbounded memory)
//   - replay protection (duplicate message ids within a window)
//   - clock-skew rejection (frames far in the past/future)
// =============================================================

import { v4 as uuidv4 } from 'uuid';
import {
  ALLOWED_SENDERS, CapabilitySet, DeviceRole, KNOWN_CAPABILITIES, MESSAGE_TYPES,
  MessageType, MAX_FRAME_BYTES, MAX_MESSAGE_SKEW_MS, MAX_PAYLOAD_STRING,
  PROTOCOL_MAX_SUPPORTED, PROTOCOL_MIN_SUPPORTED, PROTOCOL_VERSION,
  REPLAY_WINDOW_MS, WireMessage,
} from './types.js';

export type ValidationResult =
  | { ok: true; message: WireMessage }
  | { ok: false; code: string; reason: string };

/** Cap protocol / size values for hostile or malformed input. */
export function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return Math.max(min, Math.min(n, max));
}

/** Negotiate the protocol version from two [min, max] ranges.
 * Returns the highest mutually supported version, or null. */
export function negotiateProtocol(
  aMin: number, aMax: number, bMin: number, bMax: number,
): number | null {
  const lo = Math.max(aMin, bMin);
  const hi = Math.min(aMax, bMax);
  return lo <= hi ? hi : null;
}

/** Build a new outbound frame. */
export function createMessage(
  from: DeviceRole,
  deviceId: string,
  type: MessageType,
  payload?: Record<string, unknown>,
  req?: string,
): WireMessage {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: uuidv4(),
    ts: Date.now(),
    from,
    deviceId,
    ...(req ? { req } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };
}

/**
 * Validate a decoded inbound frame. When `expectedFrom` is given the
 * frame's sender role + directional type policy are enforced; when it is
 * omitted only structural checks run (the caller applies role policy).
 */
export function validateWireMessage(raw: unknown, expectedFrom?: DeviceRole): ValidationResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, code: 'MALFORMED', reason: 'Frame is not an object' };
  }
  const m = raw as Record<string, unknown>;

  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 64) {
    return { ok: false, code: 'MALFORMED', reason: 'Missing or invalid message id' };
  }
  if (typeof m.type !== 'string' || !(MESSAGE_TYPES as readonly string[]).includes(m.type)) {
    return { ok: false, code: 'UNKNOWN_TYPE', reason: 'Unknown message type' };
  }
  const type = m.type as MessageType;

  if (typeof m.v !== 'number' || !Number.isInteger(m.v)) {
    return { ok: false, code: 'MALFORMED', reason: 'Missing protocol version' };
  }
  if (m.v < PROTOCOL_MIN_SUPPORTED || m.v > PROTOCOL_MAX_SUPPORTED) {
    return { ok: false, code: 'UNSUPPORTED_VERSION', reason: `Protocol version ${m.v} is not supported` };
  }

  if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) {
    return { ok: false, code: 'MALFORMED', reason: 'Missing timestamp' };
  }
  const skew = Math.abs(Date.now() - m.ts);
  if (skew > MAX_MESSAGE_SKEW_MS) {
    return { ok: false, code: 'CLOCK_SKEW', reason: `Timestamp is ${Math.round(skew / 1000)}s from local clock` };
  }

  if (typeof m.deviceId !== 'string' || !/^BLX-(BODY|BRAIN)-[A-Z0-9]{4,12}$/.test(m.deviceId)) {
    return { ok: false, code: 'MALFORMED', reason: 'Missing or malformed device id' };
  }

  // Direction policy: a peer may only send messages its role owns.
  if (expectedFrom !== undefined) {
    if (m.from !== expectedFrom) {
      return { ok: false, code: 'MALFORMED', reason: 'Sender role mismatch' };
    }
    if (!ALLOWED_SENDERS[type].includes(expectedFrom)) {
      return { ok: false, code: 'FORBIDDEN_TYPE', reason: `${expectedFrom} may not send ${type}` };
    }
  }

  if (m.payload !== undefined) {
    if (m.payload === null || typeof m.payload !== 'object' || Array.isArray(m.payload)) {
      return { ok: false, code: 'MALFORMED', reason: 'Payload must be an object' };
    }
    const sizeCheck = measurePayload(m.payload as Record<string, unknown>);
    if (sizeCheck > MAX_PAYLOAD_STRING) {
      return { ok: false, code: 'PAYLOAD_TOO_LARGE', reason: 'Payload exceeds the size cap' };
    }
  }
  if (m.req !== undefined && (typeof m.req !== 'string' || m.req.length > 64)) {
    return { ok: false, code: 'MALFORMED', reason: 'Invalid request id' };
  }

  return { ok: true, message: m as unknown as WireMessage };
}

/** Depth-limited payload walk that rejects deep nesting and giant
 * strings so hostile frames cannot exhaust memory during parse/scan.
 * The bound must clear legitimate tool-definition nesting (enums etc.),
 * while still capping pathological recursion well below call-stack
 * limits. */
const MAX_PAYLOAD_DEPTH = 16;

function measurePayload(payload: Record<string, unknown>, depth = 0): number {
  if (depth > MAX_PAYLOAD_DEPTH) return MAX_PAYLOAD_STRING + 1;
  let size = 0;
  for (const value of Object.values(payload)) {
    if (value === null || value === undefined) continue;
    const t = typeof value;
    if (t === 'string') {
      if ((value as string).length > MAX_PAYLOAD_STRING) return MAX_PAYLOAD_STRING + 1;
      size += (value as string).length;
    } else if (t === 'number' || t === 'boolean') {
      size += 8;
    } else if (t === 'object') {
      size += measurePayload(value as unknown as Record<string, unknown>, depth + 1);
    } else {
      return MAX_PAYLOAD_STRING + 1; // functions / symbols are not wire data
    }
    if (size > MAX_PAYLOAD_STRING) return size;
  }
  return size;
}

/** Frame-level guard: raw payload cap enforced before JSON.parse. */
export function frameWithinLimit(raw: Buffer | string): boolean {
  return raw.length <= MAX_FRAME_BYTES;
}

/**
 * Structural parse only — directional role policy is applied by the
 * connection layer via validateWireMessage(message, expectedFrom).
 */
export function parseFrame(raw: Buffer | string): ValidationResult {
  if (!frameWithinLimit(raw)) {
    return { ok: false, code: 'FRAME_TOO_LARGE', reason: `Frame exceeds ${MAX_FRAME_BYTES} bytes` };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw.toString());
  } catch {
    return { ok: false, code: 'MALFORMED_JSON', reason: 'Frame is not valid JSON' };
  }
  return validateWireMessage(decoded);
}

/**
 * Replay-protection ring: remembers recently seen message ids so a
 * captured frame cannot be replayed to double-execute an action.
 * Ids are dropped after REPLAY_WINDOW_MS; the ring is bounded.
 */
export class ReplayGuard {
  private seen = new Map<string, number>();
  private readonly maxEntries = 2000;
  private readonly windowMs: number;

  constructor(windowMs = REPLAY_WINDOW_MS, private now: () => number = Date.now) {
    this.windowMs = windowMs;
  }

  /** True when this message id was already seen (duplicate). */
  isDuplicate(id: string): boolean {
    this.evict(this.now());
    return this.seen.has(id);
  }

  /** Record a message id; returns false when it was already present. */
  record(id: string): boolean {
    const t = this.now();
    this.evict(t);
    if (this.seen.has(id)) return false;
    this.seen.set(id, t);
    if (this.seen.size > this.maxEntries) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this.seen.delete(oldest[0]);
    }
    return true;
  }

  private evict(now: number): void {
    for (const [id, t] of this.seen) {
      if (now - t > this.windowMs) this.seen.delete(id);
    }
  }

  size(): number {
    return this.seen.size;
  }
}

/** Validate a capability list from a peer (allowlist + dedupe). */
export function sanitizeCapabilities(raw: unknown): CapabilitySet {
  if (!Array.isArray(raw)) return [];
  const out: CapabilitySet = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (typeof c === 'string' && (KNOWN_CAPABILITY_SET as ReadonlySet<string>).has(c) && !seen.has(c)) {
      seen.add(c);
      out.push(c as CapabilitySet[number]);
    }
  }
  return out;
}

const KNOWN_CAPABILITY_SET = new Set<string>(KNOWN_CAPABILITIES);
