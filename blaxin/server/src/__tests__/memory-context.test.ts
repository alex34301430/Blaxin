import { describe, it, expect } from 'vitest';
import { formatMemoryContext, MemoryEntry } from '../utils/memory.js';

function entry(partial: Partial<MemoryEntry> & { content: string; type: MemoryEntry['type'] }): MemoryEntry {
  return {
    id: 'mem_test',
    source: 'user',
    createdAt: 0,
    lastUsedAt: 0,
    ...partial,
  };
}

describe('formatMemoryContext (durable memory read-back)', () => {
  it('returns empty string when there is nothing durable to say', () => {
    expect(formatMemoryContext([])).toBe('');
  });

  it('separates durable notes from failure lessons and labels them', () => {
    const out = formatMemoryContext([
      entry({ type: 'action-result', content: 'Task failed: deploy — timeout', lastUsedAt: 30 }),
      entry({ type: 'preference', content: 'User prefers terse replies', lastUsedAt: 10 }),
      entry({ type: 'fact', content: 'Project uses TypeScript', lastUsedAt: 20 }),
      entry({ type: 'project', content: 'Working tree lives in /home/tsn/Blaxin', lastUsedAt: 5 }),
    ]);
    expect(out).toContain('REMEMBERED CONTEXT');
    expect(out).toContain('[preference] User prefers terse replies');
    expect(out).toContain('[fact] Project uses TypeScript');
    expect(out).toContain('[project] Working tree lives in');
    expect(out).toContain('[lesson] Task failed: deploy — timeout');
    // Durable notes come before failure lessons.
    expect(out.indexOf('[preference]')).toBeLessThan(out.indexOf('[lesson]'));
  });

  it('frames remembered notes as background data the current instruction outranks', () => {
    const out = formatMemoryContext([entry({ type: 'preference', content: 'x', lastUsedAt: 1 })]);
    expect(out.toLowerCase()).toMatch(/background data/);
    expect(out.toLowerCase()).toMatch(/current instruction/);
    expect(out.toLowerCase()).toMatch(/ignore it|ignore any/);
    // Never frames memory as an authority.
    expect(out.toLowerCase()).not.toMatch(/you must obey|follow this|always comply/);
  });

  it('orders most-recent first and caps durable and failure counts', () => {
    const many: MemoryEntry[] = [];
    for (let i = 0; i < 30; i++) {
      many.push(entry({ type: 'fact', content: `fact number ${i}`, lastUsedAt: i }));
    }
    for (let i = 0; i < 10; i++) {
      many.push(entry({ type: 'action-result', content: `lesson number ${i}`, lastUsedAt: 100 + i }));
    }
    const out = formatMemoryContext(many); // defaults: 8 durable, 3 lessons
    // Newest durable facts (29..22) are present; older ones dropped.
    expect(out).toContain('fact number 29');
    expect(out).toContain('fact number 22');
    expect(out).not.toContain('fact number 21');
    // Newest 3 lessons kept.
    expect(out).toContain('lesson number 9');
    expect(out).toContain('lesson number 8');
    expect(out).toContain('lesson number 7');
    expect(out).not.toContain('lesson number 6');
    // Order: durable block strictly before lesson block.
    expect(out.indexOf('fact number 29')).toBeLessThan(out.indexOf('lesson number 9'));
  });

  it('truncates long lines so the injected block stays cheap', () => {
    const long = 'a'.repeat(2000);
    const out = formatMemoryContext([entry({ type: 'fact', content: long, lastUsedAt: 1 })], { maxLineLength: 80 });
    const line = out.split('\n').find((l) => l.includes('[fact]'))!;
    // '- [fact] ' prefix (9) + the 80-char cap.
    expect(line.length).toBeLessThanOrEqual(9 + 80);
    expect(line).not.toContain('a'.repeat(81));
  });

  it('respects explicit caps passed by callers', () => {
    const items: MemoryEntry[] = [];
    for (let i = 0; i < 10; i++) items.push(entry({ type: 'fact', content: `f${i}`, lastUsedAt: i }));
    const out = formatMemoryContext(items, { maxDurable: 2 });
    expect(out).toContain('f9');
    expect(out).toContain('f8');
    expect(out).not.toContain('f7');
  });
});
