// BLAXIN Body ↔ Brain transport (client side)
// =============================================================
// The BodyLink manages the persistent WebSocket connection from the
// Body to its Brain:
//   - secure connection (wss when the configured URL is wss — the
//     transport is NEVER silently downgraded to plaintext)
//   - exponential backoff with jitter on reconnect (no storms)
//   - application heartbeats both ways (missing frames → reconnect)
//   - frame validation + size caps on everything inbound
//   - honest connection states: DISCONNECTED / CONNECTING /
//     AUTHENTICATING / CONNECTED / DEGRADED / RECONNECTING / REVOKED /
//     INCOMPATIBLE / ERROR
//
// The link is transport-only: the protocol automaton (hello, pairing,
// auth) lives in remote-brain.ts on top of this class.
// =============================================================

import WebSocket, { RawData } from 'ws';
import { logger } from '../utils/logger.js';
import {
  ConnectionState, DeviceRole, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS,
  MAX_FRAME_BYTES, RECONNECT_BACKOFF_MS, WireMessage,
} from './types.js';
import { createMessage, parseFrame } from './protocol.js';
import { DeviceIdentity } from './identity.js';
import { CLOSE } from './handshake.js';
import { CapabilitySet } from './types.js';
import { validateBrainUrl } from './transport-policy.js';

export interface BodyLinkOptions {
  url: string;
  identity: DeviceIdentity;
  name?: string;
  capabilities: CapabilitySet;
  /** true to reconnect automatically after unexpected drops. */
  autoReconnect?: boolean;
  onStateChange?: (state: ConnectionState, detail?: { reason?: string; attempt?: number }) => void;
  /** Fired after the WebSocket opens (transport up, hello not sent yet). */
  onOpen?: () => void;
  /** Fired for every validated inbound frame. */
  onMessage?: (msg: WireMessage) => void;
  /** Fired when the transport closed for any reason. */
  onClosed?: (info: { code: number; reason: string; manual: boolean }) => void;
  /** PEM bundle of CA(s) that signed the Brain's TLS certificate. When
   * set, wss connections are validated against these roots (otherwise the
   * system roots are used). Never disable validation implicitly. */
  ca?: string;
  /** EXPLICIT development override: allows plaintext ws:// to non-loopback
   * addresses and skips TLS certificate verification. Never enabled by
   * default; every use is surfaced in state + logs. */
  allowInsecure?: boolean;
  now?: () => number;
  /** Heartbeat cadence overrides (tests / tuned deployments). Defaults to
   * the module constants; a peer that stays silent for `heartbeatTimeoutMs`
   * is marked DEGRADED and dropped. */
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

const BACKOFF_JITTER_RATIO = 0.25;
/** A connection that stays up this long resets the backoff counter. */
const STABILITY_MS = 30_000;
/** Frames allowed before the handshake completes (hostile-brain guard). */
const PRE_READY_MAX_FRAMES = 80;

/** Normalize a ws RawData payload into a Buffer for parsing. */
function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Heuristic: is a pre-open socket error a TLS certificate failure? A
 * certificate problem is configuration, not a transient network blip, so
 * the link must fail closed instead of reconnecting forever. */
export function looksLikeTlsFailure(message: string): boolean {
  const m = message.toLowerCase();
  const tokens = [
    'certificate', 'self-signed', 'unable to verify', 'issuer',
    'hostname', 'wrong hostname', 'cert has expired', 'not yet valid',
    'unknown ca', 'cert_', 'leaf signature', 'tls',
  ];
  return tokens.some((t) => m.includes(t));
}
/** Consecutive auth rejections before auto-reconnect gives up. */
const MAX_AUTH_RETRIES = 3;

export class BodyLink {
  readonly identity: DeviceIdentity;
  readonly url: string;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'DISCONNECTED';
  private readonly autoReconnect: boolean;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  private authFailureCount = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = 0;
  private framesPreReady = 0;
  private connectedAt = 0;
  private readonly now: () => number;
  private readonly capabilities: CapabilitySet;
  private readonly name: string;
  private readonly ca: string | undefined;
  private readonly allowInsecure: boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private everOpened = false;

  constructor(private readonly options: BodyLinkOptions) {
    this.url = options.url;
    this.identity = options.identity;
    this.capabilities = options.capabilities;
    this.name = options.name ?? 'Blaxin Body';
    this.autoReconnect = options.autoReconnect ?? true;
    this.ca = options.ca;
    this.allowInsecure = options.allowInsecure === true;
    this.now = options.now ?? Date.now;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.lastActivity = this.now();
  }

  getState(): ConnectionState {
    return this.state;
  }

  /** True when the link is connected at the transport level. */
  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Called by the protocol layer once the full handshake succeeded. */
  markConnected(): void {
    this.authFailureCount = 0;
    this.reconnectAttempt = 0;
    this.setState('CONNECTED');
  }

  /**
   * Pin the link to a TERMINAL state (REVOKED / INCOMPATIBLE) and close
   * the socket without auto-reconnect. The protocol layer calls this when
   * the Brain's hello declares the connection can never succeed — a
   * normal disconnect() would overwrite the terminal state.
   */
  failClosed(state: 'REVOKED' | 'INCOMPATIBLE', reason: string): void {
    this.manualClose = true; // never auto-reconnect from a terminal state
    this.clearReconnectTimer();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    try {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close(CLOSE.GOING_AWAY, reason.slice(0, 120));
      }
    } catch { /* ignore */ }
    this.setState(state, { reason });
  }

  /** Explicit connect (also used to retry after manual disconnect). */
  connect(): void {
    this.manualClose = false;
    this.openSocket();
  }

  /** Manual disconnect: no auto-reconnect afterwards. */
  disconnect(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    try {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close(CLOSE.GOING_AWAY, 'Manual disconnect');
      }
    } catch { /* ignore */ }
    this.setState('DISCONNECTED', { reason: 'manual disconnect' });
  }

  /** Send a frame (serialized under the size cap). */
  send(msg: WireMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const raw = JSON.stringify(msg);
    if (raw.length > MAX_FRAME_BYTES) {
      logger.error('link', `Refusing to send oversized frame (${raw.length} bytes)`);
      return false;
    }
    try {
      ws.send(raw);
      return true;
    } catch (error: any) {
      logger.error('link', `Send failed: ${error.message}`);
      return false;
    }
  }

  /** Send a frame authored as this Body. */
  sendAs(type: WireMessage['type'], payload?: Record<string, unknown>, req?: string): boolean {
    return this.send(createMessage('body', this.identity.id, type, payload, req));
  }

  // ── Internals ─────────────────────────────────────────────────

  private openSocket(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setState(this.reconnectAttempt > 0 ? 'RECONNECTING' : 'CONNECTING');

    // Transport policy gate: a non-loopback Brain must be reached over
    // wss (unless the operator explicitly opted into insecure dev mode).
    // Refusing here — before any bytes are sent — is what stops the
    // documented plaintext MITM attack surface.
    const verdict = validateBrainUrl(this.url, { allowInsecure: this.allowInsecure });
    if (!verdict.ok) {
      this.manualClose = true; // policy violation: never auto-retry a forbidden URL
      this.clearReconnectTimer();
      this.setState('ERROR', { reason: verdict.error });
      logger.warn('link', `Brain connection refused by transport policy: ${verdict.code}`);
      return;
    }
    if (this.allowInsecure) {
      logger.warn('link', 'Transport security override active (BLAXIN_BRAIN_ALLOW_INSECURE) — plaintext/insecure connections permitted for development');
    }

    let ws: WebSocket;
    try {
      const wsOptions: Record<string, unknown> = { perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES };
      if (this.ca) wsOptions.ca = this.ca;
      if (this.allowInsecure) wsOptions.rejectUnauthorized = false;
      ws = new WebSocket(this.url, wsOptions);
    } catch (error: any) {
      logger.error('link', `Failed to construct WebSocket to ${this.url}: ${error.message}`);
      this.scheduleReconnect('socket construction failed');
      return;
    }
    this.ws = ws;
    this.framesPreReady = 0;
    this.lastActivity = this.now();
    this.everOpened = false;

    ws.on('open', () => {
      this.everOpened = true;
      this.connectedAt = this.now();
      this.lastActivity = this.now();
      this.setState('AUTHENTICATING');
      this.startHeartbeat();
      this.options.onOpen?.();
    });

    ws.on('message', (data: RawData) => {
      this.lastActivity = this.now();
      this.handleInbound(toBuffer(data));
    });

    ws.on('close', (code, reason) => {
      this.teardownSocket();
      const manual = this.manualClose;
      const reasonText = reason.toString() || `closed (${code})`;
      this.options.onClosed?.({ code, reason: reasonText, manual });
      if (!manual && this.autoReconnect) {
        if (code === CLOSE.REVOKED) {
          this.setState('REVOKED', { reason: 'Device revoked by Brain' });
        } else if (code === CLOSE.INCOMPATIBLE) {
          this.setState('INCOMPATIBLE', { reason: reasonText });
        } else if (code === CLOSE.AUTH_FAILED || code === CLOSE.POLICY) {
          // Authentication / pairing rejections are NOT transient: the
          // pairing is broken or the body was unpaired. Stop hammering
          // the Brain and surface an honest ERROR after a few attempts.
          this.authFailureCount++;
          if (this.authFailureCount >= MAX_AUTH_RETRIES) {
            this.setState('ERROR', { reason: 'The Brain rejected this Body. Re-pair to continue.' });
          } else {
            this.scheduleReconnect(`authentication rejected (${code})`);
          }
        } else {
          this.scheduleReconnect(reasonText);
        }
      } else if (!manual) {
        this.setState('ERROR', { reason: reasonText });
      }
    });

    ws.on('error', (error) => {
      logger.warn('link', `Socket error: ${error.message}`);
      // A TLS certificate failure is a CONFIGURATION problem, not a
      // transient network blip: hammering the Brain with reconnects would
      // hide the real cause. Fail closed with guidance instead.
      if (!this.everOpened && looksLikeTlsFailure(error.message || String(error))) {
        this.manualClose = true;
        this.clearReconnectTimer();
        this.setState('ERROR', {
          reason: `TLS certificate verification failed: ${error.message}. Check the Brain certificate, or provide its CA with BLAXIN_BRAIN_CA_FILE (development escape hatch: BLAXIN_BRAIN_ALLOW_INSECURE=1).`,
        });
      }
      // Otherwise 'close' follows and drives the reconnect logic.
    });
  }

  private handleInbound(data: Buffer): void {

    const parsed = parseFrame(data);
    if (!parsed.ok) {
      logger.warn('link', `Dropping invalid frame from Brain: ${parsed.reason}`);
      // Fail closed on a peer that sends garbage or oversized frames.
      if (parsed.code === 'FRAME_TOO_LARGE' || parsed.code === 'MALFORMED_JSON') {
        this.terminate(CLOSE.POLICY, parsed.reason);
      }
      return;
    }
    const msg = parsed.message;

    // Transport-level frames are handled here.
    if (msg.type === 'ping') {
      this.sendAs('pong', { at: this.now() }, msg.id);
      return;
    }
    if (msg.type === 'pong') return;

    // Heartbeat also applies during the handshake: any inbound frame
    // refreshes lastActivity, so a silent brain is detected even while
    // AUTHENTICATING.
    if (this.state !== 'CONNECTED') {
      this.framesPreReady++;
      if (this.framesPreReady > PRE_READY_MAX_FRAMES) {
        this.terminate(CLOSE.RATE_LIMITED, 'Too many frames before ready');
        return;
      }
    }
    this.options.onMessage?.(msg);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const now = this.now();
      if (now - this.lastActivity > this.heartbeatTimeoutMs) {
        logger.warn('link', 'Heartbeat timeout — no frames from Brain');
        this.setState('DEGRADED', { reason: 'heartbeat timeout' });
        this.terminate(CLOSE.POLICY, 'Heartbeat timeout');
        return;
      }
      if (this.isOpen()) {
        this.sendAs('ping', { at: now });
      }
    }, this.heartbeatIntervalMs);
  }

  private terminate(code: number, reason: string): void {
    try {
      if (this.ws) this.ws.close(code, reason.slice(0, 120));
    } catch { /* ignore */ }
  }

  private teardownSocket(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws = null;
  }

  private scheduleReconnect(reason: string): void {
    if (this.manualClose) return;
    this.clearReconnectTimer();
    // A connection that stayed up long enough resets the backoff counter,
    // so a single blip after a long session reconnects quickly instead of
    // starting from the maximum delay.
    if (this.connectedAt > 0 && this.now() - this.connectedAt > STABILITY_MS) {
      this.reconnectAttempt = 0;
    }
    const attempt = this.reconnectAttempt;
    const base = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
    // Full jitter spread around the base (never zero).
    const jitter = base * BACKOFF_JITTER_RATIO;
    const delay = Math.max(500, Math.round(base - jitter + Math.random() * jitter * 2));
    this.setState('RECONNECTING', { reason, attempt: attempt + 1 });
    logger.warn('link', `Reconnecting to Brain in ${delay}ms (attempt ${attempt + 1}): ${reason}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt++;
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: ConnectionState, detail?: { reason?: string; attempt?: number }): void {
    if (this.state === state && !detail) return;
    this.state = state;
    this.options.onStateChange?.(state, detail);
  }
}
