// Skill runtime (§13/§14/§15) — DISCOVER / SELECT / COMPOSE + orchestrator
// integration. Proves:
//   - skills are SELECTED BY THE CURRENT OBJECTIVE (never a static dump)
//   - only relevant skills enter the model context, under the hard budget
//   - selection failure degrades to no skills WITHOUT breaking the task
//   - selections are observable at runtime (skills-selected event +
//     AgentTask.skillsSelected)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SkillRegistry } from '../../skills/registry.js';
import { AgentOrchestrator } from '../../orchestrator/index.js';
import { buildFakes, FakeProvider } from '../helpers/orchestrator-fakes.js';

// ── Fixture library ──────────────────────────────────────────────

function writeSkill(dir: string, id: string, name: string, description: string, triggers: string[], body = `# ${name}\n\n${description}\n`): void {
  mkdirSync(join(dir, id), { recursive: true });
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `triggers: ${triggers.join(', ')}`,
    '---',
  ].join('\n');
  writeFileSync(join(dir, id, 'SKILL.md'), `${fm}\n${body}\n`);
}

let libDir: string;

beforeAll(() => {
  libDir = mkdtempSync(join(tmpdir(), 'blaxin-skills-'));
  writeSkill(libDir, 'browser-operator', 'browser-operator', 'Drive the real browser with grounded clicks.', ['browser', 'click', 'navigate']);
  writeSkill(libDir, 'computer-use', 'computer-use', 'High-reliability real desktop and browser computer-use.', ['computer', 'desktop', 'youtube', 'play']);
  writeSkill(libDir, 'memory-engine', 'memory-engine', 'Remember durable facts and lessons.', ['remember', 'memory']);
  writeSkill(libDir, 'deep-reasoning', 'deep-reasoning', 'Multi-step analytical reasoning for hard problems.', ['analyze', 'reason', 'plan']);
});

afterAll(() => {
  rmSync(libDir, { recursive: true, force: true });
});

// ── Registry: selection is objective-driven ──────────────────────

describe('SkillRegistry — selection by the current objective', () => {
  it('discovers every SKILL.md in the library', () => {
    const reg = new SkillRegistry(libDir);
    expect(reg.discover()).toBe(4);
    expect(reg.list().map((s) => s.id).sort()).toEqual(['browser-operator', 'computer-use', 'deep-reasoning', 'memory-engine']);
  });

  it('selects skills relevant to the objective (trigger + name signals)', () => {
    const reg = new SkillRegistry(libDir);
    reg.discover();
    const sel = reg.matchSkills('play thunderstruck on youtube and verify playback');
    expect(sel.length).toBeGreaterThan(0);
    expect(sel[0].skill.id).toBe('computer-use');
    expect(sel[0].reason).toContain('trigger');
  });

  it('a different objective selects DIFFERENT skills (not a static set)', () => {
    const reg = new SkillRegistry(libDir);
    reg.discover();
    const browserSel = reg.matchSkills('open the browser and navigate to github');
    const memorySel = reg.matchSkills('remember that the deploy key rotates monthly');
    expect(browserSel[0]?.skill.id).toBe('browser-operator');
    expect(memorySel[0]?.skill.id).toBe('memory-engine');
    expect(browserSel.map((s) => s.skill.id)).not.toEqual(memorySel.map((s) => s.skill.id));
  });

  it('returns nothing for an objective no skill matches', () => {
    const reg = new SkillRegistry(libDir);
    reg.discover();
    expect(reg.matchSkills('order a pizza with extra cheese')).toEqual([]);
  });

  it('ranks: higher score first, capped at maxSkills', () => {
    const reg = new SkillRegistry(libDir, 4000);
    reg.discover();
    const sel = reg.matchSkills('use the computer to open the browser and click through youtube', 2);
    expect(sel.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < sel.length; i++) {
      expect(sel[i - 1].score).toBeGreaterThanOrEqual(sel[i].score);
    }
  });
});

// ── Registry: composition is bounded and relevant-only ───────────

describe('SkillRegistry — context composition under the budget', () => {
  it('composes ONLY the selected skills into the context', () => {
    const reg = new SkillRegistry(libDir, 4000);
    reg.discover();
    const { context, selected } = reg.buildSkillContext('open the browser and navigate to github');
    expect(selected.map((s) => s.skill.id)).toContain('browser-operator');
    expect(context).toContain('browser-operator');
    expect(context).not.toContain('memory-engine');
    expect(context).toContain('RELEVANT SKILLS');
  });

  it('enforces the hard character budget (largest budget = largest context)', () => {
    const small = new SkillRegistry(libDir, 400);
    const large = new SkillRegistry(libDir, 40000);
    small.discover();
    large.discover();
    const objective = 'use the computer to open the browser and click through youtube';
    const s = small.buildSkillContext(objective);
    const l = large.buildSkillContext(objective);
    expect(s.context.length).toBeLessThanOrEqual(400);
    expect(l.context.length).toBeGreaterThan(s.context.length);
  });

  it('empty selection composes an empty context (no skill-stuffing)', () => {
    const reg = new SkillRegistry(libDir);
    reg.discover();
    const { context, selected } = reg.buildSkillContext('order a pizza with extra cheese');
    expect(selected).toEqual([]);
    expect(context).toBe('');
  });

  it('a missing library degrades to zero skills, not a crash', () => {
    const reg = new SkillRegistry(join(libDir, 'does-not-exist'));
    expect(reg.discover()).toBe(0);
    expect(reg.matchSkills('open youtube')).toEqual([]);
  });
});

// ── Orchestrator integration ─────────────────────────────────────

interface Ev { event: string; data: any }

function makeOrchestrator(registry: SkillRegistry, events: Ev[]) {
  const fakes = buildFakes();
  const provider = fakes.providers.getProvider() as FakeProvider;
  provider.script.push({ content: 'Done.' });
  const orch = new AgentOrchestrator({
    providers: fakes.providers,
    toolRegistry: fakes.tools,
    sessionState: fakes.session,
    memoryStore: fakes.memory,
    getConfig: () => fakes.config,
    skillRegistry: registry,
  });
  orch.setEventCallback((event, data) => events.push({ event, data }));
  return { orch, fakes };
}

describe('Orchestrator skill-runtime integration', () => {
  it('relevant skills reach the MODEL system prompt for the objective', async () => {
    const reg = new SkillRegistry(libDir);
    reg.discover();
    const events: Ev[] = [];
    const { orch } = makeOrchestrator(reg, events);

    await orch.processMessage('open the browser and navigate to github');

    const provider = (orch as unknown as { deps: { providers: { getProvider(): FakeProvider } } }).deps.providers.getProvider();
    const system = provider.lastMessages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system!.content).toContain('RELEVANT SKILLS');
    expect(system!.content).toContain('browser-operator');
    expect(system!.content).not.toContain('memory-engine');
  });

  it('selection re-runs per task: the next task gets ITS OWN skills', async () => {
    const reg = new SkillRegistry(libDir);
    reg.discover();
    const events: Ev[] = [];
    const { orch } = makeOrchestrator(reg, events);

    await orch.processMessage('open the browser and navigate to github');
    await orch.processMessage('remember that the deploy key rotates monthly');

    // Selections are scoped to their run (cleared on settle — honest),
    // so the per-task trail is the OBSERVABLE event stream: run 1
    // selected browser skills, run 2 selected memory skills.
    const selEvents = events.filter((e) => e.event === 'skills-selected');
    expect(selEvents).toHaveLength(2);
    expect(selEvents[0].data.skills.map((s: { id: string }) => s.id)).toContain('browser-operator');
    expect(selEvents[0].data.skills.map((s: { id: string }) => s.id)).not.toContain('memory-engine');
    expect(selEvents[1].data.skills.map((s: { id: string }) => s.id)).toContain('memory-engine');
    expect(selEvents[1].data.skills.map((s: { id: string }) => s.id)).not.toContain('browser-operator');
    // After the final settle there is no current task — no stale skills.
    expect(orch.getCurrentSkills()).toEqual([]);
  });

  it('no matching skill injects nothing into the prompt', async () => {
    const reg = new SkillRegistry(libDir);
    reg.discover();
    const events: Ev[] = [];
    const { orch } = makeOrchestrator(reg, events);

    await orch.processMessage('order a pizza with extra cheese');

    const provider = (orch as unknown as { deps: { providers: { getProvider(): FakeProvider } } }).deps.providers.getProvider();
    const system = provider.lastMessages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system!.content).not.toContain('RELEVANT SKILLS');
    expect(orch.getCurrentSkills()).toEqual([]);
  });

  it('a THROWING registry degrades to no skills and the task still completes', async () => {
    const exploding = new SkillRegistry(libDir);
    exploding.discover();
    (exploding as unknown as { buildSkillContext: () => never }).buildSkillContext = () => {
      throw new Error('registry exploded');
    };

    const events: Ev[] = [];
    const { orch } = makeOrchestrator(exploding, events);

    await expect(orch.processMessage('open the browser and navigate to github')).resolves.toBeUndefined();

    // The task still completed through the normal agent loop.
    const states = events.filter((e) => e.event === 'agent-state').map((e) => e.data.state);
    expect(states).toContain('completed');
    // Honest degradation: zero skills, no fabricated selections.
    expect(orch.getCurrentSkills()).toEqual([]);

    const provider = (orch as unknown as { deps: { providers: { getProvider(): FakeProvider } } }).deps.providers.getProvider();
    const system = provider.lastMessages.find((m) => m.role === 'system');
    expect(system!.content).not.toContain('RELEVANT SKILLS');
  });

  it('selections are OBSERVABLE: skills-selected event + task binding', async () => {
    const reg = new SkillRegistry(libDir);
    reg.discover();
    const events: Ev[] = [];
    const { orch } = makeOrchestrator(reg, events);

    await orch.processMessage('open the browser and navigate to github');

    const selEvent = events.find((e) => e.event === 'skills-selected');
    expect(selEvent).toBeDefined();
    expect(Array.isArray(selEvent!.data.skills)).toBe(true);
    expect(selEvent!.data.skills.map((s: { id: string }) => s.id)).toContain('browser-operator');
    // Every selection carries its real match reason (no opaque picks).
    for (const s of selEvent!.data.skills) {
      expect(typeof s.score).toBe('number');
      expect(typeof s.reason).toBe('string');
    }

    // task-progress at selection time carries the real binding.
    const progress = events.filter((e) => e.event === 'task-progress');
    const withSkills = progress.find((e) => Array.isArray(e.data.skillsSelected) && e.data.skillsSelected.length > 0);
    expect(withSkills).toBeDefined();
    expect(withSkills!.data.skillsSelected[0].id).toBe('browser-operator');
    expect(withSkills!.data.skillsSelected[0].reason).toBeTruthy();
  });

  it('no selection emits no skills-selected event (no noise)', async () => {
    const reg = new SkillRegistry(libDir);
    reg.discover();
    const events: Ev[] = [];
    const { orch } = makeOrchestrator(reg, events);

    await orch.processMessage('order a pizza with extra cheese');

    expect(events.find((e) => e.event === 'skills-selected')).toBeUndefined();
  });
});

// ── REAL library semantics (regression guard) ────────────────────
// The shipped .agents/skills library is prose-only: no frontmatter
// `triggers`. Selection must still work there (domain-keyword layer)
// — these tests run against the REAL default registry, not fixtures.

describe('Real 39-skill library (default registry singleton)', () => {
  it('selects browser skills for a browser objective from a prose-only library', async () => {
    const { skillRegistry } = await import('../../skills/registry.js');
    skillRegistry.discover();
    const sel = skillRegistry.matchSkills('open the browser and navigate to github');
    expect(sel.length).toBeGreaterThan(0);
    expect(sel[0].skill.id).toBe('browser-operator');
    // Reason is inspectable and names the real signal.
    expect(sel[0].reason).toContain('domain');
  });

  it('an objective outside every skill domain selects NOTHING (no stuffing)', async () => {
    const { skillRegistry } = await import('../../skills/registry.js');
    skillRegistry.discover();
    expect(skillRegistry.matchSkills('list the contents of /tmp')).toEqual([]);
    expect(skillRegistry.matchSkills('order a pizza with extra cheese')).toEqual([]);
  });
});
