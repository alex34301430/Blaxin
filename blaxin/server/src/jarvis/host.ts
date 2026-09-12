// BLAXIN Jarvis Host Wiring
// =============================================================
// Connects the JarvisEngine to the REAL execution path. This module
// owns the wiring but none of the machinery: the event source, the
// execution entry point and the emitter are all passed in — the queue,
// scheduler, missions and orchestrator are never duplicated.
// =============================================================

import { logger } from '../utils/logger.js';
import { JarvisEngine, type JarvisCommand } from './engine.js';
import type { JarvisDirective } from './types.js';

export interface JarvisHostDeps {
  /** Real agent event source (the orchestrator's event callback). */
  events: { on(listener: (event: string, data: any) => void): void };
  /**
   * Execution seam. For standard/fast directives the host routes
   * through queue→scheduler→orchestrator; for mission directives it
   * creates a persistent mission. Provided by index.ts.
   */
  executeGoal: (directive: JarvisDirective) => { taskId: string };
  /** Whether the agent has conversation history (enables follow-ups). */
  hasConversationHistory?: () => boolean;
  /** Broadcast to all WS clients (the existing broadcast()). */
  emit: (event: string, data: unknown) => void;
}

export interface JarvisHost {
  engine: JarvisEngine;
  /** Receive a user command (text or voice) — the single intake point. */
  receiveCommand: (command: JarvisCommand) => { directive: JarvisDirective; taskId: string };
  /** Snapshot sent on WS connect (never stale HUD state). */
  snapshot: () => unknown;
}

export function createJarvisHost(deps: JarvisHostDeps): JarvisHost {
  const engine = new JarvisEngine({
    events: deps.events,
    executeGoal: deps.executeGoal,
    hasConversationHistory: deps.hasConversationHistory,
  });

  // Jarvis phase/report transitions broadcast to every HUD client.
  engine.onChange((snapshot) => {
    try {
      deps.emit('jarvis-state', snapshot);
    } catch (error: any) {
      logger.warn('jarvis', `jarvis-state broadcast failed: ${error.message}`);
    }
  });

  return {
    engine,
    receiveCommand: (command: JarvisCommand) => {
      const result = engine.receiveCommand(command);
      // Real routing decision as a first-class event (HUD terminal).
      deps.emit('jarvis-event', {
        kind: 'directive-issued',
        directiveId: result.directive.id,
        taskId: result.taskId,
        complexity: result.directive.complexity,
        reason: result.directive.reason,
        source: result.directive.source,
        goal: result.directive.goal.slice(0, 200),
      });
      return result;
    },
    snapshot: () => engine.snapshot(),
  };
}
