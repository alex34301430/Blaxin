import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SecurityLog } from '../utils/security-log.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blaxin-seclog-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// SecurityLog is a singleton reading from BLAXIN_SECURITY_LOG_FILE — for
// isolated tests, construct a scratch instance via the exported class.
// (The env var is set per-run by vitest config, but we override the file
// by instantiating with a scratch path through the private constructor
// seam: the constructor reads process.env at construction time.)
describe('security log', () => {
  it('records events newest-first and notifies listeners', () => {
    const log = new SecurityLog();
    // Point the singleton's file at a scratch path without touching env.
    (log as unknown as { file: string }).file = join(dir, 's.json');
    let seen: unknown[] = [];
    log.onChange((events) => { seen = events; });

    log.record('origin', 'blocked evil origin');
    log.record('credentials', 'key saved for openai');
    expect(seen).toHaveLength(2);
    expect(log.list()[0].message).toBe('key saved for openai'); // newest first
    expect(log.list()[0].category).toBe('credentials');
  });

  it('persists events across restarts', () => {
    const file = join(dir, 's.json');
    const log1 = new SecurityLog();
    (log1 as unknown as { file: string }).file = file;
    log1.record('transport', 'blocked ws upgrade');

    const log2 = new SecurityLog();
    (log2 as unknown as { file: string }).file = file;
    const events = log2.list();
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('blocked ws upgrade');
  });

  it('respects the limit parameter', () => {
    const log = new SecurityLog();
    (log as unknown as { file: string }).file = join(dir, 's.json');
    for (let i = 0; i < 10; i++) log.record('test', `event ${i}`);
    expect(log.list(3)).toHaveLength(3);
    expect(log.list(3)[0].message).toBe('event 9');
  });

  it('clears the log', () => {
    const log = new SecurityLog();
    (log as unknown as { file: string }).file = join(dir, 's.json');
    log.record('test', 'x');
    log.clear();
    expect(log.list()).toHaveLength(0);
  });
});