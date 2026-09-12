// BLAXIN skill registry — the 39-skill library as a REAL runtime system (§13/§14/§15)
// =============================================================
// The .agents/skills/ library was documentation-only: 39 skills on disk,
// ZERO runtime integration. This module makes the library first-class:
//
//   DISCOVER   every skill's SKILL.md is parsed (name/description/triggers)
//   SELECT     matchSkills() ranks skills against the task objective —
//              the objective's words vs skill names/descriptions/triggers
//   COMPOSE    buildSkillContext() renders ONLY the selected skills,
//              under a hard character budget (no skill-stuffing: §14
//              forbids injecting every skill into every context)
//   AUDIT      selection reasons are carried so the choice is inspectable
// The registry affects EXECUTION: the orchestrator appends the composed
// context to its system prompt for every model call.
// =============================================================

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { logger } from '../utils/logger.js';

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  path: string;
}

export interface SkillSelection {
  skill: SkillMeta;
  score: number;
  reason: string;
}

/** Frontmatter + body parse (no YAML dependency — the format is flat). */
function parseSkillMd(raw: string): { name: string; description: string; triggers: string[]; body: string } {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  const meta: Record<string, string> = {};
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
    }
  }
  const triggers = (meta.triggers ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return { name: meta.name ?? '', description: meta.description ?? '', triggers, body: raw };
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * DOMAIN KEYWORD INDEX — the deterministic router layer for skill
 * libraries whose SKILL.md files carry no machine-readable `triggers`
 * (the shipped 39-skill library is prose-only). High-precision domain
 * words map to the skills that genuinely execute them. Frontmatter
 * `triggers`, when a library provides them, remain the strongest signal.
 * Selection stays inspectable: every keyword hit is reported in the
 * selection reason.
 */
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  'computer-use': ['youtube', 'video', 'playback', 'desktop'],
  'browser-operator': ['browser', 'navigate', 'website', 'url'],
  'browser-session-sync': ['browser', 'session'],
  'adaptive-scroll': ['scroll'],
  'semantic-clicking': ['click'],
  'screen-perception': ['screenshot', 'screen'],
  'memory-engine': ['remember', 'recall', 'memory'],
  'episodic-memory': ['remember', 'recall', 'history'],
  'failure-memory': ['lesson', 'failure'],
  recovery: ['recover', 'retry'],
  'debugging-and-error-recovery': ['debug', 'recover'],
  'popup-modal-recovery': ['popup', 'modal', 'dialog'],
  'barge-in-control': ['voice', 'interrupt'],
  'voice-agent': ['voice', 'speak', 'microphone'],
  'mission-control': ['mission'],
  'task-planner': ['mission', 'plan'],
  'deep-reasoning': ['analyze', 'reason', 'plan'],
  verification: ['verify', 'evidence'],
  'temporal-verification': ['verify', 'later', 'persist'],
  'test-engineering': ['test'],
  'browser-testing': ['browser', 'test'],
  'secret-redaction': ['secret', 'password', 'credential', 'token'],
  'secure-persistence': ['secret', 'credential', 'store'],
  'performance-engineering': ['benchmark', 'performance', 'latency'],
  'natural-language-reporting': ['report', 'summarize'],
  'result-synthesis': ['summarize', 'synthesis'],
  'parallel-execution': ['parallel', 'concurrently'],
  'intent-understanding': ['intent'],
  'agent-router': ['intent', 'route'],
  'security-guardian': ['security', 'permission'],
  'worker-lifecycle': ['worker', 'spawn'],
  'visual-grounding': ['click', 'target'],
  'codebase-understanding': ['codebase', 'code'],
  'context-management': ['context', 'budget'],
  'environment-memory': ['environment', 'layout'],
  'procedural-memory': ['procedure', 'workflow'],
  'skill-learning': ['skill', 'learn'],
  'agent-orchestration': ['orchestrate', 'coordinate'],
  'specialist-selection': ['specialist', 'expert'],
};

export class SkillRegistry {
  private skills = new Map<string, SkillMeta>();
  private bodies = new Map<string, string>();

  constructor(
    private readonly skillsDir: string,
    private readonly budgetChars = 4000,
  ) {}

  /** DISCOVER: scan the skills directory. Safe to re-run. */
  discover(): number {
    this.skills.clear();
    this.bodies.clear();
    if (!existsSync(this.skillsDir)) {
      logger.warn('skills', `Skills directory missing: ${this.skillsDir}`);
      return 0;
    }
    let count = 0;
    for (const entry of readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(this.skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(file)) continue;
      try {
        const parsed = parseSkillMd(readFileSync(file, 'utf8'));
        const id = parsed.name || entry.name;
        this.skills.set(id, {
          id,
          name: parsed.name || entry.name,
          description: parsed.description || '',
          triggers: parsed.triggers,
          path: file,
        });
        this.bodies.set(id, parsed.body);
        count++;
      } catch (e: any) {
        logger.warn('skills', `Failed to parse ${file}: ${e?.message ?? e}`);
      }
    }
    logger.info('skills', `Discovered ${count} skills from ${this.skillsDir}`);
    return count;
  }

  list(): SkillMeta[] {
    return [...this.skills.values()];
  }

  get(id: string): SkillMeta | undefined {
    return this.skills.get(id);
  }

  /** Full body for an explicitly-loaded skill (bounded). */
  loadBody(id: string, maxChars = 4000): string | null {
    const body = this.bodies.get(id);
    return body ? body.slice(0, maxChars) : null;
  }

  /**
   * SELECT: rank skills against the objective. Every score carries its
   * reason — no opaque selection. Deterministic (pure functions).
   */
  matchSkills(objective: string, maxSkills = 4): SkillSelection[] {
    const obj = norm(objective);
    if (!obj || this.skills.size === 0) return [];
    const objWords = new Set(obj.split(' ').filter((w) => w.length > 2));
    const scored: SkillSelection[] = [];

    for (const skill of this.skills.values()) {
      let score = 0;
      const reasons: string[] = [];
      const nameWords = new Set(norm(skill.name).split(' ').filter(Boolean));
      const descWords = new Set(norm(skill.description).split(' ').filter(Boolean));

      // Trigger phrase containment — the strongest signal.
      for (const trig of skill.triggers) {
        if (trig && obj.includes(trig)) {
          score += 0.45;
          reasons.push(`trigger "${trig}"`);
        }
      }
      // Domain keywords (deterministic router layer — see DOMAIN_KEYWORDS).
      // Each hit is a real word from the objective mapping to this skill's
      // execution domain; capped so keyword spam cannot dominate.
      const kwHits = (DOMAIN_KEYWORDS[skill.id] ?? [])
        .filter((kw) => new RegExp(`\\b${kw}\\b`).test(obj))
        .slice(0, 3);
      if (kwHits.length) {
        score += 0.2 * kwHits.length;
        reasons.push(`domain (${kwHits.join(', ')})`);
      }
      // Name-word overlap with the objective.
      const nameHits = [...nameWords].filter((w) => objWords.has(w) && w.length > 2);
      if (nameHits.length) {
        score += 0.3 * nameHits.length;
        reasons.push(`name (${nameHits.join(', ')})`);
      }
      // Description-word overlap (weaker, capped).
      const descHits = [...descWords].filter((w) => objWords.has(w) && w.length > 3);
      if (descHits.length) {
        score += Math.min(0.15 * descHits.length, 0.3);
        reasons.push('description overlap');
      }
      // Whole-skill-name containment (e.g. "adaptive scroll" in text).
      if (obj.includes(norm(skill.name))) {
        score += 0.25;
        reasons.push('name contained in objective');
      }

      // Acceptance line: above weak lexical noise (a single description
      // word = 0.15), below one precise curated/lexical signal (domain
      // keyword = 0.2, name word = 0.3, trigger = 0.45).
      if (score > 0.19) {
        scored.push({ skill, score: Math.min(score, 1), reason: reasons.join(', ') || 'matched' });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSkills);
  }

  /**
   * COMPOSE: render the selected skills as operating guidance. Hard
   * budget — the highest-scored skill wins the space (§14: only relevant
   * skills enter the context).
   */
  buildSkillContext(objective: string, maxSkills = 4): { context: string; selected: SkillSelection[] } {
    const selected = this.matchSkills(objective, maxSkills);
    if (selected.length === 0) return { context: '', selected };

    const parts: string[] = [];
    let used = 0;
    for (const sel of selected) {
      const body = this.loadBody(sel.skill.id, 1800);
      if (!body) continue;
      const block = `### Skill: ${sel.skill.name}${sel.skill.description ? ` — ${sel.skill.description}` : ''}\n${body}`;
      if (used + block.length > this.budgetChars) break;
      parts.push(block);
      used += block.length;
    }
    if (parts.length === 0) return { context: '', selected };

    const context =
      `\n\nRELEVANT SKILLS (selected for this objective — follow their HARD RULES where they apply):\n` +
      parts.join('\n\n');
    return { context, selected };
  }
}

/** Default registry rooted at the repository's .agents/skills directory. */
function defaultSkillsDir(): string {
  // src/skills/ → server/src/skills → server → blaxin → .agents/skills
  const candidates = [
    resolve(process.cwd(), '.agents/skills'),
    resolve(process.cwd(), '../.agents/skills'),
    resolve(process.cwd(), '../../.agents/skills'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

export const skillRegistry = new SkillRegistry(defaultSkillsDir());
