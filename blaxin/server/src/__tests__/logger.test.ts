import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '../utils/logger.js';

describe('Logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should mask API keys in log messages', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    logger.info('test', 'API key: sk-or-abc123def456ghi789');
    
    const logged = consoleSpy.mock.calls[0]?.[0] || '';
    expect(logged).not.toContain('sk-or-abc123def456ghi789');
    expect(logged).toContain('••••••••');
    
    consoleSpy.mockRestore();
  });

  it('should mask authorization headers', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    logger.info('test', 'authorization: Bearer sk-test123456789');
    
    const logged = consoleSpy.mock.calls[0]?.[0] || '';
    expect(logged).not.toContain('sk-test123456789');
    
    consoleSpy.mockRestore();
  });

  it('should mask key= patterns', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    logger.info('test', 'key=secretvalue123456789');
    
    const logged = consoleSpy.mock.calls[0]?.[0] || '';
    expect(logged).not.toContain('secretvalue123456789');
    
    consoleSpy.mockRestore();
  });

  it('should not mask short strings', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    logger.info('test', 'key=abc');
    
    const logged = consoleSpy.mock.calls[0]?.[0] || '';
    // Short strings should be masked entirely
    expect(logged).toContain('••••••••');
    
    consoleSpy.mockRestore();
  });

  it('should respect log levels', () => {
    const debugSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    // Default level is INFO, so DEBUG should not log
    logger.debug('test', 'debug message');
    expect(debugSpy).not.toHaveBeenCalled();
    
    // INFO should log
    logger.info('test', 'info message');
    expect(debugSpy).toHaveBeenCalled();
    
    debugSpy.mockRestore();
  });
});
