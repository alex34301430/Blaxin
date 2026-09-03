import { describe, it, expect } from 'vitest';
import { basicKeyCheck } from '../providers/index.js';
import { classifyKeyHttpStatus, classifyKeyNetworkError } from '../providers/base.js';

describe('basicKeyCheck', () => {
  it('accepts current OpenRouter key formats (sk-or-v1-...)', () => {
    const key = 'sk-or-v1-' + 'a'.repeat(60);
    expect(basicKeyCheck('openrouter', key).ok).toBe(true);
  });

  it('accepts provider keys of varied formats without over-restricting', () => {
    expect(basicKeyCheck('anthropic', 'sk-ant-api03-' + 'b'.repeat(40)).ok).toBe(true);
    expect(basicKeyCheck('openai', 'sk-' + 'c'.repeat(40)).ok).toBe(true);
    expect(basicKeyCheck('google', 'AIza' + 'd'.repeat(30)).ok).toBe(true);
    expect(basicKeyCheck('groq', 'gsk_' + 'e'.repeat(40)).ok).toBe(true);
  });

  it('rejects empty and whitespace-only keys', () => {
    expect(basicKeyCheck('openrouter', '').ok).toBe(false);
    expect(basicKeyCheck('openrouter', '   ').ok).toBe(false);
    expect(basicKeyCheck('openrouter', undefined as unknown as string).ok).toBe(false);
  });

  it('rejects keys with embedded whitespace (typical paste errors)', () => {
    expect(basicKeyCheck('openrouter', 'sk-or-v1-abc def').ok).toBe(false);
  });

  it('rejects obviously truncated keys', () => {
    expect(basicKeyCheck('openrouter', 'sk-').ok).toBe(false);
  });

  it('rejects control characters', () => {
    expect(basicKeyCheck('openrouter', 'sk-or-v1-abc\u0000def').ok).toBe(false);
  });

  it('always accepts ollama (no key needed)', () => {
    expect(basicKeyCheck('ollama', '').ok).toBe(true);
  });
});

describe('classifyKeyHttpStatus', () => {
  it('classifies 401 as INVALID_KEY', () => {
    expect(classifyKeyHttpStatus(401)).toMatchObject({ code: 'INVALID_KEY' });
  });
  it('classifies 429 as RATE_LIMIT', () => {
    expect(classifyKeyHttpStatus(429)).toMatchObject({ code: 'RATE_LIMIT' });
  });
  it('classifies 5xx as SERVER_ERROR', () => {
    expect(classifyKeyHttpStatus(503)).toMatchObject({ code: 'SERVER_ERROR' });
  });
});

describe('classifyKeyNetworkError', () => {
  it('classifies DNS failure as NETWORK', () => {
    const err = new Error('fetch failed');
    (err as any).cause = { code: 'ENOTFOUND' };
    expect(classifyKeyNetworkError(err)).toMatchObject({ code: 'NETWORK' });
  });
  it('classifies timeouts as TIMEOUT', () => {
    const err = new Error('Request timed out after 10000ms');
    expect(classifyKeyNetworkError(err)).toMatchObject({ code: 'TIMEOUT' });
  });
});
