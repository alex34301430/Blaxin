// BLAXIN connection authentication
// =============================================================
// After pairing, both sides hold each other's Ed25519 public keys.
// Every connection re-authenticates BIDIRECTIONALLY with fresh
// challenges: each side proves possession of its private key by
// signing the peer's random challenge (+ both device ids to bind the
// signature to this specific connection).
//
// The pairing code is never the permanent credential — these
// signatures are. A revoked device fails here because its public key
// was removed from the registry.
// =============================================================

import { signData, verifySignature } from './identity.js';
import { DeviceId, DeviceRole } from './types.js';

/** The exact string a responder signs (binds both device ids). */
export function challengeData(challengerId: DeviceId, responderId: DeviceId, challenge: string): string {
  return `${challengerId}|${responderId}|${challenge}`;
}

export function buildAuthSignature(
  secretKeyB64: string,
  challengerId: DeviceId,
  ownId: DeviceId,
  challenge: string,
): string {
  return signData(secretKeyB64, challengeData(challengerId, ownId, challenge));
}

export function verifyAuthSignature(
  peerPublicKeyB64: string,
  challengerId: DeviceId,
  responderId: DeviceId,
  challenge: string,
  signature: string,
): boolean {
  return verifySignature(peerPublicKeyB64, challengeData(challengerId, responderId, challenge), signature);
}

/** WebSocket close codes for the Brain↔Body transport. */
export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  POLICY: 1008,
  MALFORMED: 4400,
  AUTH_FAILED: 4401,
  FORBIDDEN_TYPE: 4403,
  INCOMPATIBLE: 4404,
  PAYLOAD_TOO_LARGE: 4413,
  REVOKED: 4418,
  RATE_LIMITED: 4429,
} as const;

export interface RoleContext {
  role: DeviceRole;
  id: DeviceId;
}
