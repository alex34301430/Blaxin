// BLAXIN Brain runtime
// =============================================================
// A standalone process that is the fixed external intelligence for one
// or more BLAXIN Bodies. The Brain:
//   - listens for Body connections on a WebSocket endpoint
//   - runs one-time pairing to establish trust
//   - authenticates every connection bidirectionally (Ed25519
//     challenge/response against the device registry)
//   - negotiates the protocol version
//   - accepts task_start from a Body and drives the task through a
//     BrainTaskDriver, requesting structured actions that the Body
//     executes under its own policy
//   - keeps a persistent device registry (one Brain → many Bodies)
//   - exposes /health /version /protocol /capabilities and loopback
//     pairing/device-management HTTP endpoints
//
// The Brain never executes tools itself; it only requests them.
// =============================================================

import express from 'express';
import cors from 'cors';
import { createServer as createHttpServer, Server as HttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import { corsOriginValidator, isOriginAllowed, getAllowedOriginsFromEnv } from '../utils/security.js';
import { APP_VERSION } from '../utils/version.js';
import {
  ActionResult, CapabilitySet, ConnectionState, DeviceId, DeviceRole,
  DEVICE_ROLE_BODY, PROTOCOL_MAX_SUPPORTED, PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION, TaskActionRequest, TaskUpdatePayload, WireMessage,
} from './types.js';
import { createMessage, negotiateProtocol, parseFrame, sanitizeCapabilities, validateWireMessage, ReplayGuard, clampInt } from './protocol.js';
import { DeviceIdentity, loadOrCreateIdentity, randomChallenge, verifySignature, signData } from './identity.js';
import { CLOSE, buildAuthSignature, verifyAuthSignature } from './handshake.js';
import { PairingManager } from './pairing.js';
import { DeviceRegistry } from './device-registry.js';
import { BrainTaskDriver } from './brain-drivers.js';
import { hasCapability, toolAllowedByCapabilities } from './capabilities.js';
import type { ToolDefinition, ToolCall } from '../types.js';

// ── Options ─────────────────────────────────────────────────────

export interface BrainRuntimeOptions {
  host?: string;
  port?: number;
  /** PEM key + certificate pair. When provided the Brain serves WSS (TLS)
   * only — plaintext is never offered on a TLS-configured port and the
   * transport can never silently downgrade. Certificate files are read by
   * the caller (brain-main loads BLAXIN_BRAIN_TLS_KEY/CERT). */
  tls?: { key: string; cert: string };
  /** Server identity (defaults to a persisted brain identity in the data dir). */
  identity?: DeviceIdentity;
  registry?: DeviceRegistry;
  pairing?: PairingManager;
  drivers?: Map<string, BrainTaskDriver>;
  defaultDriverId?: string;
  /** Extra browser origins allowed to reach the brain control plane. */
  extraAllowedOrigins?: string[];
  /** Optional AI model control plane (the Brain owns the providers). When
   * provided, the runtime exposes admin-gated /ai/status + /ai/select.
   * Kept injectable so the runtime stays provider-agnostic. */
  aiControl?: BrainAIHandle;
  now?: () => number;
  /** Human name of this brain (default: os hostname). */
  name?: string;
  identityFile?: string;
  registryFile?: string;
}

/** Minimal provider-control surface a Brain process can expose. The
 * Brain (not the Body) owns provider credentials; this lets an operator
 * inspect/select the active model on a standalone Brain. */
export interface BrainAIHandle {
  status(): {
    activeProvider: string | null;
    activeModel: string | null;
    providers: Array<{
      id: string;
      name: string;
      apiKeyRequired: boolean;
      hasKey: boolean;
      healthy: boolean;
    }>;
  };
  select(providerId: string, modelId?: string): { ok: boolean; error?: string };
}

const HELLO_TIMEOUT_MS = 15_000;
const AUTH_TIMEOUT_MS = 15_000;
const PRE_AUTH_MAX_FRAMES = 60;
const CONNECTION_ATTEMPT_WINDOW_MS = 60_000;
const CONNECTION_ATTEMPT_LIMIT = 25;

interface PendingAction {
  taskId: string;
  actionId: string;
  resolve: (r: ActionResult) => void;
}

interface TaskSession {
  taskId: string;
  text: string;
  driverId: string;
  state: string;
  description?: string;
  startTime: number;
  active: boolean;
  outcome?: { kind: 'completed'; summary: string } | { kind: 'failed'; error: string; code?: string };
}

/** Server-side view of one connected Body. */
interface PeerState {
  connectionState: ConnectionState;
  bodyId: DeviceId | null;
  bodyName: string;
  capabilities: CapabilitySet;
  tools: ToolDefinition[];
  protocol: number;
  ws: WebSocket;
  phase: 'hello' | 'pairing' | 'auth-body' | 'auth-brain' | 'ready';
  sessionId: string;
  pendingChallenge: string | null;
  framesReceived: number;
  /** Sliding window of frame timestamps for the rate guard. */
  frameWindow: number[];
  lastActivity: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  phaseTimer: ReturnType<typeof setTimeout> | null;
}

export class BrainRuntime {
  readonly role: DeviceRole = 'brain';
  identity: DeviceIdentity;
  readonly registry: DeviceRegistry;
  readonly pairing: PairingManager;
  readonly drivers: Map<string, BrainTaskDriver>;
  readonly defaultDriverId: string;
  readonly host: string;
  readonly port: number;
  readonly now: () => number;
  readonly brainName: string;
  readonly aiControl: BrainAIHandle | undefined;
  readonly tlsConfig: { key: string; cert: string } | undefined;

  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private expressApp: express.Express | null = null;
  private peers = new Map<DeviceId, PeerState>();
  private readonly pendingActions = new Map<string, PendingAction>();
  private readonly activeTasks = new Map<DeviceId, TaskSession>();
  private readonly replay = new ReplayGuard();
  private readonly knownTaskIds = new Map<string, number>(); // completed/failed task ids (bounded)
  private attemptLog = new Map<string, number[]>();
  private started = false;
  private stopping = false;

  constructor(options: BrainRuntimeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.host = (options.host ?? process.env.BLAXIN_BRAIN_HOST) || '127.0.0.1';
    this.port = options.port ?? parseInt(process.env.BLAXIN_BRAIN_PORT || '3100', 10);
    this.brainName = (options.name ?? process.env.BLAXIN_BRAIN_NAME) || 'Blaxin Brain';
    this.aiControl = options.aiControl;
    this.tlsConfig = options.tls;

    const dataDir = process.env.BLAXIN_DATA_DIR || '.';
    this.identity = options.identity ?? loadOrCreateIdentity({
      filePath: options.identityFile ?? `${dataDir}/brain-identity.json`,
      role: 'brain',
      name: this.brainName,
      now: this.now,
    });
    this.registry = options.registry ?? new DeviceRegistry({
      filePath: options.registryFile ?? `${dataDir}/.blaxin-state/brain-devices.json`,
      now: this.now,
    });
    this.pairing = options.pairing ?? new PairingManager({ now: this.now });
    this.drivers = options.drivers ?? new Map();
    this.defaultDriverId = (options.defaultDriverId ?? process.env.BLAXIN_BRAIN_DEFAULT_DRIVER) || 'llm';
  }

  // ── HTTP surface ──────────────────────────────────────────────

  private buildHttp(): express.Express {
    const extra = this.optionsExtraOrigins();
    const app = express();
    app.use(cors({ origin: corsOriginValidator(extra) }));
    app.use(express.json({ limit: '256kb' }));

    app.get('/health', (_req, res) => {
      res.json(this.healthPayload());
    });

    app.get('/version', (_req, res) => {
      res.json({ name: 'blaxin-brain', version: APP_VERSION, brainId: this.identity.id });
    });

    app.get('/protocol', (_req, res) => {
      res.json({
        version: PROTOCOL_VERSION,
        minSupported: PROTOCOL_MIN_SUPPORTED,
        maxSupported: PROTOCOL_MAX_SUPPORTED,
      });
    });

    app.get('/capabilities', (_req, res) => {
      // Brain-level service capabilities (reasoning only — execution
      // capabilities live on the connected Bodies).
      res.json({
        role: 'brain',
        services: ['reasoning', 'planning', 'model-routing', 'memory'],
        protocol: PROTOCOL_VERSION,
      });
    });

    app.get('/pairing', (_req, res) => {
      const current = this.pairing.current();
      if (!current) {
        return res.status(404).json({ error: 'No pairing code active', code: 'NO_CODE' });
      }
      res.json({ ...current, brainId: this.identity.id });
    });

    app.post('/pairing/start', (req, res) => {
      if (!this.allowAdminRequest(req)) {
        return res.status(403).json({ error: 'Forbidden', code: 'ADMIN_RESTRICTED' });
      }
      const generated = this.pairing.generate();
      logger.info('brain', `Pairing code generated (expires in ${Math.round(generated.expiresInMs / 1000)}s)`);
      res.json({
        brainId: this.identity.id,
        code: generated.formatted,
        expiresInSec: Math.round(generated.expiresInMs / 1000),
      });
    });

    app.post('/pairing/cancel', (req, res) => {
      if (!this.allowAdminRequest(req)) {
        return res.status(403).json({ error: 'Forbidden', code: 'ADMIN_RESTRICTED' });
      }
      this.pairing.invalidate();
      res.json({ success: true });
    });

    app.get('/devices', (req, res) => {
      if (!this.allowAdminRequest(req)) {
        return res.status(403).json({ error: 'Forbidden', code: 'ADMIN_RESTRICTED' });
      }
      const online = new Set(this.peers.keys());
      res.json({
        devices: this.registry.list().map((d) => ({
          bodyId: d.bodyId,
          name: d.name,
          capabilities: d.capabilities,
          protocol: { min: d.protocolMin, max: d.protocolMax },
          status: online.has(d.bodyId) ? 'online' : d.status,
          lastSeen: d.lastSeen,
          pairedAt: d.pairedAt,
          revokedAt: d.revokedAt,
        })),
      });
    });

    app.post('/devices/:id/revoke', (req, res) => {
      if (!this.allowAdminRequest(req)) {
        return res.status(403).json({ error: 'Forbidden', code: 'ADMIN_RESTRICTED' });
      }
      const bodyId = String(req.params.id || '').toUpperCase();
      const revoked = this.registry.markRevoked(bodyId);
      if (!revoked) return res.status(404).json({ error: 'Unknown device', code: 'NOT_FOUND' });
      this.disconnectBody(bodyId, CLOSE.REVOKED, 'Device revoked');
      logger.warn('brain', `Device revoked: ${bodyId}`);
      res.json({ success: true, bodyId });
    });

    app.delete('/devices/:id', (req, res) => {
      if (!this.allowAdminRequest(req)) {
        return res.status(403).json({ error: 'Forbidden', code: 'ADMIN_RESTRICTED' });
      }
      const bodyId = String(req.params.id || '').toUpperCase();
      const removed = this.registry.remove(bodyId);
      if (!removed) return res.status(404).json({ error: 'Unknown device', code: 'NOT_FOUND' });
      this.disconnectBody(bodyId, CLOSE.POLICY, 'Device removed');
      res.json({ success: true, bodyId });
    });

    // AI model control plane — only present when a provider handle is
    // attached (the standalone Brain owns the providers). The Body must
    // never reach these; they are admin-gated like /pairing and /devices.
    if (this.aiControl) {
      app.get('/ai/status', (req, res) => {
        if (!this.allowAdminRequest(req)) {
          return res.status(403).json({ error: 'Forbidden', code: 'ADMIN_RESTRICTED' });
        }
        res.json({
          ...this.aiControl!.status(),
          drivers: [...this.drivers.keys()],
          defaultDriver: this.defaultDriverId,
        });
      });

      app.post('/ai/select', (req, res) => {
        if (!this.allowAdminRequest(req)) {
          return res.status(403).json({ error: 'Forbidden', code: 'ADMIN_RESTRICTED' });
        }
        const { providerId, modelId } = req.body || {};
        if (typeof providerId !== 'string' || !providerId.trim()) {
          return res.status(400).json({ error: 'providerId is required', code: 'BAD_REQUEST' });
        }
        const result = this.aiControl!.select(
          providerId.trim().slice(0, 64),
          typeof modelId === 'string' && modelId.trim() ? modelId.trim().slice(0, 128) : undefined,
        );
        if (!result.ok) {
          return res.status(400).json({ error: result.error || 'Unknown provider', code: 'BAD_REQUEST' });
        }
        res.json({ success: true, ...this.aiControl!.status() });
      });
    }

    // 404 for anything unknown.
    app.use((_req, res) => {
      res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    });

    return app;
  }

  private optionsExtraOrigins(): string[] {
    return this.extraAllowedOrigins ?? getAllowedOriginsFromEnv();
  }

  private extraAllowedOrigins: string[] | undefined;

  private allowAdminRequest(req: express.Request): boolean {
    // Admin endpoints mutate trust state; default to loopback clients
    // (local control plane / same-machine CLI) unless the operator
    // explicitly opens the brain to a remote origin allowlist.
    const origin = req.headers.origin as string | undefined;
    if (origin === undefined) {
      const addr = req.socket.remoteAddress || '';
      return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    }
    return isOriginAllowed(origin, this.optionsExtraOrigins());
  }

  healthPayload(): Record<string, unknown> {
    let online = 0;
    for (const peer of this.peers.values()) {
      if (peer.connectionState === 'CONNECTED') online++;
    }
    return {
      status: 'ok',
      role: 'brain',
      version: APP_VERSION,
      transport: this.tlsConfig ? 'wss' : 'ws',
      protocol: { version: PROTOCOL_VERSION, min: PROTOCOL_MIN_SUPPORTED, max: PROTOCOL_MAX_SUPPORTED },
      brainId: this.identity.id,
      uptime: process.uptime(),
      bodies: {
        total: this.registry.list().length,
        online,
        revoked: this.registry.list().filter((d) => d.status === 'revoked').length,
      },
      pairingActive: this.pairing.isPairingActive(),
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async start(): Promise<{ host: string; port: number; wsUrl: string; secure: boolean }> {
    if (this.started) return this.addressInfo();
    this.started = true;

    const app = this.buildHttp();
    // TLS configured → https server (WSS only). A TLS-configured port
    // never speaks plaintext, so a ws:// downgrade attempt fails at the
    // TLS handshake before a single protocol byte is exchanged.
    let server: HttpServer;
    if (this.tlsConfig) {
      try {
        server = createHttpsServer({ key: this.tlsConfig.key, cert: this.tlsConfig.cert }, app) as unknown as HttpServer;
      } catch (error: any) {
        throw new Error(`Invalid TLS key/certificate for the Brain: ${error.message}`);
      }
    } else {
      server = createHttpServer(app);
    }
    this.httpServer = server;

    const wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false, // never re-enable unsafe compression
      maxPayload: 512 * 1024,
    });
    this.wss = wss;

    server.on('upgrade', (request, socket, head) => {
      let pathname = '';
      try {
        pathname = new URL(request.url || '/', 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== '/ws/brain') {
        socket.destroy();
        return;
      }
      const origin = (request.headers.origin as string | undefined) || undefined;
      if (!isOriginAllowed(origin, this.optionsExtraOrigins())) {
        logger.warn('brain', `Blocked brain WebSocket upgrade from origin ${origin || '(none)'}`);
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      // Connection-attempt rate limit per remote address.
      const ip = (request.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
      if (!this.allowConnectionAttempt(ip)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });

    wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => resolve());
    });

    const info = this.addressInfo();
    logger.info(
      'brain',
      `BLAXIN Brain listening on ${info.secure ? 'wss' : 'ws'}://${info.host}:${info.port}/ws/brain (brain ${this.identity.id}, ${info.secure ? 'TLS' : 'plaintext — loopback/dev only'})`,
    );
    return info;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const peer of this.peers.values()) {
      this.teardownPeer(peer, CLOSE.GOING_AWAY, 'Brain shutting down');
    }
    this.peers.clear();
    if (this.wss) this.wss.close();
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
        // Force-resolve if the server was never listening.
        setTimeout(resolve, 500);
      });
    }
    this.started = false;
  }

  /** Bind extra browser origins (used by tests / explicit config). */
  allowOrigins(origins: string[]): void {
    this.extraAllowedOrigins = origins;
  }

  // ── Admin helpers (HTTP + CLI) ────────────────────────────────

  generatePairingCode(): { code: string; expiresInSec: number } | null {
    const generated = this.pairing.generate();
    return { code: generated.formatted, expiresInSec: Math.round(generated.expiresInMs / 1000) };
  }

  revokeBody(bodyId: string): boolean {
    const ok = this.registry.markRevoked(bodyId.toUpperCase());
    if (ok) this.disconnectBody(bodyId.toUpperCase(), CLOSE.REVOKED, 'Device revoked');
    return ok;
  }

  listDevices(): ReturnType<DeviceRegistry['list']> {
    return this.registry.list();
  }

  isBodyConnected(bodyId: DeviceId): boolean {
    return this.peers.get(bodyId)?.connectionState === 'CONNECTED';
  }

  // ── Connection handling ───────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    const peer: PeerState = {
      connectionState: 'CONNECTING',
      bodyId: null,
      bodyName: '',
      capabilities: [],
      tools: [],
      protocol: 0,
      ws,
      phase: 'hello',
      sessionId: uuidv4(),
      pendingChallenge: null,
      framesReceived: 0,
      frameWindow: [],
      lastActivity: this.now(),
      heartbeatTimer: null,
      phaseTimer: null,
    };

    ws.on('message', (data) => {
      if (peer.phase === 'hello' && peer.framesReceived > PRE_AUTH_MAX_FRAMES) {
        this.teardownPeer(peer, CLOSE.RATE_LIMITED, 'Too many pre-auth frames');
        return;
      }
      this.handleFrame(peer, toBuffer(data));
    });

    ws.on('close', () => this.handleDisconnect(peer, 'connection closed'));
    ws.on('error', () => this.handleDisconnect(peer, 'socket error'));

    this.armPhaseTimer(peer, HELLO_TIMEOUT_MS, 'Timed out waiting for hello');
  }

  private handleFrame(peer: PeerState, data: Buffer): void {
    peer.lastActivity = this.now();
    peer.framesReceived++;
    // Windowed frame-rate guard: heartbeats alone generate ~4 frames/min
    // on a long-lived session, so a lifetime cap would kill healthy
    // connections. Bursts beyond the window are treated as hostile.
    const now = this.now();
    peer.frameWindow.push(now);
    while (peer.frameWindow.length > 0 && now - peer.frameWindow[0] > 10_000) {
      peer.frameWindow.shift();
    }
    if (peer.frameWindow.length > 400) {
      this.teardownPeer(peer, CLOSE.RATE_LIMITED, 'Frame rate exceeded');
      return;
    }

    const parsed = parseFrame(data);
    if (!parsed.ok) {
      logger.warn('brain', `Rejecting frame from ${peer.bodyId || '(unknown)'} (${parsed.code}: ${parsed.reason})`);
      this.sendError(peer, parsed.code, parsed.reason);
      this.teardownPeer(peer, CLOSE.MALFORMED, parsed.reason);
      return;
    }
    const msg = parsed.message;

    // Replay protection applies after the very first frame (hello ids are
    // unique per connection attempt anyway).
    if (peer.phase !== 'hello' && this.replay.isDuplicate(msg.id)) {
      this.teardownPeer(peer, CLOSE.PROTOCOL_ERROR, 'Duplicate message id');
      return;
    }
    if (peer.phase !== 'hello') this.replay.record(msg.id);

    switch (peer.phase) {
      case 'hello':
        this.handleHello(peer, msg);
        break;
      case 'pairing':
        if (msg.type === 'pair_request') this.handlePairRequest(peer, msg);
        else this.rejectPhaseMessage(peer, msg);
        break;
      case 'auth-body':
        if (msg.type === 'auth_response') this.handleBodyAuthResponse(peer, msg);
        else this.rejectPhaseMessage(peer, msg);
        break;
      case 'auth-brain':
        if (msg.type === 'auth_challenge') this.handleBrainChallenge(peer, msg);
        else if (msg.type === 'auth_result') this.handleBrainAuthResult(peer, msg);
        else this.rejectPhaseMessage(peer, msg);
        break;
      case 'ready':
        this.handleReadyMessage(peer, msg);
        break;
    }
  }

  private rejectPhaseMessage(peer: PeerState, msg: WireMessage): void {
    this.sendError(peer, 'PROTOCOL_VIOLATION', `Unexpected ${msg.type} in phase ${peer.phase}`);
    this.teardownPeer(peer, CLOSE.PROTOCOL_ERROR, `Unexpected ${msg.type} in phase ${peer.phase}`);
  }

  // ── Hello / pairing / auth ────────────────────────────────────

  private handleHello(peer: PeerState, msg: WireMessage): void {
    const p = msg.payload || {};
    const bodyId = String(p.deviceId || msg.deviceId || '');
    const name = typeof p.name === 'string' ? p.name.slice(0, 60) : 'Blaxin Body';
    const pMin = clampInt(p.protocolMin, PROTOCOL_VERSION, 1, 99);
    const pMax = clampInt(p.protocolMax, PROTOCOL_VERSION, 1, 99);
    const caps = sanitizeCapabilities(p.capabilities);

    const validation = validateWireMessage(msg, DEVICE_ROLE_BODY);
    if (!validation.ok) {
      this.sendError(peer, validation.code, validation.reason);
      this.teardownPeer(peer, CLOSE.MALFORMED, validation.reason);
      return;
    }
    if (!/^BLX-BODY-[A-Z0-9]{4,12}$/.test(bodyId) || bodyId === this.identity.id) {
      this.sendError(peer, 'MALFORMED', 'Invalid body id in hello');
      this.teardownPeer(peer, CLOSE.MALFORMED, 'Invalid body id');
      return;
    }
    if (pMin > pMax) {
      this.sendError(peer, 'MALFORMED', 'Invalid protocol range');
      this.teardownPeer(peer, CLOSE.MALFORMED, 'Invalid protocol range');
      return;
    }

    const negotiated = negotiateProtocol(
      PROTOCOL_MIN_SUPPORTED, PROTOCOL_MAX_SUPPORTED, pMin, pMax,
    );
    if (negotiated === null) {
      peer.connectionState = 'INCOMPATIBLE';
      this.sendError(peer, 'INCOMPATIBLE', `Body supports [${pMin},${pMax}]; Brain supports [${PROTOCOL_MIN_SUPPORTED},${PROTOCOL_MAX_SUPPORTED}]`);
      this.teardownPeer(peer, CLOSE.INCOMPATIBLE, 'Protocol incompatible');
      return;
    }

    peer.bodyId = bodyId;
    peer.bodyName = name;
    peer.capabilities = caps;
    peer.protocol = negotiated;
    peer.connectionState = 'AUTHENTICATING';
    peer.framesReceived = 1;

    const record = this.registry.get(bodyId);
    if (record?.status === 'revoked') {
      peer.connectionState = 'REVOKED';
      // Brain hello first so the body understands the rejection.
      this.send(peer, createMessage('brain', this.identity.id, 'hello', {
        deviceId: this.identity.id,
        name: this.brainName,
        protocolMin: PROTOCOL_MIN_SUPPORTED,
        protocolMax: PROTOCOL_MAX_SUPPORTED,
        mode: 'revoked',
      }));
      this.sendError(peer, 'REVOKED', 'This Body has been revoked by the Brain');
      this.teardownPeer(peer, CLOSE.REVOKED, 'Device revoked');
      return;
    }

    // Brain hello (identity + protocol + the mode the body must follow:
    // pair when unknown, auth when already registered).
    this.send(peer, createMessage('brain', this.identity.id, 'hello', {
      deviceId: this.identity.id,
      name: this.brainName,
      protocolMin: PROTOCOL_MIN_SUPPORTED,
      protocolMax: PROTOCOL_MAX_SUPPORTED,
      mode: record ? 'auth' : 'pair',
    }));

    if (record) {
      // Known body: straight to auth (body proves its key).
      this.enterAuthBodyPhase(peer);
    } else {
      peer.phase = 'pairing';
      peer.connectionState = 'AUTHENTICATING';
      this.armPhaseTimer(peer, HELLO_TIMEOUT_MS, 'Timed out waiting for pair_request');
    }
  }

  private handlePairRequest(peer: PeerState, msg: WireMessage): void {
    const p = msg.payload || {};
    const code = typeof p.code === 'string' ? p.code : '';
    const publicKey = typeof p.publicKey === 'string' ? p.publicKey : '';
    const name = typeof p.name === 'string' ? p.name.slice(0, 60) : peer.bodyName;
    const caps = sanitizeCapabilities(p.capabilities);
    const bodyId = peer.bodyId as DeviceId;

    if (!peer.bodyId || !publicKey || !code) {
      this.sendError(peer, 'MALFORMED', 'pair_request requires code, publicKey and body identity');
      this.teardownPeer(peer, CLOSE.MALFORMED, 'Invalid pair_request');
      return;
    }

    const verdict = this.pairing.tryConsume(code);
    if (!verdict.ok) {
      const reason = verdict.code === 'EXPIRED'
        ? 'Pairing code expired'
        : verdict.code === 'RATE_LIMITED'
          ? 'Too many pairing attempts — code invalidated'
          : 'Invalid pairing code';
      this.send(peer, createMessage('brain', this.identity.id, 'pair_reject', {
        reason,
        code: verdict.code,
        bodyId,
      }));
      this.teardownPeer(peer, CLOSE.POLICY, reason);
      return;
    }

    // Success: bind the body's public key permanently.
    this.registry.registerPair(bodyId, {
      name,
      publicKey,
      capabilities: caps,
      protocolMin: PROTOCOL_MIN_SUPPORTED,
      protocolMax: PROTOCOL_MAX_SUPPORTED,
    });
    logger.info('brain', `Body paired: ${bodyId} (${name})`);

    this.send(peer, createMessage('brain', this.identity.id, 'pair_accept', {
      bodyId,
      brainId: this.identity.id,
      brainName: this.brainName,
      publicKey: this.identity.publicKey,
      sessionId: peer.sessionId,
      protocol: peer.protocol,
    }, msg.id));

    this.enterAuthBodyPhase(peer);
  }

  /** Phase 1: the body proves its identity to the brain. */
  private enterAuthBodyPhase(peer: PeerState): void {
    peer.phase = 'auth-body';
    peer.connectionState = 'AUTHENTICATING';
    const challenge = randomChallenge();
    peer.pendingChallenge = challenge;
    this.send(peer, createMessage('brain', this.identity.id, 'auth_challenge', { challenge }));
    this.armPhaseTimer(peer, AUTH_TIMEOUT_MS, 'Timed out waiting for auth_response');
  }

  private handleBodyAuthResponse(peer: PeerState, msg: WireMessage): void {
    const record = this.registry.get(peer.bodyId as DeviceId);
    const challenge = peer.pendingChallenge;
    const p = msg.payload || {};
    const signature = typeof p.signature === 'string' ? p.signature : '';
    if (!record || !challenge || !signature) {
      this.sendError(peer, 'AUTH_FAILED', 'Authentication failed');
      this.teardownPeer(peer, CLOSE.AUTH_FAILED, 'Authentication failed');
      return;
    }
    const ok = verifyAuthSignature(
      record.publicKey,
      this.identity.id,
      peer.bodyId as DeviceId,
      challenge,
      signature,
    );
    if (!ok) {
      this.sendError(peer, 'AUTH_FAILED', 'Signature verification failed');
      this.teardownPeer(peer, CLOSE.AUTH_FAILED, 'Signature verification failed');
      return;
    }

    peer.pendingChallenge = null;
    // Body accepted. Now require the brain to authenticate to the body:
    // the body will send an auth_challenge we must sign.
    this.send(peer, createMessage('brain', this.identity.id, 'auth_result', { ok: true }));
    peer.phase = 'auth-brain';
    this.armPhaseTimer(peer, AUTH_TIMEOUT_MS, 'Timed out waiting for brain auth challenge');
  }

  private handleBrainChallenge(peer: PeerState, msg: WireMessage): void {
    const p = msg.payload || {};
    const challenge = typeof p.challenge === 'string' ? p.challenge : '';
    if (!challenge) {
      this.sendError(peer, 'MALFORMED', 'Missing challenge');
      this.teardownPeer(peer, CLOSE.MALFORMED, 'Missing challenge');
      return;
    }
    const signature = buildAuthSignature(
      this.identity.secretKey,
      peer.bodyId as DeviceId,
      this.identity.id,
      challenge,
    );
    this.send(peer, createMessage('brain', this.identity.id, 'auth_response', { challenge, signature }, msg.id));
  }

  private handleBrainAuthResult(peer: PeerState, msg: WireMessage): void {
    const p = msg.payload || {};
    if (p.ok !== true) {
      this.teardownPeer(peer, CLOSE.AUTH_FAILED, 'Body rejected brain authentication');
      return;
    }
    this.enterReady(peer);
  }

  private enterReady(peer: PeerState): void {
    if (!peer.bodyId) return;
    peer.phase = 'ready';
    peer.connectionState = 'CONNECTED';
    this.registry.markOnline(peer.bodyId, peer.sessionId);
    this.peers.set(peer.bodyId, peer);
    this.clearPhaseTimer(peer);
    this.startHeartbeat(peer);

    // Registry reconciliation: if a previous task on this body was
    // interrupted by a disconnect, surface it honestly.
    const task = this.activeTasks.get(peer.bodyId);
    const interrupted = task ? { taskId: task.taskId, state: task.state } : undefined;

    this.send(peer, createMessage('brain', this.identity.id, 'ready', {
      sessionId: peer.sessionId,
      brainId: this.identity.id,
      protocol: peer.protocol,
      capabilities: peer.capabilities,
      interruptedTask: interrupted ?? null,
    }));
  }

  // ── Ready-phase messages ──────────────────────────────────────

  private handleReadyMessage(peer: PeerState, msg: WireMessage): void {
    if (!peer.bodyId) return;
    switch (msg.type) {
      case 'capabilities':
        this.handleCapabilities(peer, msg);
        break;
      case 'state_sync':
        this.handleStateSync(peer, msg);
        break;
      case 'task_start':
        this.handleTaskStart(peer, msg);
        break;
      case 'action_result':
        this.handleActionResult(peer, msg);
        break;
      case 'approval_required':
      case 'approval_result':
        // Informational for observability; the action verdict arrives in
        // action_result. Logged without content.
        logger.info('brain', `${msg.type} for body ${peer.bodyId} (task in progress)`);
        break;
      case 'ping':
        this.send(peer, createMessage('brain', this.identity.id, 'pong', { at: this.now() }, msg.id));
        break;
      case 'pong':
        // activity already refreshed on every frame
        break;
      case 'error':
        logger.warn('brain', `Body ${peer.bodyId} reported error: ${(msg.payload || {}).code || 'unknown'}`);
        break;
      default:
        this.sendError(peer, 'PROTOCOL_VIOLATION', `Unexpected ${msg.type} in ready phase`);
        break;
    }
  }

  private handleCapabilities(peer: PeerState, msg: WireMessage): void {
    const p = msg.payload || {};
    const caps = sanitizeCapabilities(p.capabilities);
    const rawTools = Array.isArray(p.tools) ? p.tools : [];
    const tools: ToolDefinition[] = [];
    for (const raw of rawTools) {
      const def = sanitizeToolDefinition(raw);
      if (!def) continue;
      // The Brain only offers tools the body actually advertises.
      if (toolAllowedByCapabilities(caps, def.function.name)) {
        tools.push(def);
      }
    }
    // Capability truth: the union of what the registry knows and what the
    // body just sent (kept in sync with the body's current tool state).
    if (caps.length > 0) peer.capabilities = caps;
    peer.tools = tools;
    const record = this.registry.get(peer.bodyId as DeviceId);
    if (record && caps.length > 0) {
      record.capabilities = caps;
      this.registry.updateActivity(peer.bodyId as DeviceId, {});
      // Persist refreshed capabilities through the registry save.
      this.registry.registerPair(peer.bodyId as DeviceId, {
        name: record.name,
        publicKey: record.publicKey,
        capabilities: caps,
        protocolMin: record.protocolMin,
        protocolMax: record.protocolMax,
      });
    }
    this.send(peer, createMessage('brain', this.identity.id, 'ack', {
      what: 'capabilities',
      capabilities: caps,
      tools: tools.map((t) => t.function.name),
    }, msg.id));
    logger.info('brain', `Body ${peer.bodyId} advertised ${caps.length} capabilities / ${tools.length} tools`);
  }

  private handleStateSync(peer: PeerState, msg: WireMessage): void {
    const p = msg.payload || {};
    const bodyId = peer.bodyId as DeviceId;
    const taskId = typeof p.taskId === 'string' ? p.taskId : undefined;
    const lastAck = typeof p.lastAckedActionId === 'string' ? p.lastAckedActionId : undefined;

    // A task the brain no longer tracks (brain restart or task finished)
    // is reported as interrupted so the body never fakes completion.
    const known = taskId ? this.activeTasks.get(bodyId) : undefined;
    const interrupted = taskId && !known
      ? { taskId, reason: 'Brain has no active state for this task (previous brain/task ended)' }
      : undefined;

    if (known && lastAck) {
      this.registry.updateActivity(bodyId, { activeTaskId: known.taskId, lastAckedActionId: lastAck });
    } else if (known) {
      this.registry.updateActivity(bodyId, { activeTaskId: known.taskId });
    } else if (taskId) {
      this.registry.updateActivity(bodyId, {});
    }

    this.send(peer, createMessage('brain', this.identity.id, 'state_sync_ack', {
      acknowledgedActionId: known ? this.registry.get(bodyId)?.lastAckedActionId ?? lastAck ?? null : null,
      activeTask: known ? { taskId: known.taskId, state: known.state, description: known.description ?? null } : null,
      interruptedTask: interrupted ?? null,
    }, msg.id));
  }

  private handleTaskStart(peer: PeerState, msg: WireMessage): void {
    const p = msg.payload || {};
    const bodyId = peer.bodyId as DeviceId;
    const text = typeof p.text === 'string' ? p.text.trim().slice(0, 4000) : '';
    if (!text) {
      this.sendError(peer, 'EMPTY_TASK', 'Task text is required');
      return;
    }
    const suggestedTaskId = typeof p.taskId === 'string' ? p.taskId : undefined;
    if (suggestedTaskId && this.knownTaskIds.has(suggestedTaskId)) {
      this.sendError(peer, 'DUPLICATE_TASK', 'This task was already processed');
      return;
    }
    if (this.activeTasks.has(bodyId)) {
      this.sendError(peer, 'TASK_ACTIVE', 'Another task is already running on this Body');
      return;
    }
    const driverId = typeof p.driver === 'string' && this.drivers.has(p.driver)
      ? p.driver
      : this.drivers.has(this.defaultDriverId)
        ? this.defaultDriverId
        : this.drivers.keys().next().value as string | undefined;
    if (!driverId) {
      this.sendError(peer, 'NO_DRIVER', 'No task driver is configured on the Brain');
      return;
    }
    const taskId = suggestedTaskId && !this.knownTaskIds.has(suggestedTaskId)
      ? suggestedTaskId
      : uuidv4();

    const session: TaskSession = {
      taskId,
      text,
      driverId,
      state: 'planning',
      startTime: this.now(),
      active: true,
    };
    this.activeTasks.set(bodyId, session);
    this.registry.updateActivity(bodyId, { activeTaskId: taskId, lastAckedActionId: undefined });

    void this.runDriver(peer, session);
  }

  private async runDriver(peer: PeerState, session: TaskSession): Promise<void> {
    const bodyId = peer.bodyId as DeviceId;
    const driver = this.drivers.get(session.driverId)!;
    const capabilitySnapshot = [...peer.capabilities];
    const toolsSnapshot = [...peer.tools];

    const ctx = {
      taskId: session.taskId,
      text: session.text,
      bodyId,
      bodyName: peer.bodyName,
      capabilities: capabilitySnapshot,
      tools: toolsSnapshot,
      update: (state: string, description?: string) => {
        session.state = state;
        session.description = description;
        const live = this.peers.get(bodyId);
        if (live && live.ws.readyState === WebSocket.OPEN) {
          const payload: TaskUpdatePayload = { taskId: session.taskId, state, description };
          this.send(live, createMessage('brain', this.identity.id, 'task_update', { ...payload }));
        }
      },
      requestAction: (req: TaskActionRequest): Promise<ActionResult> => {
        return this.requestActionFor(peer, session, req);
      },
      note: (component: string, message: string) => logger.info(component, message),
    };

    let outcome: { kind: 'completed'; summary: string } | { kind: 'failed'; error: string; code?: string };
    try {
      outcome = await driver.run(ctx);
    } catch (error: any) {
      outcome = { kind: 'failed', error: error.message || 'Driver error', code: 'DRIVER_ERROR' };
    }

    session.active = false;
    session.outcome = outcome;
    this.activeTasks.delete(bodyId);
    this.knownTaskIds.set(session.taskId, this.now());
    this.trimKnownTasks();
    this.registry.updateActivity(bodyId, { activeTaskId: undefined });

    const live = this.peers.get(bodyId);
    if (live && live.ws.readyState === WebSocket.OPEN) {
      if (outcome.kind === 'completed') {
        this.send(live, createMessage('brain', this.identity.id, 'task_complete', {
          taskId: session.taskId,
          summary: outcome.summary,
        }));
      } else {
        this.send(live, createMessage('brain', this.identity.id, 'task_failed', {
          taskId: session.taskId,
          error: outcome.error,
          code: outcome.code,
        }));
      }
    }
  }

  private requestActionFor(
    peer: PeerState,
    session: TaskSession,
    req: TaskActionRequest,
  ): Promise<ActionResult> {
    const bodyId = peer.bodyId as DeviceId;
    const live = this.peers.get(bodyId);
    if (!live || live.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        taskId: req.taskId,
        actionId: req.actionId,
        requestId: req.requestId,
        outcome: 'rejected',
        executed: false,
        replay: false,
        success: false,
        error: 'CONNECTION_LOST: no live connection to the Body',
      });
    }

    return new Promise<ActionResult>((resolve) => {
      this.pendingActions.set(req.actionId, { taskId: session.taskId, actionId: req.actionId, resolve });
      const payload = {
        taskId: req.taskId,
        actionId: req.actionId,
        requestId: req.requestId,
        tool: req.action.tool,
        args: req.action.args,
        idempotent: req.idempotent,
        description: req.description,
      };
      this.send(live, createMessage('brain', this.identity.id, 'task_action', payload, req.requestId));
    });
  }

  private handleActionResult(peer: PeerState, msg: WireMessage): void {
    const p = msg.payload || {};
    const actionId = typeof p.actionId === 'string' ? p.actionId : '';
    const pending = this.pendingActions.get(actionId);
    if (!pending) {
      // Stale/duplicate result (already resolved, or unknown) — ignore
      // safely rather than double-driving a task.
      logger.warn('brain', `Ignoring stale action_result for ${actionId || '(missing id)'}`);
      return;
    }
    this.pendingActions.delete(actionId);
    const result: ActionResult = {
      taskId: typeof p.taskId === 'string' ? p.taskId : pending.taskId,
      actionId,
      requestId: typeof p.requestId === 'string' ? p.requestId : actionId,
      outcome: p.outcome === 'denied' ? 'denied' : p.outcome === 'rejected' ? 'rejected' : 'allowed',
      executed: p.executed === true,
      replay: p.replay === true,
      success: p.success === true,
      output: typeof p.output === 'string' ? p.output : undefined,
      error: typeof p.error === 'string' ? p.error : undefined,
    };
    // Cap stored output/error so the registry never holds giant payloads.
    if (result.output && result.output.length > 50_000) result.output = result.output.slice(0, 50_000);
    if (result.error && result.error.length > 50_000) result.error = result.error.slice(0, 50_000);
    this.registry.updateActivity(peer.bodyId as DeviceId, {
      activeTaskId: pending.taskId,
      lastAckedActionId: actionId,
    });
    pending.resolve(result);
  }

  // ── Disconnect / cleanup ──────────────────────────────────────

  private handleDisconnect(peer: PeerState, reason: string): void {
    if (!peer.bodyId) {
      this.teardownPeer(peer, CLOSE.GOING_AWAY, reason);
      return;
    }
    const bodyId = peer.bodyId;
    this.teardownPeer(peer, CLOSE.GOING_AWAY, reason);
    if (this.peers.get(bodyId) === peer) {
      this.peers.delete(bodyId);
    }
    this.registry.markOffline(bodyId);
    // Abort any in-flight action: the driver resolves and fails the task
    // honestly (no action is ever blindly replayed after reconnect).
    for (const [actionId, pending] of this.pendingActions) {
      if (pending.taskId === this.activeTasks.get(bodyId)?.taskId) {
        this.pendingActions.delete(actionId);
        pending.resolve({
          taskId: pending.taskId,
          actionId: pending.actionId,
          requestId: pending.actionId,
          outcome: 'rejected',
          executed: false,
          replay: false,
          success: false,
          error: 'CONNECTION_LOST: connection dropped before the action result arrived',
        });
      }
    }
    const task = this.activeTasks.get(bodyId);
    if (task) {
      task.state = 'interrupted';
      task.description = 'Interrupted by connection loss';
      logger.warn('brain', `Task ${task.taskId} interrupted for body ${bodyId} (${reason})`);
    }
  }

  private teardownPeer(peer: PeerState, code: number, reason: string): void {
    this.clearPhaseTimer(peer);
    if (peer.heartbeatTimer) {
      clearInterval(peer.heartbeatTimer);
      peer.heartbeatTimer = null;
    }
    try {
      if (peer.ws.readyState === WebSocket.OPEN || peer.ws.readyState === WebSocket.CONNECTING) {
        peer.ws.close(code, reason.slice(0, 120));
      }
    } catch { /* already closed */ }
  }

  private disconnectBody(bodyId: DeviceId, code: number, reason: string): void {
    const peer = this.peers.get(bodyId);
    if (peer) this.teardownPeer(peer, code, reason);
  }

  private send(peer: PeerState, msg: WireMessage): void {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    try {
      peer.ws.send(JSON.stringify(msg));
    } catch (error: any) {
      logger.error('brain', `Failed to send frame: ${error.message}`);
    }
  }

  private sendError(peer: PeerState, code: string, message: string): void {
    this.send(peer, createMessage('brain', this.identity.id, 'error', { code, message }));
  }

  // ── Heartbeat / rate limiting ─────────────────────────────────

  private startHeartbeat(peer: PeerState): void {
    if (peer.heartbeatTimer) clearInterval(peer.heartbeatTimer);
    peer.heartbeatTimer = setInterval(() => {
      const now = this.now();
      // No frame of any kind within the timeout → dead peer.
      if (now - peer.lastActivity > 45_000) {
        logger.warn('brain', `Heartbeat timeout for body ${peer.bodyId}`);
        this.handleDisconnect(peer, 'heartbeat timeout');
        return;
      }
      try {
        if (peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(JSON.stringify(createMessage('brain', this.identity.id, 'ping', { at: now })));
        }
      } catch { /* ignore */ }
    }, 15_000);
  }

  private armPhaseTimer(peer: PeerState, ms: number, message: string): void {
    this.clearPhaseTimer(peer);
    peer.phaseTimer = setTimeout(() => {
      this.sendError(peer, 'TIMEOUT', message);
      this.teardownPeer(peer, CLOSE.POLICY, message);
    }, ms);
  }

  private clearPhaseTimer(peer: PeerState): void {
    if (peer.phaseTimer) {
      clearTimeout(peer.phaseTimer);
      peer.phaseTimer = null;
    }
  }

  private allowConnectionAttempt(ip: string): boolean {
    const now = this.now();
    const log = (this.attemptLog.get(ip) || []).filter((t) => now - t < CONNECTION_ATTEMPT_WINDOW_MS);
    if (log.length >= CONNECTION_ATTEMPT_LIMIT) {
      this.attemptLog.set(ip, log);
      return false;
    }
    log.push(now);
    this.attemptLog.set(ip, log);
    return true;
  }

  private trimKnownTasks(): void {
    const cutoff = this.now() - 60 * 60 * 1000;
    for (const [taskId, ts] of this.knownTaskIds) {
      if (ts < cutoff) this.knownTaskIds.delete(taskId);
    }
  }

  private addressInfo(): { host: string; port: number; wsUrl: string; secure: boolean } {
    const addr = this.httpServer?.address();
    const port = typeof addr === 'object' && addr ? addr.port : this.port;
    const secure = !!this.tlsConfig;
    return { host: this.host, port, wsUrl: `${secure ? 'wss' : 'ws'}://${this.host}:${port}/ws/brain`, secure };
  }
}

/** Normalize a ws RawData payload into a Buffer for parsing. */
function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Validate a peer-supplied tool definition (allowlisted shape only). */
export function sanitizeToolDefinition(raw: unknown): ToolDefinition | null {
  if (!raw || typeof raw !== 'object') return null;
  const def = raw as Record<string, unknown>;
  const fn = def.function as Record<string, unknown> | undefined;
  if (def.type !== 'function' || !fn || typeof fn !== 'object') return null;
  if (typeof fn.name !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(fn.name)) return null;
  if (typeof fn.description !== 'string' || fn.description.length > 2000) return null;
  if (fn.parameters !== undefined && (typeof fn.parameters !== 'object' || fn.parameters === null)) return null;
  // Never trust peer-supplied "tool calls" — only their schemas.
  return {
    type: 'function',
    function: {
      name: fn.name,
      description: fn.description,
      parameters: (fn.parameters as Record<string, unknown>) || {},
    },
  };
}
