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
  now?: () => number;
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

  constructor(private readonly options: BodyLinkOptions) {
    this.url = options.url;
    this.identity = options.identity;
    this.capabilities = options.capabilities;
    this.name = options.name ?? 'Blaxin Body';
    this.autoReconnect = options.autoReconnect ?? true;
    this.now = options.now ?? Date.now;
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

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });
    } catch (error: any) {
      logger.error('link', `Failed to construct WebSocket to ${this.url}: ${error.message}`);
      this.scheduleReconnect('socket construction failed');
      return;
    }
    this.ws = ws;
    this.framesPreReady = 0;
    this.lastActivity = this.now();

    ws.on('open', () => {
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
      // 'close' follows and drives the reconnect logic.
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
      if (now - this.lastActivity > HEARTBEAT_TIMEOUT_MS) {
        logger.warn('link', 'Heartbeat timeout — no frames from Brain');
        this.setState('DEGRADED', { reason: 'heartbeat timeout' });
        this.terminate(CLOSE.POLICY, 'Heartbeat timeout');
        return;
      }
      if (this.isOpen()) {
        this.sendAs('ping', { at: now });
      }
    }, HEARTBEAT_INTERVAL_MS);
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
