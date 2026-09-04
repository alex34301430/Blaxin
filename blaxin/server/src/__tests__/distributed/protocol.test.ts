import { describe, it, expect } from 'vitest';
import {
  createMessage, negotiateProtocol, parseFrame, validateWireMessage,
  sanitizeCapabilities, ReplayGuard, clampInt,
} from '../../distributed/protocol.js';
import { MAX_FRAME_BYTES, MAX_PAYLOAD_STRING, PROTOCOL_VERSION } from '../../distributed/types.js';

function frame(type: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type,
    id: 'msg-1',
    ts: Date.now(),
    from: 'body',
    deviceId: 'BLX-BODY-8F2A',
    payload: { ok: true },
    ...overrides,
  });
}

describe('protocol negotiation', () => {
  it('picks the highest mutually supported version', () => {
    expect(negotiateProtocol(1, 1, 1, 1)).toBe(1);
    expect(negotiateProtocol(1, 2, 2, 3)).toBe(2);
    expect(negotiateProtocol(1, 1, 1, 5)).toBe(1);
  });

  it('returns null when ranges do not intersect', () => {
    expect(negotiateProtocol(1, 1, 2, 3)).toBeNull();
    expect(negotiateProtocol(3, 5, 1, 2)).toBeNull();
  });
});

describe('wire message validation', () => {
  it('accepts a well-formed frame from the allowed sender role', () => {
    const result = parseFrame(frame('hello'));
    expect(result.ok).toBe(true);
  });

  it('rejects a frame whose sender role is forbidden for the type', () => {
    const raw = frame('pair_accept', { from: 'body' }); // pair_accept is brain-only
    const parsed = parseFrame(raw);
    expect(parsed.ok).toBe(true); // structural parse passes...
    const roleCheck = validateWireMessage(parsed.ok ? parsed.message : null, 'body');
    expect(roleCheck.ok).toBe(false);
    if (!roleCheck.ok) expect(roleCheck.code).toBe('FORBIDDEN_TYPE');
  });

  it('rejects unknown message types', () => {
    const result = parseFrame(frame('run_shell'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNKNOWN_TYPE');
  });

  it('rejects malformed envelopes (missing fields)', () => {
    for (const overrides of [
      { id: undefined },
      { type: 42 },
      { v: '1' },
      { ts: 'now' },
      { deviceId: 'nope' },
    ]) {
      const result = parseFrame(frame('hello', overrides as Record<string, unknown>));
      expect(result.ok).toBe(false);
    }
  });

  it('rejects sender role mismatches at the connection layer', () => {
    // parseFrame is structural; the connection layer re-checks the role.
    const parsed = parseFrame(frame('hello', { from: 'brain', deviceId: 'BLX-BRAIN-3C91' }));
    expect(parsed.ok).toBe(true);
    const roleCheck = validateWireMessage(parsed.ok ? parsed.message : null, 'body');
    expect(roleCheck.ok).toBe(false);
    if (!roleCheck.ok) expect(roleCheck.code).toBe('MALFORMED');
  });

  it('rejects unsupported protocol versions', () => {
    const result = parseFrame(frame('hello', { v: 99 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_VERSION');
  });

  it('rejects clock-skewed frames', () => {
    const result = parseFrame(frame('hello', { ts: Date.now() - 10 * 60 * 1000 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CLOCK_SKEW');
  });

  it('rejects non-JSON and oversized frames', () => {
    const bad = parseFrame('{not json');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('MALFORMED_JSON');

    const huge = parseFrame(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x20));
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.code).toBe('FRAME_TOO_LARGE');
  });

  it('rejects oversized and deeply nested payloads', () => {
    const big = 'x'.repeat(MAX_PAYLOAD_STRING + 10);
    const result = parseFrame(frame('hello', { payload: { content: big } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PAYLOAD_TOO_LARGE');

    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i++) nested = { child: nested };
    const deep = parseFrame(frame('hello', { payload: nested }));
    expect(deep.ok).toBe(false); // depth guard
  });
});

describe('capability sanitization', () => {
  it('keeps known capabilities, drops junk and duplicates', () => {
    expect(sanitizeCapabilities(['filesystem', 'filesystem', 'terminal', 'hack']))
      .toEqual(['filesystem', 'terminal']);
    expect(sanitizeCapabilities('filesystem')).toEqual([]);
    expect(sanitizeCapabilities(undefined)).toEqual([]);
  });
});

describe('replay guard', () => {
  it('flags duplicate ids within the window and expires old ones', () => {
    let now = 0;
    const guard = new ReplayGuard(1000, () => now);
    expect(guard.record('a')).toBe(true);
    expect(guard.record('a')).toBe(false);
    expect(guard.isDuplicate('a')).toBe(true);
    now = 2000;
    expect(guard.isDuplicate('a')).toBe(false);
    expect(guard.record('a')).toBe(true);
  });
});

describe('clampInt', () => {
  it('clamps hostile values into range', () => {
    expect(clampInt(99, 1, 1, 2)).toBe(2);
    expect(clampInt(-3, 1, 1, 5)).toBe(1);
    expect(clampInt('x', 3, 1, 5)).toBe(3);
    expect(clampInt(2.9, 1, 1, 5)).toBe(2);
  });
});

describe('createMessage', () => {
  it('builds a versioned envelope with id, ts, sender and payload', () => {
    const msg = createMessage('brain', 'BLX-BRAIN-3C91', 'ping', { at: 1 });
    expect(msg.v).toBe(PROTOCOL_VERSION);
    expect(msg.type).toBe('ping');
    expect(msg.from).toBe('brain');
    expect(msg.deviceId).toBe('BLX-BRAIN-3C91');
    expect(msg.id).toBeTruthy();
    expect(msg.ts).toBeGreaterThan(0);
    expect(msg.payload).toEqual({ at: 1 });
    const echo = createMessage('brain', 'BLX-BRAIN-3C91', 'pong', { at: 1 }, 'req-1');
    expect(echo.req).toBe('req-1');
  });
});
