// BLAXIN registry-sync (client module) — deterministic tests
// =============================================================
// The management UI's registry mirror (client/src/utils/registry-sync.ts)
// is pure and dependency-free so the ordering guarantees B4 requires can
// be tested here from the server suite with the REAL module:
//
//   - a snapshot replaces local state and adopts its version
//   - an event older than the last applied version is stale and dropped
//   - newer events apply add/update/status/revoke/remove mutations
//   - non-registry frames (pings) never mutate state
//
// The Brain emits events with the registry's exact current version and
// snapshots are always current, so this guard closes the stale-overwrite
// window on the consumer side.
// =============================================================

import { describe, it, expect } from 'vitest';
import {
  emptyRegistryView,
  reconcileSnapshot,
  applyRegistryEvent,
  isRegistryEventType,
  type RegistryEvent,
} from '../client/src/utils/registry-sync.js';

const bodyA = {
  bodyId: 'BLX-BODY-A', name: 'Body A', capabilities: ['filesystem'],
  status: 'online', lastSeen: 100, pairedAt: 50,
};

function event(partial: Partial<RegistryEvent> & { type: string; version: number }): RegistryEvent {
  return { ...partial, bodyId: partial.bodyId ?? bodyA.bodyId };
}

describe('registry-sync (client module)', () => {
  it('starts empty and adopts an authoritative snapshot wholesale', () => {
    let v = emptyRegistryView();
    expect(v.version).toBe(0);
    expect(v.bodies).toHaveLength(0);

    v = reconcileSnapshot(v, {
      type: 'snapshot',
      version: 9,
      bodies: [{ ...bodyA, status: 'revoked' }],
    });
    expect(v.version).toBe(9);
    expect(v.bodies).toHaveLength(1);
    expect(v.bodies[0].status).toBe('revoked');
  });

  it('applies a newer body-added event and bumps the version', () => {
    let v = reconcileSnapshot(emptyRegistryView(), { type: 'snapshot', version: 1, bodies: [] });
    v = applyRegistryEvent(v, event({ type: 'body-added', version: 2, body: bodyA }));
    expect(v.version).toBe(2);
    expect(v.bodies.map((b) => b.bodyId)).toEqual(['BLX-BODY-A']);
  });

  it('upserts status / capabilities / revocation events for known bodies', () => {
    let v = reconcileSnapshot(emptyRegistryView(), {
      type: 'snapshot', version: 1,
      bodies: [{ ...bodyA, status: 'online', capabilities: ['filesystem'] }],
    });
    v = applyRegistryEvent(v, event({
      type: 'body-status', version: 2,
      body: { ...bodyA, status: 'offline' },
    }));
    expect(v.bodies[0].status).toBe('offline');

    v = applyRegistryEvent(v, event({
      type: 'body-capabilities-updated', version: 3,
      body: { ...bodyA, status: 'offline', capabilities: ['filesystem', 'terminal'] },
    }));
    expect(v.bodies[0].capabilities).toEqual(['filesystem', 'terminal']);

    v = applyRegistryEvent(v, event({
      type: 'body-revoked', version: 4,
      body: { ...bodyA, status: 'revoked', revokedAt: 200 },
    }));
    expect(v.bodies[0].status).toBe('revoked');
    expect(v.bodies[0].revokedAt).toBe(200);
  });

  it('body-removed deletes the record', () => {
    let v = reconcileSnapshot(emptyRegistryView(), {
      type: 'snapshot', version: 1, bodies: [bodyA],
    });
    v = applyRegistryEvent(v, event({ type: 'body-removed', version: 2, body: undefined as never }));
    expect(v.version).toBe(2);
    expect(v.bodies).toHaveLength(0);
  });

  it('DROPS a stale event (older than the last applied version) — the core ordering rule', () => {
    let v = reconcileSnapshot(emptyRegistryView(), {
      type: 'snapshot', version: 10,
      bodies: [{ ...bodyA, status: 'revoked' }],
    });
    // An older realtime event claims the body is CONNECTED again. It must
    // NOT regress the snapshot's REVOKED state.
    const before = v;
    v = applyRegistryEvent(v, event({
      type: 'body-status', version: 3,
      body: { ...bodyA, status: 'online' },
    }));
    expect(v).toBe(before); // unchanged object, unchanged state
    expect(v.bodies[0].status).toBe('revoked');
    expect(v.version).toBe(10);

    // Same version is also stale (a snapshot and an event at the same
    // version must never fight).
    v = applyRegistryEvent(v, event({
      type: 'body-status', version: 10,
      body: { ...bodyA, status: 'online' },
    }));
    expect(v.bodies[0].status).toBe('revoked');
  });

  it('events without a bodyId or without a body payload cannot mutate state', () => {
    let v = reconcileSnapshot(emptyRegistryView(), { type: 'snapshot', version: 1, bodies: [] });
    const before = v;
    v = applyRegistryEvent(v, { type: 'body-added', version: 2 });
    expect(v).toBe(before);
    v = applyRegistryEvent(v, { type: 'body-added', version: 3, bodyId: 'BLX-BODY-A' });
    expect(v).toBe(before);
  });

  it('only registry frames are treated as registry events (pings are ignored)', () => {
    expect(isRegistryEventType('snapshot')).toBe(true);
    expect(isRegistryEventType('body-added')).toBe(true);
    expect(isRegistryEventType('body-updated')).toBe(true);
    expect(isRegistryEventType('body-status')).toBe(true);
    expect(isRegistryEventType('body-revoked')).toBe(true);
    expect(isRegistryEventType('body-removed')).toBe(true);
    expect(isRegistryEventType('body-capabilities-updated')).toBe(true);
    expect(isRegistryEventType('ping')).toBe(false);
    expect(isRegistryEventType('pong')).toBe(false);
    expect(isRegistryEventType('')).toBe(false);
  });

  it('a reconnect flow: fresh snapshot wins over every older event seen before', () => {
    // Simulate the UI having received a few events, then losing the
    // channel and recovering from REST.
    let v = emptyRegistryView();
    v = applyRegistryEvent(v, event({ type: 'body-added', version: 1, body: bodyA }));
    v = applyRegistryEvent(v, event({
      type: 'body-status', version: 2,
      body: { ...bodyA, status: 'offline' },
    }));
    expect(v.version).toBe(2);

    // Recovery: the authoritative snapshot reflects the real current state
    // (revoked) — older events in flight afterwards are ignored.
    v = reconcileSnapshot(v, {
      type: 'snapshot', version: 5,
      bodies: [{ ...bodyA, status: 'revoked', revokedAt: 300 }],
    });
    expect(v.bodies[0].status).toBe('revoked');
    const after = v;
    v = applyRegistryEvent(v, event({
      type: 'body-status', version: 4,
      body: { ...bodyA, status: 'online' },
    }));
    expect(v).toBe(after);
    expect(v.bodies[0].status).toBe('revoked');
  });
});