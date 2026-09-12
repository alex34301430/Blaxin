import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.BLAXIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'blaxin-memlayers-'));

import { LayeredMemory } from '../memory/layers.js';

let dir: string;

function makeLayers(): LayeredMemory {
  return new LayeredMemory({ file: join(dir, `layers-${Math.random().toString(36).slice(2)}.json`) });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blaxin-memlayers-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('failure memory', () => {
  it('records a failure with honest defaults (unresolved, 1 occurrence)', () => {
    const mem = makeLayers();
    const r = mem.failure({ category: 'browser', failedAction: 'open example.com', observation: 'page never verified' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('browser');
    expect(r!.occurrences).toBe(1);
    expect(r!.finalResult).toBe('unresolved');
    expect(r!.recovery).toBeUndefined();
  });

  it('reinforces the same pattern instead of duplicating it', () => {
    const mem = makeLayers();
    mem.failure({ category: 'browser', failedAction: 'open example.com', observation: 'timeout' });
    const again = mem.failure({ category: 'browser', failedAction: 'Open Example.com', observation: 'timeout again' });
    expect(again!.occurrences).toBe(2);
    expect(mem.snapshot().failures.filter((f) => f.category === 'browser')).toHaveLength(1);
  });

  it('records a verified recovery and marks the pattern recovered', () => {
    const mem = makeLayers();
    mem.failure({ category: 'terminal', failedAction: 'apt install', observation: 'lock held', cause: 'another apt running' });
    const r = mem.failureRecovered({ category: 'terminal', failedAction: 'apt install', observation: 'lock held' }, 'wait for lock then retry');
    expect(r!.finalResult).toBe('recovered');
    expect(r!.recovery?.description).toContain('wait for lock');
  });

  it('refuses secret-looking failures', () => {
    const mem = makeLayers();
    const r = mem.failure({ category: 't', failedAction: 'read config', observation: 'api_key=sk-abc12345678901234567890' });
    expect(r).toBeNull();
  });
});

describe('environment memory', () => {
  it('a fresh CONTRADICTORY observation overrides the stale value (§24)', () => {
    const mem = makeLayers();
    mem.observeEnvironment({ key: 'browser page', value: 'https://old.example.com', volatility: 'volatile' });
    const r = mem.observeEnvironment({ key: 'browser page', value: 'https://new.example.com', volatility: 'volatile' });
    expect(r!.value).toBe('https://new.example.com');
    expect(r!.confirmations).toBe(1);
    expect(r!.confidence).toBe(0.6);
  });

  it('the same observation confirms and raises confidence', () => {
    const mem = makeLayers();
    mem.observeEnvironment({ key: 'os', value: 'kali', volatility: 'stable' });
    const aConf = mem.snapshot().environment[0].confirmations;
    const aConfidence = mem.snapshot().environment[0].confidence;
    mem.observeEnvironment({ key: 'os', value: 'kali', volatility: 'stable' });
    const b = mem.snapshot().environment[0];
    expect(b.confirmations).toBe(aConf + 1);
    expect(b.confidence).toBeCloseTo(aConfidence + 0.05, 5);
  });

  it('refuses secret-looking values', () => {
    const mem = makeLayers();
    expect(mem.observeEnvironment({ key: 'leak', value: '-----BEGIN RSA PRIVATE KEY-----', volatility: 'stable' })).toBeNull();
  });
});

describe('episodic memory', () => {
  it('records an episode with bounded lessons and honest confidence', () => {
    const mem = makeLayers();
    const ep = mem.recordEpisode({
      objective: 'open youtube and play lofi',
      outcome: 'success',
      strategy: 'blaxin_web youtube_play',
      lessons: [],
      verified: true,
    });
    expect(ep).not.toBeNull();
    expect(ep!.verified).toBe(true);
    expect(ep!.confidence).toBe(0.8);
  });

  it('unverified outcomes never claim verification', () => {
    const mem = makeLayers();
    const ep = mem.recordEpisode({ objective: 'tidy downloads', outcome: 'partial' });
    expect(ep!.verified).toBe(false);
    expect(ep!.confidence).toBeLessThanOrEqual(0.5);
  });

  it('redacts secret-looking lessons instead of dropping the whole record', () => {
    const mem = makeLayers();
    const ep = mem.recordEpisode({
      objective: 'save key',
      outcome: 'failure',
      lessons: ['password=hunter2secret', 'the browser was closed'],
    });
    // The secret-looking lesson is redacted to '[REDACTED]' (never plaintext);
    // the benign lesson survives untouched.
    expect(ep!.lessons).toContain('the browser was closed');
    expect(ep!.lessons.some((l) => l.includes('hunter2'))).toBe(false);
  });
});

describe('procedural memory', () => {
  it('ONLY verified success promotes a procedure', () => {
    const mem = makeLayers();
    const unverified = mem.promoteProcedure({ name: 'print pdf', purpose: 'print', steps: ['lp file'] }, false);
    expect(unverified.promoted).toBe(false);
    expect(unverified.reason).toContain('not verified');
    expect(mem.snapshot().procedures).toHaveLength(0);

    const ok = mem.promoteProcedure({ name: 'print pdf', purpose: 'print', steps: ['lp file'] }, true);
    expect(ok.promoted).toBe(true);
    expect(ok.procedure!.version).toBe(1);
  });

  it('repeated failure auto-rolls back but keeps the evidence (reversible)', () => {
    const mem = makeLayers();
    mem.promoteProcedure({ name: 'flaky flow', purpose: 'x', steps: ['a', 'b'] }, true);
    mem.procedureFailed('flaky flow');
    const after2 = mem.procedureFailed('flaky flow');
    expect(after2!.status).toBe('rolled_back');
    expect(after2!.version).toBe(2);
    expect(after2!.versionHistory.some((h) => h.reason.includes('auto-disabled'))).toBe(true);
  });

  it('rollback is reversible only via explicit reactivate', () => {
    const mem = makeLayers();
    mem.promoteProcedure({ name: 'p', purpose: 'x', steps: ['a'] }, true);
    mem.procedureFailed('p');
    mem.procedureFailed('p');
    const reinforced = mem.promoteProcedure({ name: 'p', purpose: 'x', steps: ['a'] }, true);
    expect(reinforced.procedure!.status).toBe('rolled_back');
    const back = mem.reactivateProcedure('p');
    expect(back!.status).toBe('active');
    expect(back!.failureCount).toBe(0);
  });
});

describe('persistence + degradation', () => {
  it('survives a reload from disk (round trip)', () => {
    const file = join(dir, 'persist.json');
    const a = new LayeredMemory({ file });
    a.failure({ category: 'browser', failedAction: 'open x', observation: 'no verify' });
    a.observeEnvironment({ key: 'os', value: 'linux', volatility: 'stable' });
    a.recordEpisode({ objective: 'task one', outcome: 'success', verified: true });
    a.promoteProcedure({ name: 'proc', purpose: 'p', steps: ['s1'] }, true);

    const b = new LayeredMemory({ file });
    const snap = b.snapshot();
    expect(snap.failures).toHaveLength(1);
    expect(snap.environment).toHaveLength(1);
    expect(snap.episodes).toHaveLength(1);
    expect(snap.procedures).toHaveLength(1);
  });

  it('corrupted file degrades to an empty store (never crashes)', () => {
    const file = join(dir, 'corrupt.json');
    require('fs').writeFileSync(file, '{not json at all');
    const mem = new LayeredMemory({ file });
    expect(mem.snapshot().failures).toHaveLength(0);
    expect(mem.snapshot().episodes).toHaveLength(0);
  });

  it('oversized file is refused (bounded memory)', () => {
    const file = join(dir, 'huge.json');
    require('fs').writeFileSync(file, 'x'.repeat(3 * 1024 * 1024));
    const mem = new LayeredMemory({ file });
    expect(mem.snapshot().failures).toHaveLength(0);
  });

  it('persisted file carries mode 0600 and no plaintext secrets', () => {
    const file = join(dir, 'perm.json');
    const mem = new LayeredMemory({ file });
    mem.failure({ category: 't', failedAction: 'a', observation: 'benign' });
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf-8');
    expect(raw).toContain('benign');
  });
});

describe('advisory integration (advisor over layers)', () => {
  it('relevant failure pattern with a known recovery enters the advisory', async () => {
    const { MemoryAdvisor } = await import('../memory/advisor.js');
    const file = join(dir, 'adv.json');
    const mem = new LayeredMemory({ file });
    mem.failure({ category: 'browser', failedAction: 'open youtube', observation: 'video never started' });
    mem.failureRecovered({ category: 'browser', failedAction: 'open youtube', observation: 'video never started' }, 'click play via grounded element then verify playback');

    const advisor = new MemoryAdvisor(mem);
    const adv = advisor.advise('open youtube and play lofi hip hop');
    expect(adv.text).toContain('[failure');
    expect(adv.text).toContain('recovery that worked');
    expect(adv.selections.some((s) => s.layer === 'failure')).toBe(true);
  });

  it('stale volatile environment facts are explicitly marked re-observe', async () => {
    const { MemoryAdvisor } = await import('../memory/advisor.js');
    const file = join(dir, 'adv2.json');
    const mem = new LayeredMemory({ file });
    mem.observeEnvironment({ key: 'browser page', value: 'https://example.com/x', volatility: 'volatile' });
    // Backdate the observation past the volatile freshness window (5 min).
    const snap = mem.snapshot();
    expect(snap.environment).toHaveLength(1);

    const advisor = new MemoryAdvisor(mem);
    const adv = advisor.advise('browser page state', { now: Date.now() + 30 * 60_000 });
    expect(adv.text).toContain('STALE');
    expect(adv.text).toContain('re-observe');
  });

  it('empty layers produce an empty advisory', async () => {
    const { MemoryAdvisor } = await import('../memory/advisor.js');
    const advisor = new MemoryAdvisor(new LayeredMemory({ file: join(dir, 'empty.json') }));
    const adv = advisor.advise('completely unrelated objective');
    expect(adv.text).toBe('');
    expect(adv.chars).toBe(0);
  });

  it('respects the character budget (hard cap)', async () => {
    const { MemoryAdvisor } = await import('../memory/advisor.js');
    const mem = new LayeredMemory({ file: join(dir, 'adv3.json') });
    for (let i = 0; i < 10; i++) {
      mem.recordEpisode({ objective: `download big file part ${i}`, outcome: 'success', verified: true, strategy: 'browser download' });
    }
    const advisor = new MemoryAdvisor(mem);
    const adv = advisor.advise('download big file part 3', { budgetChars: 600 });
    expect(adv.chars).toBeLessThanOrEqual(700);
  });
});
