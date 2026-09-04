// BLAXIN brain device registry
// =============================================================
// The Brain keeps a persistent registry of the Bodies it has paired
// with (one Brain → many Bodies). Records hold the body's public
// identity, capabilities and status. Revoked bodies are permanently
// rejected — a revoked device must not reconnect with old credentials.
//
// The registry stores public keys only (no secrets). It is written
// atomically (tmp + rename) and a corrupt file never crashes the brain.
// =============================================================

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { RegisteredBody, DeviceId, CapabilitySet } from './types.js';
import { logger } from '../utils/logger.js';

export interface DeviceRegistryOptions {
  filePath: string;
  now?: () => number;
}

export class DeviceRegistry {
  private bodies = new Map<DeviceId, RegisteredBody>();
  private readonly filePath: string;
  private readonly now: () => number;

  constructor(options: DeviceRegistryOptions) {
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
    this.load();
  }

  /** Register (or refresh) a paired body after a successful pairing. */
  registerPair(
    bodyId: DeviceId,
    info: {
      name: string;
      publicKey: string;
      capabilities: CapabilitySet;
      protocolMin: number;
      protocolMax: number;
    },
  ): void {
    const existing = this.bodies.get(bodyId);
    // Re-pairing an existing (non-revoked) body updates its key/caps.
    this.bodies.set(bodyId, {
      bodyId,
      name: info.name,
      publicKey: info.publicKey,
      capabilities: info.capabilities,
      protocolMin: info.protocolMin,
      protocolMax: info.protocolMax,
      status: 'online',
      lastSeen: this.now(),
      pairedAt: existing?.pairedAt ?? this.now(),
      sessionId: existing?.sessionId,
    });
    this.save();
  }

  get(bodyId: DeviceId): RegisteredBody | undefined {
    return this.bodies.get(bodyId);
  }

  list(): RegisteredBody[] {
    return [...this.bodies.values()].sort((a, b) => b.pairedAt - a.pairedAt);
  }

  /** Mark a body online with a fresh lastSeen (heartbeat / connect). */
  markOnline(bodyId: DeviceId, sessionId: string): void {
    const b = this.bodies.get(bodyId);
    if (!b || b.status === 'revoked') return;
    b.status = 'online';
    b.lastSeen = this.now();
    b.sessionId = sessionId;
    this.save();
  }

  markOffline(bodyId: DeviceId): void {
    const b = this.bodies.get(bodyId);
    if (!b) return;
    // A revoked device stays revoked: the disconnect that follows a
    // revocation must never resurrect it as a plain offline device
    // (that would let it reconnect with its old credentials).
    if (b.status === 'revoked') {
      b.lastSeen = this.now();
      this.save();
      return;
    }
    b.status = 'offline';
    b.lastSeen = this.now();
    b.sessionId = undefined;
    this.save();
  }

  markRevoked(bodyId: DeviceId): boolean {
    const b = this.bodies.get(bodyId);
    if (!b) return false;
    b.status = 'revoked';
    b.revokedAt = this.now();
    b.sessionId = undefined;
    this.save();
    return true;
  }

  /** Remove a device record entirely (forget/unpair). */
  remove(bodyId: DeviceId): boolean {
    const removed = this.bodies.delete(bodyId);
    if (removed) this.save();
    return removed;
  }

  isRevoked(bodyId: DeviceId): boolean {
    return this.bodies.get(bodyId)?.status === 'revoked';
  }

  /** Track the active task / ack watermark for reconnect reconciliation. */
  updateActivity(bodyId: DeviceId, fields: { activeTaskId?: string; lastAckedActionId?: string }): void {
    const b = this.bodies.get(bodyId);
    if (!b || b.status === 'revoked') return;
    if (fields.activeTaskId !== undefined) b.activeTaskId = fields.activeTaskId;
    if (fields.lastAckedActionId !== undefined) b.lastAckedActionId = fields.lastAckedActionId;
    b.lastSeen = this.now();
    this.save();
  }

  // ── Persistence ──────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      if (!Array.isArray(parsed)) return;
      for (const raw of parsed) {
        const r = raw as Partial<RegisteredBody>;
        if (
          typeof r.bodyId === 'string' && /^BLX-BODY-[A-Z0-9]{4,12}$/.test(r.bodyId) &&
          typeof r.publicKey === 'string' && r.publicKey.length > 0 &&
          Array.isArray(r.capabilities) &&
          (r.status === 'online' || r.status === 'offline' || r.status === 'revoked')
        ) {
          this.bodies.set(r.bodyId, {
            bodyId: r.bodyId,
            name: typeof r.name === 'string' ? r.name : r.bodyId,
            publicKey: r.publicKey,
            capabilities: r.capabilities as CapabilitySet,
            protocolMin: typeof r.protocolMin === 'number' ? r.protocolMin : 1,
            protocolMax: typeof r.protocolMax === 'number' ? r.protocolMax : 1,
            status: r.status,
            lastSeen: typeof r.lastSeen === 'number' ? r.lastSeen : 0,
            pairedAt: typeof r.pairedAt === 'number' ? r.pairedAt : 0,
            revokedAt: r.revokedAt,
            sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined,
            activeTaskId: typeof r.activeTaskId === 'string' ? r.activeTaskId : undefined,
            lastAckedActionId: typeof r.lastAckedActionId === 'string' ? r.lastAckedActionId : undefined,
          });
        }
      }
    } catch (error: any) {
      logger.warn('brain', `Device registry unreadable (${error.message}); starting empty`);
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = join(dirname(this.filePath), `.devices.${process.pid}.${Date.now()}.tmp`);
      writeFileSync(tmp, JSON.stringify(this.list(), null, 2), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (error: any) {
      logger.error('brain', `Failed to persist device registry: ${error.message}`);
    }
  }
}
