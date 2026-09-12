// Browser-session tests — ONE authoritative page + bounded recovery (§22/§23/§25/§29/§30)
// =============================================================
// Pins: revalidation against real targets before reuse, about:blank
// regression detection (the §25 guard), strategy-varied bounded recovery
// with exhaustion raising a diagnostic error, honest event emission, and
// the explicit-invalidate path. All deterministic via injected deps.
// =============================================================

import { describe, it, expect, vi } from 'vitest';
import { BrowserSession, BrowserSessionDeps, BrowserSessionEvent, MAX_RECOVERY_ATTEMPTS } from '../../tools/browser-session.js';
import type { CdpPage } from '../../tools/cdp-browser.js';

function fakeCdp(url: string | null, opts: { open?: boolean; evalFails?: boolean } = {}): CdpPage {
  return {
    isOpen: () => opts.open ?? true,
    getTargetId: () => 'target-1',
    eval: async () => {
      if (opts.evalFails) throw new Error('renderer gone');
      return { url: url ?? 'about:blank' };
    },
    close: () => undefined,
    send: async () => ({}),
  } as unknown as CdpPage;
}

function deps(overrides: Partial<BrowserSessionDeps> = {}): BrowserSessionDeps {
  return {
    ensureCdpPage: vi.fn(async () => fakeCdp('about:blank')),
    listPageTargets: vi.fn(async () => [{ targetId: 'target-1', url: 'about:blank', title: '' }]),
    attachToTargetId: vi.fn(async () => fakeCdp('about:blank')),
    ...overrides,
  };
}

const events = (session: BrowserSession): BrowserSessionEvent[] => {
  const collected: BrowserSessionEvent[] = [];
  session.setEventListener((e) => collected.push(e));
  return collected;
};

describe('BrowserSession.acquire — validation against reality (§32)', () => {
  it('acquires fresh when empty and emits session-acquired', async () => {
    const s = new BrowserSession(deps());
    const seen = events(s);
    const cdp = await s.acquire();
    expect(cdp).toBeTruthy();
    expect(seen.map((e) => e.type)).toContain('session-acquired');
  });

  it('revalidates the open connection against the REAL target list', async () => {
    const list = vi.fn(async () => [{ targetId: 'target-1', url: 'https://x.test', title: '' }]);
    const d = deps({ listPageTargets: list });
    const s = new BrowserSession(d);
    await s.acquire();                 // fresh acquire (ensureCdpPage — no list consult)
    await s.acquire();                 // reuse path — MUST consult the list
    await s.acquire();                 // and again on every reuse
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('desyncs when the page target vanished and recovers via attach', async () => {
    // The REAL target list no longer contains our page (tab closed).
    const d = deps({
      listPageTargets: vi.fn(async () => [{ targetId: 'target-9', url: 'https://x.test', title: '' }]),
      attachToTargetId: vi.fn(async () => fakeCdp('https://x.test')),
    });
    const s = new BrowserSession(d);
    const seen = events(s);
    (s as unknown as { targetId: string }).targetId = 'target-1';
    (s as unknown as { cdp: CdpPage }).cdp = fakeCdp('https://x.test');
    await s.acquire();
    expect(seen.map((e) => e.type)).toContain('session-desync');
    expect(seen.map((e) => e.type)).toContain('session-recovered');
  });

  it('desyncs when the CDP endpoint itself is unreachable (browser quit)', async () => {
    // The browser is ALREADY gone: the target list is unreachable and
    // nothing can be relaunched — recovery must exhaust honestly.
    const d = deps({
      listPageTargets: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      attachToTargetId: vi.fn(async () => { throw new Error('target gone'); }),
      ensureCdpPage: vi.fn(async () => { throw new Error('no browser binary'); }),
    });
    const s = new BrowserSession(d);
    const seen = events(s);
    (s as unknown as { targetId: string }).targetId = 'target-1';
    (s as unknown as { cdp: CdpPage }).cdp = fakeCdp('about:blank');
    await expect(s.acquire()).rejects.toThrow(/recovery attempts failed/i);
    expect(seen.filter((e) => e.type === 'session-lost')).toHaveLength(1);
  });

  it('detects about:blank REGRESSION under a live session (the §25 guard)', async () => {
    const d = deps({
      listPageTargets: vi.fn(async () => [{ targetId: 'target-1', url: 'about:blank', title: '' }]),
    });
    const s = new BrowserSession(d);
    const seen = events(s);
    // Simulate a session that previously observed a real page…
    (s as unknown as { targetId: string }).targetId = 'target-1';
    (s as unknown as { lastKnownUrl: string }).lastKnownUrl = 'https://www.youtube.com/watch?v=x';
    // …whose connection now REALLY reports about:blank.
    (s as unknown as { cdp: CdpPage }).cdp = fakeCdp('about:blank');
    await s.acquire();
    expect(seen.some((e) => e.type === 'session-desync' && e.detail.includes('about:blank'))).toBe(true);
  });

  it('does NOT flag a legit about:blank session (fresh start)', async () => {
    const d = deps();
    const s = new BrowserSession(d);
    const seen = events(s);
    await s.acquire(); // fresh acquire onto about:blank — normal
    expect(seen.some((e) => e.type === 'session-desync' && e.detail.includes('regressed'))).toBe(false);
  });

  it('treats an unobservable page as desync and RECOVERS onto an observable page', async () => {
    const d = deps({
      listPageTargets: vi.fn(async () => [{ targetId: 'target-1', url: 'about:blank', title: '' }]),
      attachToTargetId: vi.fn(async () => fakeCdp('about:blank', { evalFails: true })),
    });
    const s = new BrowserSession(d);
    const seen = events(s);
    (s as unknown as { targetId: string }).targetId = 'target-1';
    (s as unknown as { cdp: CdpPage }).cdp = fakeCdp('about:blank', { evalFails: true });
    // The relaunch strategy (ensureCdpPage) yields an observable page.
    const cdp = await s.acquire();
    expect((cdp as unknown as { eval: (e: string) => Promise<unknown> }).eval).toBeDefined();
    expect(seen.some((e) => e.type === 'session-desync' && e.detail.includes('stopped responding'))).toBe(true);
    expect(seen.some((e) => e.type === 'session-recovered')).toBe(true);
  });

  it('exhausts honestly when NO strategy yields an observable page', async () => {
    const d = deps({
      listPageTargets: vi.fn(async () => [{ targetId: 'target-1', url: 'about:blank', title: '' }]),
      attachToTargetId: vi.fn(async () => fakeCdp('about:blank', { evalFails: true })),
      ensureCdpPage: vi.fn(async () => fakeCdp('about:blank', { evalFails: true })),
    });
    const s = new BrowserSession(d);
    const seen = events(s);
    (s as unknown as { targetId: string }).targetId = 'target-1';
    (s as unknown as { cdp: CdpPage }).cdp = fakeCdp('about:blank', { evalFails: true });
    await expect(s.acquire()).rejects.toThrow(/recovery attempts failed/i);
    expect(seen.filter((e) => e.type === 'session-lost')).toHaveLength(1);
  });
});

describe('BrowserSession.recover — strategy variance + bounded exhaustion (§29/§30)', () => {
  it('recovers via same-target reconnect when the socket died', async () => {
    const attach = vi.fn(async (id: string) => fakeCdp('about:blank'));
    const d = deps({
      attachToTargetId: attach,
      // Our target-1 is gone from the REAL list → desync → strategy 1
      // reconnects to the SAME target id (stale socket, live tab).
      listPageTargets: vi.fn(async () => [{ targetId: 'target-9', url: 'about:blank', title: '' }]),
    });
    const s = new BrowserSession(d);
    const seen = events(s);
    (s as unknown as { targetId: string }).targetId = 'target-1';
    (s as unknown as { cdp: CdpPage }).cdp = fakeCdp('about:blank');
    await s.acquire();
    expect(attach).toHaveBeenCalledWith('target-1');
    expect(seen.map((e) => e.type)).toContain('session-recovered');
  });

  it('VARIES strategy: same-target reconnect failure → adopt another page', async () => {
    const d = deps({
      attachToTargetId: vi.fn(async (id: string) => {
        if (id === 'target-1') throw new Error('target gone');
        return fakeCdp('https://other.test');
      }),
      listPageTargets: vi.fn(async () => [
        { targetId: 'target-2', url: 'https://other.test', title: '' },
      ]),
    });
    const s = new BrowserSession(d);
    const seen = events(s);
    (s as unknown as { targetId: string }).targetId = 'target-1';
    (s as unknown as { cdp: CdpPage }).cdp = fakeCdp('about:blank');
    await s.acquire();
    expect(seen.some((e) => e.type === 'session-recovered' && e.detail.includes('adopted existing page'))).toBe(true);
  });

  it('prefers NON-blank pages when adopting', async () => {
    const attach = vi.fn(async (id: string) => {
      if (id === 'target-1') throw new Error('stale target');
      return fakeCdp('https://real.test');
    });
    const d = deps({
      attachToTargetId: attach,
      listPageTargets: vi.fn(async () => [
        { targetId: 'blank-1', url: 'about:blank', title: '' },
        { targetId: 'real-1', url: 'https://real.test', title: '' },
      ]),
    });
    const s = new BrowserSession(d);
    (s as unknown as { targetId: string }).targetId = 'target-1';
    (s as unknown as { cdp: CdpPage }).cdp = fakeCdp('about:blank');
    await s.acquire();
    expect(attach).toHaveBeenCalledWith('real-1');
  });

  it('throws a DIAGNOSTIC error when recovery is exhausted — never fakes success', async () => {
    const d = deps({
      attachToTargetId: vi.fn(async () => { throw new Error('gone'); }),
      listPageTargets: vi.fn(async () => [] as Array<{ targetId: string; url: string; title: string }>),
      ensureCdpPage: vi.fn(async () => { throw new Error('no chromium'); }),
    });
    const s = new BrowserSession(d);
    const seen = events(s);
    (s as unknown as { targetId: string }).targetId = 'target-1';
    (s as unknown as { cdp: CdpPage }).cdp = fakeCdp('about:blank');
    await expect(s.acquire()).rejects.toThrow(/Browser session lost/);
    expect(seen.filter((e) => e.type === 'session-lost')).toHaveLength(1);
  });

  it('exhaustion is BOUNDED at MAX_RECOVERY_ATTEMPTS (no infinite retry)', async () => {
    const ensure = vi.fn(async () => { throw new Error('no chromium'); });
    const d = deps({
      attachToTargetId: vi.fn(async () => { throw new Error('gone'); }),
      listPageTargets: vi.fn(async () => [] as Array<{ targetId: string; url: string; title: string }>),
      ensureCdpPage: ensure,
    });
    const s = new BrowserSession(d);
    (s as unknown as { targetId: string }).targetId = 'target-1';
    (s as unknown as { cdp: CdpPage }).cdp = fakeCdp('about:blank');
    await expect(s.acquire()).rejects.toThrow(/recovery attempts failed/i);
    expect(ensure).toHaveBeenCalledTimes(MAX_RECOVERY_ATTEMPTS);
  });

  it('recovery counter resets after a successful adopt (next desync recovers again)', async () => {
    const d = deps({
      listPageTargets: vi.fn(async () => [{ targetId: 'target-1', url: 'about:blank', title: '' }]),
      attachToTargetId: vi.fn(async () => fakeCdp('about:blank')),
    });
    const s = new BrowserSession(d);
    (s as unknown as { targetId: string }).targetId = 'target-1';
    (s as unknown as { cdp: CdpPage }).cdp = fakeCdp('about:blank');
    await s.acquire(); // recovered once
    const counter = (s as unknown as { recoveryAttempts: number }).recoveryAttempts;
    expect(counter).toBe(0);
  });
});

describe('BrowserSession misc', () => {
  it('invalidate() closes and resets — next acquire is fresh (§32)', async () => {
    const d = deps();
    const s = new BrowserSession(d);
    const seen = events(s);
    await s.acquire();
    s.invalidate('mission restart');
    expect(s.snapshot().healthy).toBe(false);
    await s.acquire(); // fresh again
    expect(seen.filter((e) => e.type === 'session-acquired').length).toBeGreaterThanOrEqual(2);
  });

  it('recordNavigation() prevents legit navigation being read as regression', async () => {
    const d = deps({
      listPageTargets: vi.fn(async () => [{ targetId: 'target-1', url: 'about:blank', title: '' }]),
    });
    const s = new BrowserSession(d);
    await s.acquire();
    s.recordNavigation('about:blank'); // navigated to blank on purpose
    (s as unknown as { cdp: CdpPage }).cdp = fakeCdp('about:blank');
    const seen: BrowserSessionEvent[] = [];
    s.setEventListener((e) => seen.push(e));
    await s.acquire();
    expect(seen.some((e) => e.detail.includes('regressed'))).toBe(false);
  });

  it('snapshot() reports only REAL state', async () => {
    const d = deps();
    const s = new BrowserSession(d);
    expect(s.snapshot()).toEqual({ healthy: false, targetId: null, lastKnownUrl: null, attachedAt: null });
    await s.acquire();
    const snap = s.snapshot();
    expect(snap.healthy).toBe(true);
    expect(snap.targetId).toBe('target-1');
  });
});
