// BLAXIN remote brain driver (Body side)
// =============================================================
// When BLAXIN runs in external-Brain mode, this driver replaces the
// local orchestrator as the thing that talks to the UI:
//
//   user message  →  forwarded to the Brain (task_start)
//   Brain action  →  capability + policy check, optional user
//                    confirmation, local tool execution
//   tool result   →  structured action_result back to the Brain
//   Brain verdict →  final message to the UI
//
// The Brain NEVER executes on the Body; every action crosses this
// gate. Duplicate execution after reconnect is prevented with a
// persisted executed-action cache (non-idempotent actions without a
// cached outcome are never blindly replayed). When the Brain is
// offline the driver says so honestly — no fake AI completion.
// =============================================================

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import { getConfig, matchesAnyPattern } from '../utils/config.js';
import { toolRegistry, ToolRegistry } from '../tools/index.js';
import {
  CapabilitySet, ConnectionState, TaskActionRequest, ActionResult,
  PROTOCOL_MIN_SUPPORTED, PROTOCOL_MAX_SUPPORTED, WireMessage,
} from './types.js';
import { negotiateProtocol } from './protocol.js';
import { DeviceIdentity, verifySignature, randomChallenge } from './identity.js';
import { buildAuthSignature } from './handshake.js';
import { BodyLink } from './body-link.js';
import { BodyState, CachedActionResult, MAX_CACHED_OUTPUT_CHARS } from './body-state.js';
import { capabilitiesFromTools, toolAllowedByCapabilities } from './capabilities.js';
import { CLOSE } from './handshake.js';
import type { AgentState, AgentTask, TaskStep, ToolResult } from '../types.js';
import { budgetAssistantMessage } from '../utils/context-budget.js';

type EventCallback = (event: string, data: any) => void;

type Phase = 'idle' | 'connecting' | 'pairing' | 'auth' | 'ready';

export interface RemoteBrainOptions {
  identity: DeviceIdentity;
  url: string;
  state?: BodyState;
  toolRegistry?: Pick<ToolRegistry, 'getTool' | 'getToolDefinitions' | 'execute' | 'requiresConfirmation'>;
  getConfig?: () => ReturnType<typeof getConfig>;
  autoReconnect?: boolean;
  onEvent?: EventCallback;
  /** PEM bundle of CA(s) that signed the Brain's TLS certificate (see
   * BLAXIN_BRAIN_CA_FILE). Required for private-CA / self-signed remote
   * Brains — certificates are always validated otherwise. */
  ca?: string;
  /** Explicit development override for plaintext/insecure connections.
   * Never enabled by default (see BLAXIN_BRAIN_ALLOW_INSECURE). */
  allowInsecure?: boolean;
  now?: () => number;
  /** Heartbeat cadence overrides (tests / tuned deployments). Defaults to
   * the module constants; see BodyLinkOptions. */
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

const CONFIRMATION_TIMEOUT_MS = 120_000;
const MAX_ACTION_RETRIES = 2;
/** Truncate tool outputs forwarded to the Brain (payload discipline). */
const MAX_OUTPUT_TO_BRAIN = 100_000;

export class RemoteBrainDriver {
  private link: BodyLink;
  private readonly identity: DeviceIdentity;
  private readonly state: BodyState;
  private readonly tools: NonNullable<RemoteBrainOptions['toolRegistry']>;
  private readonly configOf: NonNullable<RemoteBrainOptions['getConfig']>;
  private readonly eventCallback: EventCallback | null;
  private readonly capabilities: CapabilitySet;

  private phase: Phase = 'idle';
  private brainId: string | null = null;
  private brainName: string | null = null;
  private brainPublicKey: string | null = null;
  private sessionId: string | null = null;
  private protocol = 0;
  private pendingPairingCode: string | null = null;
  private lastError: string | null = null;
  private connectedAt: number | null = null;

  // Confirmation gate (parallel to the local orchestrator's).
  private pendingConfirmations = new Map<string, (approved: boolean) => void>();
  private pendingAuthChallenges = new Map<string, string>(); // our challenge → expected brain sig

  // Active remote task mirror for the UI.
  private task: AgentTask | null = null;

  // Link state mirror for REST status.
  private linkState: ConnectionState = 'DISCONNECTED';

  constructor(options: RemoteBrainOptions) {
    this.identity = options.identity;
    this.state = options.state ?? new BodyState();
    this.tools = options.toolRegistry ?? toolRegistry;
    this.configOf = options.getConfig ?? getConfig;
    this.eventCallback = options.onEvent ?? null;
    this.capabilities = capabilitiesFromTools(
      (options.toolRegistry ?? toolRegistry).getToolDefinitions().map((t) => t.function.name),
    );

    this.link = new BodyLink({
      url: options.url,
      identity: options.identity,
      name: this.identity.name,
      capabilities: this.capabilities,
      autoReconnect: options.autoReconnect ?? true,
      ca: options.ca,
      allowInsecure: options.allowInsecure,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs,
      onStateChange: (state, detail) => this.onLinkState(state, detail),
      onOpen: () => this.onLinkOpen(),
      onMessage: (msg) => this.onLinkMessage(msg),
      onClosed: (info) => this.onLinkClosed(info),
      now: options.now,
    });
  }

  // ── Public API (used by the server + UI-facing endpoints) ─────

  /** Begin connecting (with an optional pairing code for first contact). */
  connect(pairingCode?: string): void {
    this.pendingPairingCode = pairingCode?.trim() || null;
    if (this.pendingPairingCode) {
      this.lastError = null;
    }
    this.phase = 'connecting';
    this.link.connect();
  }

  /** Stop connecting and drop the socket. */
  disconnect(): void {
    this.phase = 'idle';
    this.link.disconnect();
    this.clearTask('Brain disconnected');
  }

  /** Forget the saved Brain pairing on this Body (local only — the Brain
   * keeps its own registry; use its admin API to revoke/forget there). */
  forgetPairing(): void {
    this.disconnect();
    this.state.clearBrain();
    this.brainId = null;
    this.brainName = null;
    this.brainPublicKey = null;
    this.sessionId = null;
    this.protocol = 0;
    this.pendingPairingCode = null;
    this.lastError = 'Saved Brain pairing cleared on this Body';
    this.pendingAuthChallenges.clear();
    logger.info('remote-brain', 'Saved Brain pairing cleared');
  }

  /** Full status snapshot for REST/UI. */
  status(): Record<string, unknown> {
    return {
      mode: 'external',
      bodyId: this.identity.id,
      brain: {
        state: this.linkState,
        phase: this.phase,
        brainId: this.brainId,
        brainName: this.brainName,
        protocol: this.protocol,
        sessionId: this.sessionId,
        connectedAt: this.connectedAt,
        lastError: this.lastError,
        url: this.link.url,
        transport: this.link.url.startsWith('wss://') ? 'wss' : 'ws',
        secure: !this.link.url.startsWith('ws://') || this.isLoopbackUrl(),
      },
      capabilities: this.capabilities,
      task: this.task ? {
        id: this.task.id,
        state: this.task.state,
        instruction: this.task.instruction,
        steps: (this.task.steps || []).map((s) => ({
          id: s.id, description: s.description, state: s.state,
        })),
      } : null,
    };
  }

  getState(): ConnectionState {
    return this.linkState;
  }

  isReady(): boolean {
    return this.phase === 'ready' && this.linkState === 'CONNECTED';
  }

  /**
   * The UI sends a user message. Honest offline behavior: when there is
   * no live Brain we say so instead of faking AI completion. Safe
   * deterministic local tools are still reachable through the local
   * fast path when the operator enables it (see server wiring).
   */
  sendUserMessage(text: string): void {
    if (!this.isReady()) {
      this.emit('error', {
        message: 'Your BLAXIN Brain is offline. Reconnect the Brain before sending a task.',
        code: 'BRAIN_OFFLINE',
      });
      return;
    }
    if (this.task && this.task.state !== 'completed' && this.task.state !== 'error' && this.task.state !== 'idle') {
      this.emit('error', {
        message: 'A task is already running on the Brain. Stop it or wait for it to finish.',
        code: 'TASK_ACTIVE',
      });
      return;
    }
    const taskId = uuidv4();
    this.task = {
      id: taskId,
      instruction: text,
      state: 'thinking',
      steps: [],
      currentStep: 0,
      startTime: Date.now(),
    };
    const sent = this.link.sendAs('task_start', { text, taskId });
    if (!sent) {
      this.clearTask('Send failed');
      this.emit('error', { message: 'Failed to reach the Brain.', code: 'BRAIN_OFFLINE' });
    }
  }

  /** Abort the running remote task with the dedicated task_cancel
   * protocol message. The Brain cancels pending actions and answers with
   * task_failed CANCELLED (surfaced as a clean stop). When the link is
   * already down we simply drop the local task mirror. */
  stopTask(): void {
    if (this.isReady() && this.task) {
      this.link.sendAs('task_cancel', { taskId: this.task.id });
      this.emit('agent-state', { state: 'cancelling', description: 'Stopping task…' });
    } else if (this.task) {
      this.clearTask('Stopped by user');
    }
  }

  clearHistory(): void {
    // Conversation history lives on the Brain in external mode. The UI
    // history is cleared locally; nothing to delete on the Brain.
    this.clearTask('History cleared');
  }

  /** Handle a UI confirmation verdict (mirrors orchestrator API). */
  respondToConfirmation(stepId: string | undefined, approved: boolean): void {
    if (!stepId) {
      for (const [, resolve] of this.pendingConfirmations) resolve(false);
      this.pendingConfirmations.clear();
      return;
    }
    const resolve = this.pendingConfirmations.get(stepId);
    if (resolve) {
      this.pendingConfirmations.delete(stepId);
      resolve(approved);
      logger.info('remote-brain', `Confirmation for ${stepId}: ${approved ? 'approved' : 'denied'}`);
    }
  }

  // ── Link callbacks ────────────────────────────────────────────

  private onLinkState(state: ConnectionState, detail?: { reason?: string; attempt?: number }): void {
    this.linkState = state;
    if (detail?.reason && (state === 'ERROR' || state === 'REVOKED' || state === 'INCOMPATIBLE')) {
      this.lastError = detail.reason;
    }
    this.emit('brain-status', { state, ...detail });
  }

  private onLinkClosed(info: { code: number; reason: string; manual: boolean }): void {
    if (this.task && this.phase === 'ready' && !info.manual) {
      // Mid-task drop: never fake completion. The Brain marks the task
      // interrupted; we surface it when the link comes back, and locally
      // keep the task visible as interrupted.
      if (this.task.state !== 'completed' && this.task.state !== 'error') {
        this.task.state = 'error';
        this.emit('error', {
          message: `Connection to the Brain was lost mid-task. The task was interrupted and will not resume automatically.`,
          code: 'BRAIN_CONNECTION_LOST',
        });
        this.emit('agent-state', { state: 'error', description: 'Brain connection lost mid-task' });
      }
    }
    this.phase = 'idle';
  }

  private onLinkOpen(): void {
    this.phase = 'connecting';
    // hello: identity + protocol range + capabilities.
    this.link.sendAs('hello', {
      deviceId: this.identity.id,
      name: this.identity.name,
      protocolMin: PROTOCOL_MIN_SUPPORTED,
      protocolMax: PROTOCOL_MAX_SUPPORTED,
      capabilities: this.capabilities,
    });
  }

  // ── Inbound protocol automaton ────────────────────────────────

  private onLinkMessage(msg: WireMessage): void {
    // Direction + type policy is enforced per phase below; structural
    // validation already ran in the link.
    switch (this.phase) {
      case 'connecting':
        if (msg.type === 'hello') { this.handleBrainHello(msg); return; }
        if (msg.type === 'error') { this.handleBrainError(msg); return; }
        break;
      case 'pairing':
        if (msg.type === 'pair_accept') { this.handlePairAccept(msg); return; }
        if (msg.type === 'pair_reject') {
          this.emit('error', { message: `Pairing rejected by the Brain: ${(msg.payload || {}).reason || 'unknown reason'}`, code: 'PAIR_REJECTED' });
          this.link.disconnect();
          return;
        }
        if (msg.type === 'auth_challenge') { this.respondToBrainChallenge(msg); return; }
        if (msg.type === 'error') { this.handleBrainError(msg); return; }
        break;
      case 'auth':
        if (msg.type === 'auth_challenge') { this.respondToBrainChallenge(msg); return; }
        if (msg.type === 'auth_response') { this.handleAuthResponse(msg); return; }
        if (msg.type === 'auth_result') { this.handleAuthResult(msg); return; }
        if (msg.type === 'ready') { this.handleReady(msg); return; }
        if (msg.type === 'error') { this.handleBrainError(msg); return; }
        break;
      case 'ready':
        this.handleReadyMessage(msg);
        return;
      case 'idle':
        return;
    }
    // Anything unexpected is a protocol violation — drop the connection
    // rather than guess (fail closed).
    logger.warn('remote-brain', `Unexpected ${msg.type} from Brain in phase ${this.phase}`);
    this.link.disconnect();
  }

  private handleBrainError(msg: WireMessage): void {
    const p = msg.payload || {};
    const code = typeof p.code === 'string' ? p.code : 'BRAIN_ERROR';
    const message = typeof p.message === 'string' ? p.message : 'The Brain reported an error';
    if (code === 'INCOMPATIBLE') {
      this.linkState = 'INCOMPATIBLE';
      this.emit('brain-status', { state: 'INCOMPATIBLE' });
    }
    this.emit('error', { message, code });
  }

  private handleBrainHello(msg: WireMessage): void {
    const p = msg.payload || {};
    const brainId = String(p.deviceId || msg.deviceId || '');
    const brainName = typeof p.name === 'string' ? p.name : brainId;
    const pMin = typeof p.protocolMin === 'number' ? p.protocolMin : PROTOCOL_MIN_SUPPORTED;
    const pMax = typeof p.protocolMax === 'number' ? p.protocolMax : PROTOCOL_MAX_SUPPORTED;
    const mode = String(p.mode || 'auth');

    if (!/^BLX-BRAIN-[A-Z0-9]{4,12}$/.test(brainId)) {
      this.lastError = 'The server at this address is not a BLAXIN Brain';
      this.emit('error', { message: this.lastError, code: 'NOT_A_BRAIN' });
      this.link.disconnect();
      return;
    }
    const negotiated = negotiateProtocol(PROTOCOL_MIN_SUPPORTED, PROTOCOL_MAX_SUPPORTED, pMin, pMax);
    if (negotiated === null) {
      this.emit('error', { message: `Protocol incompatible: this Body supports [${PROTOCOL_MIN_SUPPORTED},${PROTOCOL_MAX_SUPPORTED}], Brain supports [${pMin},${pMax}]`, code: 'INCOMPATIBLE' });
      // Terminal: the Brain will also close with 4404, but pin the state
      // immediately so a reconnect storm can never start.
      this.link.failClosed('INCOMPATIBLE', 'Protocol incompatible');
      return;
    }
    this.brainId = brainId;
    this.brainName = brainName;
    this.protocol = negotiated;
    this.connectedAt = Date.now();

    if (mode === 'revoked') {
      this.emit('error', { message: 'This Body was revoked by the Brain. Re-pair to use it again.', code: 'REVOKED' });
      // Terminal state: a revoked device must never reconnect with its
      // old credentials, even by accident.
      this.link.failClosed('REVOKED', 'Device revoked by Brain');
      return;
    }

    const saved = this.state.getBrain();
    if (mode === 'pair') {
      if (!this.pendingPairingCode) {
        this.emit('error', {
          message: `This Brain (${brainId}) does not know this Body. Provide a pairing code to connect.`,
          code: 'PAIRING_REQUIRED',
        });
        this.link.disconnect();
        return;
      }
      this.phase = 'pairing';
      this.link.sendAs('pair_request', {
        code: this.pendingPairingCode,
        name: this.identity.name,
        publicKey: this.identity.publicKey,
        capabilities: this.capabilities,
      });
      return;
    }

    // mode === 'auth': the Brain expects a known Body.
    if (!saved || saved.brainId !== brainId) {
      this.lastError = `This Body has no pairing with Brain ${brainId}. Re-pair with a fresh code.`;
      this.emit('error', { message: this.lastError, code: 'UNPAIRED' });
      this.link.disconnect();
      return;
    }
    this.brainPublicKey = saved.brainPublicKey;
    this.phase = 'auth';
    // The Brain sends the first auth_challenge.
  }

  private handlePairAccept(msg: WireMessage): void {
    const p = msg.payload || {};
    const brainId = String(p.brainId || '');
    const publicKey = typeof p.publicKey === 'string' ? p.publicKey : '';
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
    if (!/^BLX-BRAIN-[A-Z0-9]{4,12}$/.test(brainId) || !publicKey || !sessionId) {
      this.emit('error', { message: 'Malformed pair_accept from Brain.', code: 'PAIR_FAILED' });
      this.link.disconnect();
      return;
    }
    // Persist the permanent Brain identity (public key — never the code).
    this.brainId = brainId;
    this.brainName = typeof p.brainName === 'string' ? p.brainName : brainId;
    this.brainPublicKey = publicKey;
    this.sessionId = sessionId;
    this.state.setBrain({
      brainId,
      brainName: this.brainName,
      brainPublicKey: publicKey,
      url: this.link.url,
      pairedAt: Date.now(),
    });
    this.pendingPairingCode = null;
    this.phase = 'auth';
    logger.info('remote-brain', `Paired with Brain ${brainId}`);
    // Brain proceeds to auth-body: it will send auth_challenge.
  }

  private respondToBrainChallenge(msg: WireMessage): void {
    const p = msg.payload || {};
    const challenge = typeof p.challenge === 'string' ? p.challenge : '';
    if (!challenge) {
      this.link.disconnect();
      return;
    }
    const signature = buildAuthSignature(this.identity.secretKey, this.brainId!, this.identity.id, challenge);
    this.link.sendAs('auth_response', { challenge, signature }, msg.id);
  }

  private handleAuthResult(msg: WireMessage): void {
    const p = msg.payload || {};
    if (p.ok !== true) {
      this.emit('error', { message: 'The Brain rejected this Body identity.', code: 'AUTH_FAILED' });
      this.link.disconnect();
      return;
    }
    // This Body is authenticated. Now authenticate the Brain to us.
    if (!this.brainPublicKey) {
      this.emit('error', { message: 'No Brain public key to verify against.', code: 'AUTH_FAILED' });
      this.link.disconnect();
      return;
    }
    const challenge = randomChallenge();
    this.pendingAuthChallenges.set(challenge, this.brainPublicKey);
    this.link.sendAs('auth_challenge', { challenge });
  }

  private handleAuthResponse(msg: WireMessage): void {
    const p = msg.payload || {};
    const challenge = typeof p.challenge === 'string' ? p.challenge : '';
    const signature = typeof p.signature === 'string' ? p.signature : '';
    const pub = this.pendingAuthChallenges.get(challenge);
    if (!pub || !signature) {
      this.emit('error', { message: 'Brain failed its authentication challenge.', code: 'AUTH_FAILED' });
      this.link.disconnect();
      return;
    }
    this.pendingAuthChallenges.delete(challenge);
    const ok = verifySignature(pub, `${this.identity.id}|${this.brainId}|${challenge}`, signature);

    if (!ok) {
      this.lastError = 'Brain signature verification failed — possible impostor';
      this.emit('error', { message: this.lastError, code: 'AUTH_FAILED' });
      this.linkState = 'ERROR';
      this.emit('brain-status', { state: 'ERROR', reason: this.lastError });
      this.link.disconnect();
      return;
    }
    this.link.sendAs('auth_result', { ok: true });
  }

  private handleReady(msg: WireMessage): void {
    const p = msg.payload || {};
    this.sessionId = typeof p.sessionId === 'string' ? p.sessionId : this.sessionId;
    this.link.markConnected();
    this.phase = 'ready';
    this.lastError = null;
    this.emit('brain-status', { state: 'CONNECTED', brainId: this.brainId, protocol: this.protocol });
    this.emit('agent-state', { state: 'idle', description: `Connected to Brain ${this.brainId}` });

    // Advertise tools (schemas) so the Brain can reason over them.
    const defs = this.tools.getToolDefinitions();
    this.link.sendAs('capabilities', {
      capabilities: this.capabilities,
      tools: defs,
    });

    // State sync: tell the Brain where this Body stands.
    const interrupted = p.interruptedTask
      ? { taskId: (p.interruptedTask as { taskId?: string }).taskId }
      : undefined;
    this.link.sendAs('state_sync', {
      sessionId: this.sessionId,
      taskId: interrupted?.taskId ?? this.task?.id,
      lastAckedActionId: this.lastCachedActionId(interrupted?.taskId ?? this.task?.id),
    });

    if (interrupted?.taskId) {
      this.emit('agent-state', {
        state: 'error',
        description: `The previous task (${interrupted.taskId.slice(0, 8)}…) was interrupted by the connection loss. Send it again to retry.`,
      });
    }
  }

  private lastCachedActionId(taskId?: string): string | undefined {
    if (!taskId) return undefined;
    return this.state.lastFinalAction(taskId)?.actionId;
  }

  // ── Ready-phase messages ──────────────────────────────────────

  private handleReadyMessage(msg: WireMessage): void {
    switch (msg.type) {
      case 'task_update':
        this.handleTaskUpdate(msg);
        break;
      case 'task_action':
        void this.handleTaskAction(msg);
        break;
      case 'task_complete':
        this.handleTaskComplete(msg);
        break;
      case 'task_failed':
        this.handleTaskFailed(msg);
        break;
      case 'state_sync_ack':
        break; // reconciliation handled on our side already
      case 'ack':
        break;
      case 'ping':
        this.link.sendAs('pong', { at: Date.now() }, msg.id);
        break;
      case 'error':
        this.handleBrainError(msg);
        break;
      default:
        logger.warn('remote-brain', `Ignoring unexpected ${msg.type} in ready phase`);
    }
  }

  private handleTaskUpdate(msg: WireMessage): void {
    const p = msg.payload || {};
    const state = String(p.state || 'thinking');
    const description = typeof p.description === 'string' ? p.description : undefined;
    if (this.task && this.task.id === p.taskId) {
      this.task.state = this.mapAgentState(state);
      this.emit('agent-state', { state: this.task.state, description: description ?? this.task.instruction });
    } else {
      this.emit('agent-state', { state: this.mapAgentState(state), description });
    }
  }

  private mapAgentState(remote: string): AgentState {
    switch (remote) {
      case 'planning': return 'planning';
      case 'executing': return 'executing';
      case 'observing': return 'observing';
      case 'completed': return 'completed';
      case 'interrupted': return 'error';
      case 'thinking': return 'thinking';
      case 'cancelled': return 'thinking'; // transient — the terminal CANCELLED lands via task_failed
      default: return 'thinking';
    }
  }

  private async handleTaskAction(msg: WireMessage): Promise<void> {
    const p = msg.payload || {};
    const actionId = typeof p.actionId === 'string' ? p.actionId : '';
    const taskId = typeof p.taskId === 'string' ? p.taskId : '';
    const requestId = typeof p.requestId === 'string' ? p.requestId : actionId;
    const tool = typeof p.tool === 'string' ? p.tool : '';
    const rawArgs = p.args && typeof p.args === 'object' ? p.args as Record<string, unknown> : {};
    const idempotent = p.idempotent !== false;
    const description = typeof p.description === 'string' ? p.description : `${tool} action`;
    if (!actionId || !taskId || !tool) {
      this.sendActionResult(taskId, actionId || uuidv4(), requestId, {
        taskId,
        actionId: actionId || uuidv4(),
        requestId,
        outcome: 'rejected',
        executed: false,
        replay: false,
        error: 'Malformed task_action from Brain',
      });
      return;
    }

    const req: TaskActionRequest = { taskId, actionId, requestId, action: { tool, args: rawArgs }, idempotent, description };
    const result = await this.evaluateAndExecute(req);
    this.sendActionResult(taskId, actionId, requestId, result);
  }

  /** The Body-side policy boundary. Order matters:
   * 1. capability check (tool exists + enabled)
   * 2. duplicate check (executed-action cache → replay, no re-run)
   * 3. replay safety (non-idempotent resend with no cache → rejected)
   * 4. confirmation gate (user approval)
   * 5. tool execution with retry for transient failures
   * 6. persist outcome (before sending, so a crash cannot double-run) */
  private async evaluateAndExecute(req: TaskActionRequest): Promise<ActionResult> {
    const base = {
      taskId: req.taskId,
      actionId: req.actionId,
      requestId: req.requestId,
    };

    // 1 — capability / policy.
    const tool = this.tools.getTool(req.action.tool);
    if (!tool) {
      return { ...base, outcome: 'rejected', executed: false, replay: false, error: `UNKNOWN_TOOL: ${req.action.tool}` };
    }
    if (!toolAllowedByCapabilities(this.capabilities, req.action.tool)) {
      return { ...base, outcome: 'rejected', executed: false, replay: false, error: `UNSUPPORTED_CAPABILITY: ${req.action.tool}` };
    }

    // 2 — duplicate-execution guard (the action LEDGER). Every action id
    // is recorded before it runs and finalized after; a resend after a
    // crash/reconnect can therefore never double-run a non-idempotent
    // action, and terminal entries are answered from the cache.
    const cached = this.state.getCachedAction(req.actionId);
    if (cached && cached.state === 'final') {
      logger.info('remote-brain', `Action ${req.actionId} already executed — replaying cached result`);
      return {
        ...base,
        outcome: cached.outcome,
        executed: false,
        replay: true,
        success: cached.success,
        output: cached.output,
        error: cached.error,
      };
    }
    if (cached && cached.state === 'received') {
      // The action was requested before (a crash interrupted it). If it is
      // idempotent we may safely run it again; otherwise we cannot prove
      // whether it ran, so we refuse to guess.
      if (!req.idempotent) {
        return {
          ...base, outcome: 'rejected', executed: false, replay: false,
          error: 'NON_IDEMPOTENT_UNKNOWN_STATE: this action was already requested before a restart and may have run; refusing blind replay',
        };
      }
      // Idempotent: fall through and re-run (the ledger entry is replaced
      // below on completion).
    }
    if (!cached) {
      // Record the request BEFORE executing so a crash mid-run is visible
      // on the next connection.
      this.state.markActionReceived({
        actionId: req.actionId, taskId: req.taskId, tool: req.action.tool, idempotent: req.idempotent,
      });
    }

    // 4 — confirmation gate (same policy as the local orchestrator).
    const needsConfirm = this.needsConfirmation(req);
    if (needsConfirm) {
      const approved = await this.requestConfirmation(req);
      if (!approved) {
        const denied: CachedActionResult = {
          actionId: req.actionId, taskId: req.taskId, tool: req.action.tool,
          state: 'final',
          outcome: 'denied', success: false, error: 'Action denied by user',
          executedAt: Date.now(), idempotent: req.idempotent,
        };
        this.state.cacheAction(denied);
        return { ...base, outcome: 'denied', executed: false, replay: false, error: 'Action denied by user' };
      }
    }

    // 5 — execute (with bounded retries for transient failures).
    const config = this.configOf();
    const maxRetries = Math.max(0, Math.min(MAX_ACTION_RETRIES, config.agent.maxRetries - 1));
    let result = await this.runTool(req);
    let attempts = 0;
    while (!result.success && attempts < maxRetries && this.isRetryable(result.error || '')) {
      attempts++;
      logger.info('remote-brain', `Retrying ${req.action.tool} (attempt ${attempts + 1})`);
      await this.sleep(1000 * attempts);
      result = await this.runTool(req);
    }

    // 6 — persist the outcome BEFORE returning (crash-safe dedupe).
    const cachedOutcome: CachedActionResult = {
      actionId: req.actionId,
      taskId: req.taskId,
      tool: req.action.tool,
      state: 'final',
      outcome: result.success ? 'allowed' : 'rejected',
      success: result.success,
      output: result.success ? trimTo(result.output, MAX_CACHED_OUTPUT_CHARS) : undefined,
      error: result.error ? trimTo(result.error, MAX_CACHED_OUTPUT_CHARS) : undefined,
      executedAt: Date.now(),
      idempotent: req.idempotent,
    };
    this.state.cacheAction(cachedOutcome);

    this.recordStep(req, result);
    return {
      ...base,
      outcome: result.success ? 'allowed' : 'rejected',
      executed: true,
      replay: false,
      success: result.success,
      output: result.success ? trimTo(result.output, MAX_OUTPUT_TO_BRAIN) : undefined,
      error: result.error ? trimTo(result.error, MAX_OUTPUT_TO_BRAIN) : undefined,
    };
  }

  private needsConfirmation(req: TaskActionRequest): boolean {
    const config = this.configOf();
    if (!config.agent.requireConfirmation) return false;
    if (this.tools.requiresConfirmation(req.action.tool, req.action.args)) return true;
    if (req.action.tool === 'terminal') {
      const cmd = String((req.action.args.command as string) || '');
      return matchesAnyPattern(cmd, config.agent.confirmationPatterns);
    }
    return false;
  }

  private requestConfirmation(req: TaskActionRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (approved: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingConfirmations.delete(req.actionId);
        resolve(approved);
      };
      this.pendingConfirmations.set(req.actionId, settle);
      const actionJson = JSON.stringify({ tool: req.action.tool, args: req.action.args });
      this.emit('confirmation-required', {
        taskId: req.taskId,
        stepId: req.actionId,
        description: `Execute ${req.action.tool}: ${req.description}`,
        action: actionJson,
      });
      const timer = setTimeout(() => {
        logger.warn('remote-brain', `Confirmation for ${req.actionId} timed out, denying by default`);
        settle(false);
      }, CONFIRMATION_TIMEOUT_MS);
    });
  }

  private async runTool(req: TaskActionRequest): Promise<ToolResult> {
    if (this.task && this.task.id === req.taskId) {
      const existing = this.task.steps.find((s) => s.id === req.actionId);
      if (!existing) {
        this.task.steps.push({
          id: req.actionId,
          description: req.description,
          toolName: req.action.tool,
          toolArgs: req.action.args,
          state: 'executing',
        } as TaskStep);
        this.task.currentStep = this.task.steps.length;
      }
      this.task.state = 'executing';
      this.emit('agent-state', { state: 'executing', description: req.description });
    }
    this.emit('tool-execution', { toolName: req.action.tool, args: req.action.args, state: 'executing', stepId: req.actionId });
    return this.tools.execute(req.action.tool, req.action.args);
  }

  private recordStep(req: TaskActionRequest, result: ToolResult): void {
    const step = this.task?.steps.find((s) => s.id === req.actionId);
    if (step) {
      step.state = result.success ? 'completed' : 'failed';
      step.result = result.output?.slice(0, 1000);
      step.error = result.error;
    }
    this.emit('tool-execution', {
      toolName: req.action.tool,
      args: req.action.args,
      state: result.success ? 'completed' : 'failed',
      result: result.output?.slice(0, 500),
      error: result.error,
      stepId: req.actionId,
    });
    if (this.task) {
      this.emit('task-progress', { ...this.task, steps: [...this.task.steps] });
    }
  }

  private sendActionResult(taskId: string, actionId: string, requestId: string, result: ActionResult): void {
    this.link.sendAs('action_result', {
      taskId,
      actionId,
      requestId,
      outcome: result.outcome,
      executed: result.executed,
      replay: result.replay,
      success: result.success === true,
      output: result.output,
      error: result.error,
    });
  }

  private handleTaskComplete(msg: WireMessage): void {
    const p = msg.payload || {};
    const taskId = typeof p.taskId === 'string' ? p.taskId : '';
    const summary = typeof p.summary === 'string' ? p.summary : '';
    if (this.task && this.task.id === taskId) {
      this.task.state = 'completed';
      this.task.endTime = Date.now();
      const finalMsg = {
        id: uuidv4(),
        role: 'assistant' as const,
        content: budgetAssistantMessage(summary || 'Task completed.'),
        timestamp: Date.now(),
      };
      this.emit('agent-message', finalMsg);
      this.emit('agent-state', { state: 'completed', description: 'Task completed' });
      this.emit('task-complete', { taskId, kind: 'remote', modelCalls: 0, toolCalls: this.task.steps.length });
    }
  }

  private handleTaskFailed(msg: WireMessage): void {
    const p = msg.payload || {};
    const taskId = typeof p.taskId === 'string' ? p.taskId : '';
    const error = typeof p.error === 'string' ? p.error : 'The Brain could not complete the task';
    const code = typeof p.code === 'string' ? p.code : 'TASK_FAILED';
    if (this.task && this.task.id === taskId) {
      this.task.state = 'error';
      this.task.error = error;
      this.task.endTime = Date.now();
      if (code === 'CANCELLED') {
        this.emit('agent-state', { state: 'idle', description: 'Task stopped' });
      } else {
        this.emit('error', { message: error, code });
        this.emit('agent-state', { state: 'error', description: error });
      }
    }
  }

  private clearTask(reason: string): void {
    this.task = null;
    for (const [, resolve] of this.pendingConfirmations) resolve(false);
    this.pendingConfirmations.clear();
    this.emit('agent-state', { state: 'idle', description: reason });
  }

  private isRetryable(error: string): boolean {
    const retryable = ['timeout', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'network', 'temporary', 'EPIPE'];
    return retryable.some((r) => error.toLowerCase().includes(r));
  }

  private isLoopbackUrl(): boolean {
    try {
      const h = new URL(this.link.url).hostname.toLowerCase();
      return h === 'localhost' || /^127\./.test(h) || h === '::1';
    } catch {
      return false;
    }
  }

  private emit(event: string, data: any): void {
    if (this.eventCallback) this.eventCallback(event, data);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

function trimTo(text: string | undefined, max: number): string | undefined {
  if (!text) return text;
  return text.length > max ? text.slice(0, max) : text;
}
