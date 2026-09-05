// BLAXIN registry realtime synchronization (management UI)
// =============================================================
// The Brain's device registry is the SINGLE SOURCE OF TRUTH. The UI is a
// thin mirror: it takes an authoritative REST snapshot (GET /devices) and
// applies realtime events (Brain admin WebSocket) on top, guarded by the
// registry's monotonic version.
//
// Ordering rule (prevents stale events from overwriting newer state):
//   - a snapshot REPLACES local state and adopts the snapshot version
//   - an event is applied ONLY when its version is strictly greater than
//     the last applied version; otherwise it is stale and dropped
//
// This module is pure and dependency-free so it can be tested
// deterministically from the server suite (see server/registry-sync.test.ts).
// =============================================================

export type RegistryBodyStatus = 'online' | 'offline' | 'revoked';

export interface RegistryBody {
  bodyId: string;
  name: string;
  capabilities: string[];
  protocol?: { min: number; max: number };
  status: RegistryBodyStatus | string;
  lastSeen?: number | null;
  pairedAt?: number | null;
  revokedAt?: number | null;
}

export type RegistryEventType =
  | 'snapshot'
  | 'body-added'
  | 'body-updated'
  | 'body-status'
  | 'body-revoked'
  | 'body-removed'
  | 'body-capabilities-updated';

export interface RegistryEvent {
  type: string;
  version: number;
  bodyId?: string;
  body?: RegistryBody | null;
  bodies?: RegistryBody[];
}

export interface RegistryView {
  version: number;
  bodies: RegistryBody[];
}

export function emptyRegistryView(): RegistryView {
  return { version: 0, bodies: [] };
}

/** Replace local state with the authoritative REST snapshot. */
export function reconcileSnapshot(_current: RegistryView, snapshot: RegistryEvent): RegistryView {
  return {
    version: typeof snapshot.version === 'number' ? snapshot.version : 0,
    bodies: Array.isArray(snapshot.bodies) ? [...snapshot.bodies] : [],
  };
}

const UPSERT_EVENTS = new Set<string>([
  'body-added',
  'body-updated',
  'body-status',
  'body-revoked',
  'body-capabilities-updated',
]);

/**
 * Apply one realtime registry event. Events with a version ≤ the last
 * applied version are stale (older than the current snapshot/event) and
 * are dropped — they must never regress newer state.
 */
export function applyRegistryEvent(current: RegistryView, event: RegistryEvent): RegistryView {
  const version = typeof event.version === 'number' ? event.version : 0;
  if (version <= current.version) return current;
  if (!event.bodyId) return current;

  if (UPSERT_EVENTS.has(event.type) && event.body) {
    return upsertBody(current, event.body, version);
  }
  if (event.type === 'body-removed') {
    return {
      version,
      bodies: current.bodies.filter((b) => b.bodyId !== event.bodyId),
    };
  }
  return current;
}

function upsertBody(current: RegistryView, body: RegistryBody, version: number): RegistryView {
  const next = [...current.bodies];
  const idx = next.findIndex((b) => b.bodyId === body.bodyId);
  if (idx === -1) {
    next.push(body);
  } else {
    next[idx] = body;
  }
  return { version, bodies: next };
}

/** True when this event type mutates registry state (vs ping/keepalive). */
export function isRegistryEventType(type: string): boolean {
  return type === 'snapshot' || UPSERT_EVENTS.has(type) || type === 'body-removed';
}