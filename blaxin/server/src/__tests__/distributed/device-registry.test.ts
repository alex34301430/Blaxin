import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DeviceRegistry } from '../../distributed/device-registry.js';
import type { CapabilitySet } from '../../distributed/types.js';

function makeRegistry(dir: string) {
  return new DeviceRegistry({ filePath: join(dir, 'devices.json') });
}

const bodyInfo = {
  name: 'Test Body',
  publicKey: 'UHVibGljS2V5'.padEnd(44, 'A'),
  capabilities: ['filesystem', 'terminal'] as CapabilitySet,
  protocolMin: 1,
  protocolMax: 1,
};

describe('device registry', () => {
  it('registers, lists and reports bodies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blaxin-reg-'));
    try {
      const reg = makeRegistry(dir);
      reg.registerPair('BLX-BODY-8F2A', bodyInfo);
      expect(reg.get('BLX-BODY-8F2A')?.status).toBe('online');
      expect(reg.list()).toHaveLength(1);

      reg.markRevoked('BLX-BODY-8F2A');
      expect(reg.isRevoked('BLX-BODY-8F2A')).toBe(true);
      expect(reg.get('BLX-BODY-8F2A')?.revokedAt).toBeGreaterThan(0);

      expect(reg.remove('BLX-BODY-8F2A')).toBe(true);
      expect(reg.list()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never resurrects a revoked device via markOffline (disconnect handling)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blaxin-reg-'));
    try {
      const reg = makeRegistry(dir);
      reg.registerPair('BLX-BODY-8F2A', bodyInfo);
      reg.markRevoked('BLX-BODY-8F2A');
      // The disconnect that follows a revocation must NOT un-revoke it.
      reg.markOffline('BLX-BODY-8F2A');
      expect(reg.isRevoked('BLX-BODY-8F2A')).toBe(true);
      expect(reg.get('BLX-BODY-8F2A')?.status).toBe('revoked');
      // markOnline has the same guard.
      reg.markOnline('BLX-BODY-8F2A', 'sess');
      expect(reg.get('BLX-BODY-8F2A')?.status).toBe('revoked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists across instances and rejects revoked reconnects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blaxin-reg-'));
    try {
      const reg = makeRegistry(dir);
      reg.registerPair('BLX-BODY-8F2A', bodyInfo);
      reg.markOffline('BLX-BODY-8F2A');

      // A second instance over the same file sees the persisted body.
      const reloaded = makeRegistry(dir);
      expect(reloaded.get('BLX-BODY-8F2A')?.status).toBe('offline');
      expect(reloaded.get('BLX-BODY-8F2A')?.publicKey).toBe(bodyInfo.publicKey);

      reloaded.markRevoked('BLX-BODY-8F2A');
      const third = makeRegistry(dir);
      expect(third.isRevoked('BLX-BODY-8F2A')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives a corrupt registry file by starting empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blaxin-reg-'));
    try {
      writeFileSync(join(dir, 'devices.json'), '{corrupt!!');
      const reg = makeRegistry(dir);
      expect(reg.list()).toHaveLength(0);
      reg.registerPair('BLX-BODY-8F2A', bodyInfo); // still writable
      expect(reg.get('BLX-BODY-8F2A')).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores malformed records during load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blaxin-reg-'));
    try {
      writeFileSync(join(dir, 'devices.json'), JSON.stringify([
        bodyInfo, // missing bodyId field → dropped
        { bodyId: 'BLX-BODY-1234', publicKey: 'x'.repeat(40), capabilities: [], status: 'online', lastSeen: 1, pairedAt: 1 },
      ]));
      const reg = makeRegistry(dir);
      expect(reg.list()).toHaveLength(1);
      expect(reg.get('BLX-BODY-1234')).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bumps a monotonic version on every mutation and persists it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blaxin-reg-'));
    try {
      const reg = makeRegistry(dir);
      const v0 = reg.getVersion();
      reg.registerPair('BLX-BODY-8F2A', bodyInfo);
      const v1 = reg.getVersion();
      expect(v1).toBeGreaterThan(v0);
      reg.markOffline('BLX-BODY-8F2A');
      const v2 = reg.getVersion();
      expect(v2).toBeGreaterThan(v1);
      reg.markOnline('BLX-BODY-8F2A', 'sess');
      const v3 = reg.getVersion();
      expect(v3).toBeGreaterThan(v2);
      reg.markRevoked('BLX-BODY-8F2A');
      const v4 = reg.getVersion();
      expect(v4).toBeGreaterThan(v3);

      // Version survives a reload (persisted with the records).
      const reloaded = makeRegistry(dir);
      expect(reloaded.getVersion()).toBe(v4);
      expect(reloaded.isRevoked('BLX-BODY-8F2A')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not bump the version for task bookkeeping (no heartbeat noise)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blaxin-reg-'));
    try {
      const reg = makeRegistry(dir);
      reg.registerPair('BLX-BODY-8F2A', bodyInfo);
      const v = reg.getVersion();
      reg.updateActivity('BLX-BODY-8F2A', { activeTaskId: 'task-1', lastAckedActionId: 'act-1' });
      expect(reg.getVersion()).toBe(v);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads the legacy bare-array format and the versioned format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blaxin-reg-'));
    try {
      // Legacy (Phase A) format: bare array — loads with version 0.
      writeFileSync(join(dir, 'legacy.json'), JSON.stringify([
        { bodyId: 'BLX-BODY-1234', name: 'Legacy', publicKey: 'x'.repeat(40), capabilities: [], protocolMin: 1, protocolMax: 1, status: 'offline', lastSeen: 1, pairedAt: 1 },
      ]));
      const legacy = new DeviceRegistry({ filePath: join(dir, 'legacy.json') });
      expect(legacy.list()).toHaveLength(1);
      expect(legacy.getVersion()).toBe(0);

      // Current format: { version, devices }.
      writeFileSync(join(dir, 'current.json'), JSON.stringify({
        version: 7,
        devices: [
          { bodyId: 'BLX-BODY-5678', name: 'Current', publicKey: 'y'.repeat(40), capabilities: ['terminal'], protocolMin: 1, protocolMax: 1, status: 'revoked', lastSeen: 2, pairedAt: 2, revokedAt: 3 },
        ],
      }));
      const current = new DeviceRegistry({ filePath: join(dir, 'current.json') });
      expect(current.getVersion()).toBe(7);
      expect(current.isRevoked('BLX-BODY-5678')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registering the same body id twice keeps a single record (no duplicates)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blaxin-reg-'));
    try {
      const reg = makeRegistry(dir);
      reg.registerPair('BLX-BODY-8F2A', bodyInfo);
      reg.registerPair('BLX-BODY-8F2A', { ...bodyInfo, name: 'Renamed Body' });
      expect(reg.list()).toHaveLength(1);
      expect(reg.get('BLX-BODY-8F2A')?.name).toBe('Renamed Body');
      expect(reg.get('BLX-BODY-8F2A')?.pairedAt).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
