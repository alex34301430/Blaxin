// BLAXIN permission grants
// =============================================================
// When the user approves a high-impact action they may scope the approval:
//   once    — this single action (default; nothing is remembered)
//   task    — any matching action for the remainder of the current task
//   session — any matching action for the rest of this server session
// Grants are keyed by an action class (permissionKey), stored in memory
// only, and never persisted. A grant only ever makes a step *skip the
// confirmation prompt* — the Body's capability/policy layer still runs.
// =============================================================

import { GrantScope, PermissionScope } from '../types.js';

/**
 * The class of an action for scope-grant purposes. Grants never blanket
 * the whole session: they are scoped to a tool, and to the operation for
 * filesystem (so approving "delete" never auto-approves "write").
 */
export function permissionKey(tool: string, args: Record<string, unknown>): string {
  if (tool === 'filesystem') {
    return `filesystem:${String(args.operation || '')}`;
  }
  return tool;
}

export interface Grant {
  scope: 'ALLOW_TASK' | 'ALLOW_SESSION';
  /** Task id that granted/owns an ALLOW_TASK grant. */
  taskId?: string;
  at: number;
}

/** In-memory store of scope grants (never persisted, never logged). */
export class PermissionGrants {
  private grants = new Map<string, Grant>();

  /**
   * Effective scope for an action, or null when the user must be asked.
   * ALLOW_TASK grants only apply while their owning task is active.
   */
  effectiveFor(key: string, currentTaskId?: string): 'ALLOW_TASK' | 'ALLOW_SESSION' | null {
    const g = this.grants.get(key);
    if (!g) return null;
    if (g.scope === 'ALLOW_TASK' && g.taskId !== currentTaskId) return null;
    return g.scope;
  }

  /** Remember an approval. session grants replace task grants for the key. */
  grant(key: string, scope: GrantScope, taskId?: string): void {
    if (scope === 'once') return; // nothing to remember
    const stored: Grant = {
      scope: scope === 'task' ? 'ALLOW_TASK' : 'ALLOW_SESSION',
      at: Date.now(),
    };
    if (scope === 'task') stored.taskId = taskId;
    this.grants.set(key, stored);
  }

  /** Drop ALLOW_TASK grants owned by a finished task. */
  clearTask(taskId: string | undefined): void {
    if (!taskId) return;
    for (const [key, g] of this.grants) {
      if (g.scope === 'ALLOW_TASK' && g.taskId === taskId) this.grants.delete(key);
    }
  }

  /** Drop everything (clear-history / reset). */
  clearAll(): void {
    this.grants.clear();
  }

  size(): number {
    return this.grants.size;
  }
}