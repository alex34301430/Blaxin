import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { classifyDirect } from '../router/direct.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'blaxin-router-'));
  writeFileSync(join(dir, 'notes.txt'), 'hello world');
  mkdirSync(join(dir, 'sub'), { recursive: true });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fast-path router: direct actions', () => {
  it('classifies screenshots', () => {
    for (const msg of ['take a screenshot', 'screenshot', 'grab a screenshot', 'capture the screen']) {
      expect(classifyDirect(msg)?.tool).toBe('screenshot');
    }
  });

  it('classifies clipboard reads', () => {
    for (const msg of ["what's on my clipboard", 'read the clipboard', 'show me the clipboard contents']) {
      expect(classifyDirect(msg)?.tool).toBe('clipboard');
    }
  });

  it('classifies system info by facet', () => {
    expect(classifyDirect('how much ram do i have')).toMatchObject({ tool: 'system-info', args: { info: 'memory' } });
    expect(classifyDirect('disk usage')).toMatchObject({ tool: 'system-info', args: { info: 'disk' } });
    expect(classifyDirect('cpu status')).toMatchObject({ tool: 'system-info', args: { info: 'cpu' } });
    expect(classifyDirect('system info')).toMatchObject({ tool: 'system-info', args: { info: 'all' } });
  });

  it('classifies file reads and directory listings against real paths', () => {
    const file = join(dir, 'notes.txt');
    expect(classifyDirect(`read ${file}`)).toMatchObject({ tool: 'filesystem', args: { operation: 'read', path: file } });
    expect(classifyDirect(`what's in ${file}`)).toMatchObject({ tool: 'filesystem', args: { operation: 'read' } });
    expect(classifyDirect(`list files in ${dir}`)).toMatchObject({ tool: 'filesystem', args: { operation: 'list', path: dir } });
    expect(classifyDirect(`ls ${dir}`)).toMatchObject({ tool: 'filesystem', args: { operation: 'list', path: dir } });
    expect(classifyDirect(`show me the contents of ${dir}`)).toMatchObject({ tool: 'filesystem', args: { operation: 'list' } });
  });

  it('classifies URLs and app launches', () => {
    expect(classifyDirect('open https://example.com')).toMatchObject({ tool: 'browser', args: { action: 'open_url', url: 'https://example.com' } });
    expect(classifyDirect('open example.com')).toMatchObject({ tool: 'browser', args: { url: 'https://example.com' } });
    expect(classifyDirect('open firefox')).toMatchObject({ tool: 'computer-control', args: { action: 'launch_app', app: 'firefox' } });
  });

  it('classifies web searches', () => {
    expect(classifyDirect('search the web for quantum computing')).toMatchObject({ tool: 'search', args: { query: 'quantum computing' } });
    expect(classifyDirect('search for best pizza')).toMatchObject({ tool: 'search' });
    expect(classifyDirect('google weather today')).toMatchObject({ tool: 'search' });
  });
});

describe('fast-path router: refusal to guess', () => {
  it('rejects multi-step, negated, or ambiguous requests', () => {
    for (const msg of [
      'open firefox and chrome',
      "don't open anything",
      'read the file about cats and summarize it',
      'please send an email',
      'what time is it',
      'delete /tmp/x.txt',
      'read /definitely/not/here.txt',
      'open example.com/docs',
      'show firefox',
    ]) {
      expect(classifyDirect(msg), `expected NULL for: ${msg}`).toBeNull();
    }
  });

  it('never returns a terminal or mutating action', () => {
    expect(classifyDirect('run ls -la')).toBeNull();
    expect(classifyDirect('create a file called test')).toBeNull();
  });
});
