import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

// We need to test the session state module in isolation
// Since it's a singleton, we'll test its methods directly

const STATE_DIR = join(process.cwd(), '.blaxin-state-test');
const STATE_FILE = join(STATE_DIR, 'session.json');

describe('SessionState', () => {
  beforeEach(() => {
    // Clean up test state
    if (existsSync(STATE_DIR)) {
      rmSync(STATE_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(STATE_DIR)) {
      rmSync(STATE_DIR, { recursive: true });
    }
  });

  it('should have correct interface', async () => {
    // Test that the module exports the expected interface
    const { sessionState } = await import('../utils/session-state.js');
    
    expect(sessionState).toBeDefined();
    expect(typeof sessionState.getHistory).toBe('function');
    expect(typeof sessionState.addMessage).toBe('function');
    expect(typeof sessionState.clearHistory).toBe('function');
    expect(typeof sessionState.saveState).toBe('function');
    expect(typeof sessionState.getSessionId).toBe('function');
  });

  it('should manage conversation history', async () => {
    const { sessionState } = await import('../utils/session-state.js');
    
    const msg = {
      id: 'test-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    };

    sessionState.addMessage(msg);
    const history = sessionState.getHistory();
    
    expect(history.length).toBeGreaterThan(0);
    expect(history[history.length - 1].content).toBe('Hello');
  });

  it('should clear history', async () => {
    const { sessionState } = await import('../utils/session-state.js');
    
    const msg = {
      id: 'test-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    };

    sessionState.addMessage(msg);
    sessionState.clearHistory();
    const history = sessionState.getHistory();
    
    expect(history).toHaveLength(0);
  });

  it('should have a session ID', async () => {
    const { sessionState } = await import('../utils/session-state.js');
    
    const sessionId = sessionState.getSessionId();
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe('string');
  });
});
