import { describe, it, expect } from 'vitest';
import { isValidUserMessage, normalizeUserMessage } from '../utils/validation.js';
import { pickFallbackModel } from '../providers/index.js';
import type { ModelInfo } from '../types.js';

describe('user-message validation (WS + REST shared)', () => {
  it('accepts non-empty strings', () => {
    expect(isValidUserMessage('hello')).toBe(true);
    expect(isValidUserMessage('  spaced out  ')).toBe(true);
    expect(normalizeUserMessage('  spaced out  ')).toBe('spaced out');
  });

  it('rejects empty/undefined/non-string input', () => {
    expect(isValidUserMessage('')).toBe(false);
    expect(isValidUserMessage('   ')).toBe(false);
    expect(isValidUserMessage(undefined)).toBe(false);
    expect(isValidUserMessage(null)).toBe(false);
    expect(isValidUserMessage(42)).toBe(false);
    expect(isValidUserMessage({ content: 'x' })).toBe(false);
    expect(isValidUserMessage(['x'])).toBe(false);
  });
});

function model(id: string, isFree = false): ModelInfo {
  return {
    id,
    name: id,
    provider: 'openai',
    isFree,
    isAvailable: true,
    capabilities: ['chat'],
  };
}

describe('fallback model selection', () => {
  it('keeps the active model when the fallback provider offers it', () => {
    const cached = [model('gpt-4o'), model('llama3')];
    expect(pickFallbackModel('gpt-4o', cached)).toBe('gpt-4o');
  });

  it('picks the first free model when the active model is not offered', () => {
    const cached = [model('paid-model', false), model('free-model', true), model('other', false)];
    expect(pickFallbackModel('gpt-4o', cached)).toBe('free-model');
  });

  it('falls back to the first model when none are free', () => {
    const cached = [model('a'), model('b')];
    expect(pickFallbackModel('gpt-4o', cached)).toBe('a');
  });

  it('returns the active model when there is no cache for the provider', () => {
    expect(pickFallbackModel('gpt-4o', undefined)).toBe('gpt-4o');
    expect(pickFallbackModel('gpt-4o', [])).toBe('gpt-4o');
    expect(pickFallbackModel(null, undefined)).toBeNull();
  });
});