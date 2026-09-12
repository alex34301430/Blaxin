// BLAXIN Jarvis Scheduler
// =============================================================
// Coordination layer between the TaskQueue, the Missions store and
// the agent orchestrator. The scheduler is the SINGLE path that
// feeds work to the orchestrator (embedded mode): queue tasks run
// one at a time, real task-complete events settle them, and mission
// steps advance only on verified completion (checkpoints).
//
// State truthfulness:
//   - a task is 'running' only while the orchestrator actually runs it
//   - completion/failure/cancellation is derived from REAL agent-state
//     transitions, never guessed
//   - missions resume from the first pending step (completed steps
//     keep checkpoints and are never re-executed)
// =============================================================

import { TaskQueue, QueueTask } from './task-queue.js';
import { MissionStore } from './missions.js';
import { logger } from './logger.js';

export interface SchedulerOrchestratorLike {
  isBusy(): boolean;
  processMessage(message: string): Promise<void>;
  stop(): void;
  clearHistory(): void;
  /** Optional Jarvis directive context for the task about to run. */
  setDirectiveContext?(directive: unknown | null): void;
}

export interface SchedulerDeps {
  queue: TaskQueue;
  missions: MissionStore;
  orchestrator: SchedulerOrchestratorLike;
  emit: (event: string, data: unknown) => void;
}

export class JarvisScheduler {
  private readonly queue: TaskQueue;
  private readonly missions: MissionStore;
  private readonly orchestrator: SchedulerOrchestratorLike;
  private readonly emit: (event: string, data: unknown) => void;

  /** Queue task id currently being executed by the orchestrator. */
  private runningTaskId: string | null = null;
  /** Last real agent-state seen while a task was running. */
  private lastState: string = 'idle';

  constructor(deps: SchedulerDeps) {
    this.queue = deps.queue;
    this.missions = deps.missions;
    this.orchestrator = deps.orchestrator;
    this.emit = deps.emit;

    this.queue.onChange((tasks) => this.emit('queue-updated', { tasks }));
    this.missions.onChange((missions) => this.emit('mission-progress', { missions }));
  }

  /** Feed a user request into the queue (the only entry point). */
  enqueueUserMessage(message: string, opts: { priority?: number } = {}): QueueTask {
    const task = this.queue.enqueue({
      objective: message,
      priority: opts.priority,
    });
    this.pump();
    return task;
  }

  /** Handle an orchestrator event (wired by index.ts). */
  onOrchestratorEvent(event: string, data: any): void {
    if (event === 'agent-state' && data?.state) {
      this.lastState = data.state;
    }
    if (event === 'task-complete') {
      this.onTaskComplete(data);
    }
  }

  private onTaskComplete(data: any): void {
    const id = this.runningTaskId;
    if (!id) return;
    this.runningTaskId = null;

    const task = this.queue.get(id);
    if (!task) return;

    // The last real agent-state decides the outcome: completed /
    // error / idle (stopped by the user). Never guess.
    const state = this.lastState;
    const result = data?.kind === 'direct'
      ? `Fast-path task done in ${data.totalMs}ms (${data.toolCalls ?? 0} tool call(s))`
      : `Task done in ${data.totalMs}ms (${data.modelCalls ?? 0} model call(s), ${data.toolCalls ?? 0} tool call(s))`;

    if (state === 'error') {
      this.queue.markFailed(id, 'The agent reported an error while executing this task');
      if (task.missionId && task.missionStepId) {
        this.missions.settleStep(task.missionId, task.missionStepId, {
          success: false,
          error: 'Agent task failed',
        });
      }
    } else if (state === 'idle') {
      this.queue.cancel(id);
      if (task.missionId && task.missionStepId) {
        this.missions.settleStep(task.missionId, task.missionStepId, {
          success: false,
          error: 'Task cancelled by user',
        });
      }
    } else {
      this.queue.markCompleted(id, result);
      if (task.missionId && task.missionStepId) {
        this.missions.settleStep(task.missionId, task.missionStepId, {
          success: true,
          result,
        });
      }
    }

    this.pump();
  }

  /**
   * Start the next unit of work when nothing is running: first advance
   * queued missions (each enqueues its next pending step), then run the
   * highest-priority eligible queue task.
   */
  pump(): void {
    if (this.runningTaskId) return;
    if (this.orchestrator.isBusy()) return;

    // 1) Advance missions that have work to do: enqueue their next
    //    pending step. Paused/terminal missions never auto-advance, and
    //    a step that is already in flight is never duplicated.
    for (const mission of this.missions.list()) {
      if (mission.status === 'paused' ||
          mission.status === 'completed' ||
          mission.status === 'failed' ||
          mission.status === 'cancelled') continue;
      if (mission.steps.some((s) => s.status === 'running')) continue; // step already in flight
      const started = this.missions.startOrResume(mission.id);
      if (!started) continue;
      const { step } = started;
      this.queue.enqueue({
        objective: step.description,
        priority: mission.priority,
        missionId: mission.id,
        missionStepId: step.id,
      });
    }

    // 2) Run the next eligible queue task.
    const next = this.queue.nextEligible();
    if (!next) return;
    this.queue.markRunning(next.id);
    this.runningTaskId = next.id;
    this.lastState = 'planning';
    this.emit('scheduler', { runningTaskId: next.id });
    logger.info('scheduler', `Running queue task ${next.id}: ${next.objective.slice(0, 80)}`);
    // Attach the directive context that traveled with THIS queue task
    // (or null — a mission step / plain enqueue never inherits a stale
    // directive from an earlier task).
    this.orchestrator.setDirectiveContext?.(next.directive ?? null);
    this.orchestrator.processMessage(next.objective).catch((error: any) => {
      logger.error('scheduler', `Queue task ${next.id} failed to start: ${error.message}`);
    });
  }

  /** Stop the currently running work (honored at the next loop boundary). */
  stop(): void {
    this.orchestrator.stop();
  }

  clearHistory(): void {
    this.orchestrator.clearHistory();
  }
}