import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry, fetchWithTimeout } from '../providers/base.js';

describe('withRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should return result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on transient errors', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('success');
    
    const result = await withRetry(fn, { 
      maxRetries: 2, 
      baseDelayMs: 10,
      retryableErrors: ['ECONNRESET'],
    });
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should throw after max retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    
    await expect(
      withRetry(fn, { 
        maxRetries: 1, 
        baseDelayMs: 10,
        retryableErrors: ['ECONNRESET'],
      })
    ).rejects.toThrow('ECONNRESET');
    
    expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('should not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('AUTH_FAILED'));
    
    await expect(
      withRetry(fn, { 
        maxRetries: 2, 
        baseDelayMs: 10,
        retryableErrors: ['ECONNRESET'],
      })
    ).rejects.toThrow('AUTH_FAILED');
    
    expect(fn).toHaveBeenCalledTimes(1); // no retries
  });

  it('should retry on 429 rate limit', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP 429'))
      .mockResolvedValue('success');
    
    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should make fetch request with timeout', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));
    
    const response = await fetchWithTimeout('https://example.com', { timeoutMs: 5000 });
    
    expect(response.status).toBe(200);
  });

  it('should abort on timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => 
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Aborted')), 100);
      })
    ));
    
    await expect(
      fetchWithTimeout('https://example.com', { timeoutMs: 10 })
    ).rejects.toThrow();
  });
});
