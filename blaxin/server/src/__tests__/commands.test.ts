import { describe, it, expect } from 'vitest';
import { classifyCommand, commandHelpText } from '../router/commands.js';

describe('command router: parsing', () => {
  it('rejects non-command input', () => {
    expect(classifyCommand('hello world')).toBeNull();
    expect(classifyCommand('')).toBeNull();
    expect(classifyCommand('/')).toBeNull();
  });

  it('parses simple commands', () => {
    expect(classifyCommand('/help')?.command).toBe('help');
    expect(classifyCommand('/status')?.command).toBe('status');
    expect(classifyCommand('/clear')?.command).toBe('clear');
    expect(classifyCommand('/stop')?.command).toBe('stop');
    expect(classifyCommand('/version')?.command).toBe('version');
  });

  it('parses aliases', () => {
    expect(classifyCommand('/h')?.command).toBe('help');
    expect(classifyCommand('/new')?.command).toBe('clear');
    expect(classifyCommand('/mem')?.command).toBe('memory');
    expect(classifyCommand('/tasks')?.command).toBe('queue');
    expect(classifyCommand('/mission')?.command).toBe('missions');
    expect(classifyCommand('/v')?.command).toBe('version');
  });

  it('captures memory query arguments', () => {
    expect(classifyCommand('/memory ssh keys')).toEqual({
      command: 'memory',
      args: { query: 'ssh keys' },
    });
  });

  it('creates missions with explicit steps', () => {
    const cmd = classifyCommand('/mission-new Fix the build | run tests | fix failures');
    expect(cmd?.command).toBe('mission-new');
    expect(cmd?.args).toEqual({
      objective: 'Fix the build',
      steps: ['run tests', 'fix failures'],
    });
  });

  it('rejects mission-new without an objective', () => {
    expect(classifyCommand('/mission-new')).toBeNull();
    expect(classifyCommand('/mission-new | step only')).toBeNull();
  });

  it('ignores case and extra whitespace', () => {
    expect(classifyCommand('  /HELP  ')?.command).toBe('help');
    expect(classifyCommand('/Status')?.command).toBe('status');
  });

  it('returns null for unknown commands', () => {
    expect(classifyCommand('/frobnicate')).toBeNull();
    expect(classifyCommand('/open youtube')).toBeNull(); // not a command — fast path
  });

  it('help text covers the full command set', () => {
    const text = commandHelpText();
    for (const cmd of ['/help', '/status', '/clear', '/stop', '/memory', '/queue', '/missions', '/mission-new', '/version']) {
      expect(text).toContain(cmd);
    }
  });
});