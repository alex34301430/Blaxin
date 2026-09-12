// BLAXIN Agency Registry — REAL worker visibility (directive §5–§11)
// =============================================================
// The Agency is NOT a pool of fake parallel agents. It is the real,
// observable decomposition of the existing BLAXIN agent's work: every
// time the agent actually executes a tool, that activation is recorded
// as a WORKER with:
//   - a REAL id (the orchestrator step id — the same id used in
//     task-progress; never invented for display),
//   - a role derived from the ACTUAL tool executed (browser → BROWSER,
//     filesystem → FILES, …),
//   - a lifecycle driven exclusively by real orchestrator events.
//
// Hard no-fake guarantees:
//   - no worker exists without a real tool activation or a real
//     confirmation gate entry (a pending approval IS a real pending
//     action, identified by its real runtime step id);
//   - no status exists without a real event behind it;
//   - WAITING appears only while a real confirmation gate is pending;
//   - a stopped run really settles its workers (cancelled);
//   - no fabricated confidence, progress or results.
// =============================================================

import { logger } from '../utils/logger.js';

/** Worker lifecycle states — every transition must trace to a real event. */
export type WorkerState =
  | 'queued'
  | 'running'
  | 'waiting'    // real confirmation-required received for this step
  | 'blocked'    // reserved: task-level gating, never assigned decoratively
  | 'completed'
  | 'failed'
  | 'skipped'    // denied by the user (denied steps must stay visible)
  | 'retrying'
  | 'cancelled';

export type WorkerRole =
  | 'BROWSER' | 'COMPUTER' | 'VISION' | 'RESEARCH' | 'FILES' | 'TERMINAL'
  | 'MEMORY' | 'SYSTEM' | 'CLIPBOARD' | 'GENERAL';

/** Derive the specialist role from the ACTUAL tool that runs. */
export function roleForTool(toolName: string): WorkerRole {
  switch (toolName) {
    case 'browser':
    case 'blaxin_web':       return 'BROWSER';
    case 'computer-control': return 'COMPUTER';
    case 'vision':           return 'VISION';
    case 'search':           return 'RESEARCH';
    case 'filesystem':       return 'FILES';
    case 'terminal':         return 'TERMINAL';
    case 'memory':           return 'MEMORY';
    case 'system-info':      return 'SYSTEM';
    case 'clipboard':        return 'CLIPBOARD';
    default:                 return 'GENERAL';
  }
}

export interface WorkerRecord {
  /** REAL id — orchestrator runtime step id (or call id for legacy
   *  confirmation payloads that carry no runtimeStepId). */
  id: string;
  taskId?: string;
  role: WorkerRole;
  tool: string;
  /** False only while the tool behind a pending approval is unknown. */
  toolKnown: boolean;
  description: string;
  state: WorkerState;
  startedAt?: number;
  endedAt?: number;
  result?: string;
  error?: string;
  /** Number of REAL retry events observed for this worker. */
  attempts: number;
  /** How the step was authorized (from the orchestrator's own gate). */
  permissionScope?: string;
}

export interface AgencySnapshot {
  agentState: string;
  agentDescription: string | null;
  /** A real confirmation gate is currently pending for the active task. */
  taskWaiting: boolean;
  workers: WorkerRecord[];
  activeCount: number;
  queueWaiting: number;
  queuedTasks: Array<{ id: string; status: string; objective: string }>;
}

const ACTIVE_STATES: WorkerState[] = ['running', 'retrying', 'waiting', 'blocked'];
const SETTLED_STATES: WorkerState[] = ['completed', 'failed', 'skipped', 'cancelled'];
const MAX_WORKERS = 100;

/** Human-readable action description from the tool + real args. */
export function describeToolAction(tool: string, args?: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
  switch (tool) {
    case 'browser':
      if (s(args?.url)) return `Browser: open ${s(args?.url).slice(0, 80)}`;
      if (s(args?.query)) return `Browser: search "${s(args?.query).slice(0, 60)}"`;
      return 'Browser action';
    case 'blaxin_web': {
      const a = s(args?.action);
      if (a === 'youtube_play' && s(args?.query)) return `Browser: play "${s(args?.query).slice(0, 50)}" (verified)`;
      if (a === 'youtube_search') return `Browser: search YouTube "${s(args?.query).slice(0, 50)}"`;
      if (a === 'open') return `Browser: open ${s(args?.url).slice(0, 70)}`;
      if (a === 'click' && s(args?.target)) return `Browser: click "${s(args?.target).slice(0, 50)}"`;
      if (a === 'scroll') return 'Browser: adaptive scroll';
      return `Browser: ${a || 'action'}`;
    }
    case 'computer-control': {
      const a = s(args?.action);
      if (a === 'mouse_click' && args?.x !== undefined) return `Computer: click at (${s(args?.x)}, ${s(args?.y)})`;
      if (a === 'type_text') return 'Computer: type text';
      if (a === 'scroll' || a === 'scroll_up' || a === 'scroll_down') return 'Computer: scroll';
      return `Computer: ${a || 'action'}`;
    }
    case 'filesystem': {
      const op = s(args?.operation);
      if (op && args?.path) return `Files: ${op} ${s(args?.path).slice(0, 60)}`;
      return `Files: ${op || 'operation'}`;
    }
    case 'terminal':    return s(args?.command) ? `Terminal: ${s(args?.command).slice(0, 60)}` : 'Terminal command';
    case 'search':      return s(args?.query) ? `Search: "${s(args?.query).slice(0, 60)}"` : 'Search';
    case 'memory':      return 'Memory update';
    case 'system-info': return 'System inspection';
    case 'clipboard':   return 'Clipboard access';
    case 'vision':      return 'Vision analysis';
    default:            return 'Tool action';
  }
}

export class AgencyRegistry {
  private workers = new Map<string, WorkerRecord>();
  private agentState: string = 'idle';
  private agentDescription: string | null = null;
  private taskWaiting = false;
  private currentTaskId: string | null = null;
  private queuedTasks: Array<{ id: string; status: string; objective: string }> = [];

  constructor(private readonly onChange?: (snapshot: AgencySnapshot) => void) {}

  /** Real 'agent-state' events. */
  onAgentState(data: { state?: string; description?: string | null }): void {
    if (typeof data.state === 'string') {
      this.agentState = data.state;
      if (data.state === 'requires-confirmation') {
        this.taskWaiting = true;
      } else if (data.state === 'idle') {
        // The run really ended: anything still unsettled is cancelled,
        // and task-level waiting is over.
        this.cancelUnsettled();
        this.taskWaiting = false;
        this.currentTaskId = null;
      } else if (data.state === 'executing') {
        this.taskWaiting = false;
      }
    }
    if (data.description !== undefined) this.agentDescription = data.description ?? null;
    this.notify();
  }

  /** Real 'queue-updated' events (drives honest counts, not decoration). */
  onQueueUpdated(tasks: Array<{ id: string; status: string; objective?: string }>): void {
    this.queuedTasks = (Array.isArray(tasks) ? tasks : []).map((t) => ({
      id: String(t?.id ?? ''),
      status: String(t?.status ?? 'unknown'),
      objective: String(t?.objective ?? ''),
    }));
    this.notify();
  }

  /**
   * Real 'confirmation-required' events. `runtimeStepId` is the real
   * orchestrator step id (additive field); older payloads only carry the
   * provider call id in `stepId` — still a real identifier of a real
   * pending action, so the record stays honest either way.
   */
  onConfirmationRequired(data: { stepId?: string; runtimeStepId?: string; taskId?: string; action?: string }): void {
    const sid = String(data.runtimeStepId ?? data.stepId ?? '');
    if (!sid) return;
    // The gate payload carries the REAL action about to run — parse it
    // (safely, bounded) so the worker shows the true tool/role instead
    // of a generic unknown. Malformed payloads degrade honestly.
    let tool = 'unknown';
    let description = '';
    if (typeof data.action === 'string' && data.action.length > 0 && data.action.length < 2000) {
      try {
        const parsed = JSON.parse(data.action) as { tool?: unknown; args?: Record<string, unknown> };
        if (typeof parsed?.tool === 'string' && parsed.tool) {
          tool = parsed.tool;
          description = describeToolAction(tool, parsed.args);
        }
      } catch {
        // Malformed action payload — keep unknown, stay honest.
      }
    }
    const existing = this.workers.get(sid);
    const worker: WorkerRecord = existing ?? {
      id: sid,
      taskId: data.taskId ? String(data.taskId) : (this.currentTaskId ?? undefined),
      role: roleForTool(tool),
      tool,
      toolKnown: tool !== 'unknown',
      description: description || 'Action awaiting your approval',
      state: 'waiting',
      attempts: 0,
    };
    worker.state = 'waiting';
    if (tool !== 'unknown') {
      worker.tool = tool;
      worker.toolKnown = true;
      worker.role = roleForTool(tool);
    }
    if (description) worker.description = description;
    else if (!worker.description) worker.description = 'Action awaiting your approval';
    if (data.taskId) worker.taskId = String(data.taskId);
    this.workers.set(sid, worker);
    this.taskWaiting = true;
    this.notify();
  }

  /** Real 'tool-execution' events (the agency's heartbeat). */
  onToolExecution(data: {
    toolName?: string;
    args?: Record<string, unknown>;
    state?: string;
    stepId?: string;
    result?: string;
    error?: string;
  }): void {
    const state = data.state;
    const stepId = data.stepId ? String(data.stepId) : null;

    if (state === 'executing') {
      // Without a step id the event cannot be correlated honestly —
      // never guess.
      if (!stepId) return;
      const existing = this.workers.get(stepId);
      const worker: WorkerRecord = existing ?? {
        id: stepId,
        role: 'GENERAL',
        tool: 'unknown',
        toolKnown: false,
        description: '',
        state: 'running',
        attempts: 0,
      };
      worker.taskId = this.currentTaskId ?? worker.taskId;
      worker.role = roleForTool(String(data.toolName ?? ''));
      worker.tool = String(data.toolName ?? 'unknown');
      worker.toolKnown = true;
      worker.description = describeToolAction(worker.tool, data.args) || worker.description;
      worker.state = 'running';
      if (!worker.startedAt) worker.startedAt = Date.now();
      this.workers.set(stepId, worker);
      this.prune();
      this.notify();
      return;
    }

    if (state === 'retrying') {
      if (!stepId) return;
      const w = this.workers.get(stepId);
      if (w) {
        w.state = 'retrying';
        w.attempts += 1;
        this.notify();
      }
      return;
    }

    const settled = state === 'completed' ? 'completed' as const
      : state === 'failed' ? 'failed' as const
      : state === 'skipped' ? 'skipped' as const
      : null;
    if (settled) {
      if (!stepId) return; // uncorrelatable → never guess
      const w = this.workers.get(stepId);
      if (w) {
        w.state = settled;
        w.endedAt = Date.now();
        w.result = data.result ? String(data.result).slice(0, 300) : undefined;
        w.error = data.error ? String(data.error).slice(0, 300) : undefined;
        this.notify();
      }
    }
  }

  /** Real 'task-progress' events (task id binding). */
  onTaskProgress(data: { id?: string; state?: string }): void {
    if (data.id) this.currentTaskId = String(data.id);
    if (data.state === 'requires-confirmation') this.taskWaiting = true;
    this.notify();
  }

  /** Real 'task-complete' events. */
  onTaskComplete(data: { taskId?: string }): void {
    if (data.taskId && this.currentTaskId === String(data.taskId)) {
      this.currentTaskId = null;
    }
    this.taskWaiting = false;
    this.notify();
  }

  /** Active roster + real task/queue context for the HUD. */
  snapshot(): AgencySnapshot {
    const workers = [...this.workers.values()]
      .sort((a, b) => (b.startedAt ?? b.endedAt ?? 0) - (a.startedAt ?? a.endedAt ?? 0));
    return {
      agentState: this.agentState,
      agentDescription: this.agentDescription,
      taskWaiting: this.taskWaiting,
      workers: workers.slice(0, 20),
      activeCount: workers.filter((w) => ACTIVE_STATES.includes(w.state)).length,
      queueWaiting: this.queuedTasks.filter((t) => t.status === 'queued').length,
      queuedTasks: this.queuedTasks.slice(0, 10),
    };
  }

  /** Real stop: settle everything still active as cancelled. */
  cancelUnsettled(): void {
    let changed = false;
    for (const w of this.workers.values()) {
      if (ACTIVE_STATES.includes(w.state)) {
        w.state = 'cancelled';
        w.endedAt = Date.now();
        changed = true;
      }
    }
    if (changed) logger.info('agency', 'Unsettled workers marked cancelled by real stop');
  }

  private notify(): void {
    if (this.onChange) this.onChange(this.snapshot());
  }

  /** Keep memory bounded; settled records leave the active roster. */
  private prune(): void {
    if (this.workers.size <= MAX_WORKERS) return;
    const settled = [...this.workers.values()]
      .filter((w) => SETTLED_STATES.includes(w.state))
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const w of settled) {
      if (this.workers.size <= MAX_WORKERS) break;
      this.workers.delete(w.id);
    }
  }
}
