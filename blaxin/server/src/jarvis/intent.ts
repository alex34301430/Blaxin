// BLAXIN Jarvis — Intent Assessment
// =============================================================
// First-pass understanding of a user command. Deterministic and
// LLM-free: Jarvis routes with rules it can justify, and only the
// CONTENT of the goal is ever handed to the agent untouched.
//
// Jarvis never rewrites the user's goal. It classifies HOW to run it
// (fast path / standard loop / persistent mission) and attaches
// context. Ambiguity is delegated downward, never guessed upward.
// =============================================================

import type { CommandSource, ExecutionComplexity, RoutingReason } from './types.js';

export interface IntentAssessment {
  complexity: ExecutionComplexity;
  reason: RoutingReason;
  /** 1..5 queue priority. */
  priority: number;
  /** Concrete success condition when the request states one. */
  successCondition?: string;
  /** True when the command explicitly asks for a tracked mission. */
  missionRequested: boolean;
  /** Short explanation surfaced in the HUD (why this route). */
  note: string;
}

/**
 * Injectable assessor seam: a future LLM-backed assessor (only for
 * genuinely ambiguous routing, never for goal rewriting) can replace
 * the default without touching the engine or the orchestrator.
 */
export type IntentAssessor = (input: {
  message: string;
  source: CommandSource;
  hasConversationContext: boolean;
  lastExchange?: { request: string; outcome: string } | null;
}) => IntentAssessment | null;

// Requests that must NEVER run on the deterministic fast path even if
// they look single-tool — they name a specific target the fast path
// cannot verify. The orchestrator's own classifier re-checks the fast
// path independently; this guard only stops Jarvis from *routing* such
// commands as 'fast' when they carry explicit targets/conditions.
const TARGETED_EXECUTION = /\b(play|search (for|and)|find|click|type|press|scroll|post|publish|tweet|comment|message|send|download|upload|install|delete|remove|rename|move|copy)\b/i;

// Multi-step intent: coordination words or an explicit step sequence.
const MULTI_STEP = /\b(then|after that|and then|afterwards|finally|step \d|first .* (then|after)|while you'?re at it)\b/i;

// Long-horizon / tracked work: explicit mission language.
const MISSION_REQUEST = /\b(mission|multi-step task|long[- ]running task|background task|keep going until|don'?t stop until)\b/i;

// Verification-minded requests deserve a stated success condition.
const VERBALIZED_OUTCOME = /\b(make sure|verify|confirm|until .* (works|plays|shows|appears)|so that .*)\b/i;

// Anything asking us NOT to do something must never be routed as a
// trivial fast-path action (mirrors the orchestrator's own guard).
const NEGATION = /^(don'?t|do not|please don'?t|never|stop|not|avoid|cancel|no\b)/i;

const WAKE_WORDS = /^(hey|ok|okay)\s+(blaxin|jarvis)\b[,\s!]*/i;

/** Strip a leading wake word; voice commands may carry one. */
export function stripWakeWord(message: string): string {
  return message.replace(WAKE_WORDS, '').trim();
}

const MAX_GOAL_LENGTH = 1000;

export function defaultAssessIntent(input: {
  message: string;
  source: CommandSource;
  hasConversationContext: boolean;
  lastExchange?: { request: string; outcome: string } | null;
}): IntentAssessment {
  const message = stripWakeWord(input.message).trim();
  const lower = message.toLowerCase();

  // Negations are directives ABOUT actions, not actions — the agent
  // loop must interpret them with full context.
  if (NEGATION.test(lower)) {
    return {
      complexity: 'standard',
      reason: 'default-agent-loop',
      priority: 4,
      missionRequested: false,
      note: 'Negated/controlled instruction — full agent interpretation',
    };
  }

  // Explicit mission language wins: persistent, checkpointed work.
  if (MISSION_REQUEST.test(lower)) {
    return {
      complexity: 'mission',
      reason: 'explicit-mission-request',
      priority: 3,
      missionRequested: true,
      note: 'Mission requested — tracked, checkpointed execution',
    };
  }

  // Multi-step coordination language: mission-grade tracking is the
  // honest container (per-step checkpoints, pause/resume).
  if (MULTI_STEP.test(lower) && message.length > 40) {
    return {
      complexity: 'mission',
      reason: 'multi-step-request',
      priority: 3,
      missionRequested: true,
      note: 'Multi-step request — tracked as a mission',
    };
  }

  // A follow-up ("now do the same for X") needs conversation context,
  // which lives in the agent loop — never the one-shot fast path.
  if (input.hasConversationContext && input.lastExchange) {
    const pronounFollowUp = /\b(it|that|this|them|those|the same|also|again)\b/i.test(lower);
    if (pronounFollowUp) {
      return {
        complexity: 'standard',
        reason: 'follow-up-context',
        priority: 4,
        missionRequested: false,
        note: 'Follow-up — routed with conversation context',
      };
    }
  }

  // Targeted execution (play X, search Y, click Z): must be observed
  // and verified — the standard loop, even when it looks single-tool.
  if (TARGETED_EXECUTION.test(lower) || VERBALIZED_OUTCOME.test(lower)) {
    return {
      complexity: 'standard',
      reason: 'default-agent-loop',
      priority: 4,
      missionRequested: false,
      successCondition: extractSuccessCondition(message),
      note: 'Targeted execution — requires observation and verification',
    };
  }

  // Everything else: candidate for the deterministic fast path. The
  // orchestrator's own classifier still has final authority (it knows
  // which tools exist and re-validates); Jarvis just does not force
  // the expensive route for trivially simple commands.
  return {
    complexity: 'fast',
    reason: 'deterministic-single-tool',
    priority: 4,
    missionRequested: false,
    note: 'Simple request — fast path eligible',
  };
}

/**
 * Extract a verbalized success condition ("make sure it plays") into
 * the directive. Only when the user actually stated one — Jarvis never
 * invents conditions.
 */
function extractSuccessCondition(message: string): string | undefined {
  const match = message.match(/\b(?:make sure|verify|confirm)\s+(?:that\s+)?([^.!?]{4,160})/i);
  if (match) {
    const condition = match[1].trim();
    if (condition.length >= 4) return condition;
  }
  return undefined;
}

/** Cap a goal the way the queue caps objectives (defensive, mirrors task-queue). */
export function normalizeGoal(message: string): string {
  return stripWakeWord(message).trim().slice(0, MAX_GOAL_LENGTH);
}
