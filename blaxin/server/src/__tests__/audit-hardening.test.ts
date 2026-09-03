import { describe, it, expect } from 'vitest';
import { FileSystemTool } from '../tools/filesystem.js';
import { matchesAnyPattern } from '../utils/config.js';
import { envVarForProvider } from '../providers/index.js';
import { homedir } from 'os';
import { join } from 'path';

describe('matchesAnyPattern (confirmation gate for terminal commands)', () => {
  it('flags destructive commands listed in confirmationPatterns', () => {
    expect(matchesAnyPattern('rm -rf /home/user', ['rm ', 'sudo', 'delete'])).toBe(true);
    expect(matchesAnyPattern('sudo apt update', ['sudo'])).toBe(true);
    expect(matchesAnyPattern('chmod +x script.sh', ['chmod'])).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesAnyPattern('SUDO rm /x', ['sudo'])).toBe(true);
  });

  it('allows benign commands', () => {
    expect(matchesAnyPattern('ls -la', ['rm ', 'sudo'])).toBe(false);
    expect(matchesAnyPattern('cat file.txt', ['delete', 'remove'])).toBe(false);
  });

  it('handles empty input and empty pattern lists', () => {
    expect(matchesAnyPattern('', ['sudo'])).toBe(false);
    expect(matchesAnyPattern('ls', [])).toBe(false);
    expect(matchesAnyPattern('ls', undefined as unknown as string[])).toBe(false);
  });
});

describe('envVarForProvider (documented env-var key fallback)', () => {
  it('maps each remote provider to its documented env var', () => {
    expect(envVarForProvider('openrouter')).toBe('OPENROUTER_API_KEY');
    expect(envVarForProvider('openai')).toBe('OPENAI_API_KEY');
    expect(envVarForProvider('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(envVarForProvider('google')).toBe('GOOGLE_API_KEY');
    expect(envVarForProvider('groq')).toBe('GROQ_API_KEY');
    expect(envVarForProvider('together')).toBe('TOGETHER_API_KEY');
  });

  it('maps no env var for the local ollama provider', () => {
    expect(envVarForProvider('ollama')).toBeNull();
  });
});

describe('FileSystemTool protected-path enforcement', () => {
  const tool = new FileSystemTool();
  const sshPath = join(homedir(), '.ssh');

  it('blocks create_dir inside credential directories (~/.ssh)', async () => {
    const result = await tool.execute({ operation: 'create_dir', path: join(sshPath, 'new-dir') });
    expect(result.success).toBe(false);
    expect(result.error).toContain('protects');
  });

  it('blocks create_dir under system roots (/etc)', async () => {
    const result = await tool.execute({ operation: 'create_dir', path: '/etc/blaxin-test-nope' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('protects');
  });

  it('blocks writes to sensitive file names anywhere', async () => {
    const result = await tool.execute({
      operation: 'write',
      path: join(homedir(), 'some-project', '.netrc'),
      content: 'machine example.com login x password y',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('protects');
  });

  it('blocks rename with a protected target path', async () => {
    const result = await tool.execute({
      operation: 'rename',
      path: join(homedir(), 'temp-file.txt'),
      newPath: '/etc/blaxin-renamed',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('protects');
  });

  it('still allows non-protected operations (missing file is a clean error, not a block)', async () => {
    const result = await tool.execute({
      operation: 'read',
      path: join(homedir(), 'definitely-not-a-real-blaxin-file.txt'),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });
});
