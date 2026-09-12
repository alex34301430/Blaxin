// Browser-flow integration (§12–§19/§22–§28):
//   1. The legacy `browser` tool routes open/search through the ONE
//      authoritative BrowserSession and reports HONEST tri-state outcomes
//      — it must never again fabricate "Opened URL (background)" success
//      when the launch actually failed (§68 false-success guard).
//   2. The orchestrator system prompt carries the blaxin_web doctrine
//      (grounded DOM actions over blind screen coordinates), so the model
//      is steered toward verified browser automation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BrowserTool } from '../../tools/browser.js';
import { BrowserSession, BrowserSessionDeps } from '../../tools/browser-session.js';
import type { CdpPage, PageEval } from '../../tools/cdp-browser.js';
import { AgentOrchestrator } from '../../orchestrator/index.js';
import { buildFakes, FakeProvider } from '../helpers/orchestrator-fakes.js';
import type { SkillRegistry } from '../../skills/registry.js';

// ── Fake CDP page (deterministic, no real browser) ──────────────

interface FakePageSpec {
  /** What location.href reports. */
  url: string;
  title?: string;
  /** When set, every evaluation throws (unobservable page). */
  evalFails?: boolean;
  /** REAL chrome-error page evidence (observable — hence FAILURE, not UNKNOWN). */
  errorPage?: boolean;
  sendCalls: Array<{ method: string; params: Record<string, unknown> }>;
}

function fakeCdp(spec: FakePageSpec): CdpPage {
  return {
    getTargetId: () => 'target-fake',
    isOpen: () => true,
    close: () => {},
    send: async (method: string, params: Record<string, unknown> = {}) => {
      spec.sendCalls.push({ method, params });
      return {};
    },
    eval: async <T>(_: string): Promise<T> => {
      if (spec.evalFails) throw new Error('evaluation failed');
      return { url: spec.url, title: spec.title ?? 'Fake', errorPage: spec.errorPage ?? false } as unknown as T;
    },
  } as unknown as CdpPage;
}

/** Session with faked transport wired to the given page spec. */
function makeSession(spec: FakePageSpec): BrowserSession {
  const session = new BrowserSession();
  const cdp = fakeCdp(spec);
  const deps: BrowserSessionDeps = {
    ensureCdpPage: async () => cdp,
    listPageTargets: async () => [{ targetId: 'target-fake', url: spec.url, title: spec.title ?? 'Fake' }],
    attachToTargetId: async () => cdp,
  };
  session.useDeps(deps);
  return session;
}

// ── Legacy browser tool honesty ──────────────────────────────────

describe('Legacy browser tool — honest verified navigation (§68)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'blaxin-bflow-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('open_url succeeds WITH verification evidence when navigation lands', async () => {
    const spec: FakePageSpec = { url: 'https://example.com/', sendCalls: [] };
    const session = makeSession(spec);
    const tool = new BrowserTool(session);
    const r = await tool.execute({ action: 'open_url', url: 'https://example.com/' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('URL verified');
    expect((r.data as { verification: { status: string } }).verification.status).toBe('SUCCESS');
    // The navigation really went through the CDP session.
    expect(spec.sendCalls.some((c) => c.method === 'Page.navigate')).toBe(true);
  });

  it('open_url FAILS honestly on a chrome error page (never fake success)', async () => {
    const spec: FakePageSpec = { url: 'chrome-error://chromewebdata/', title: 'dead.test', errorPage: true, sendCalls: [] };
    const session = makeSession(spec);
    const tool = new BrowserTool(session);
    const r = await tool.execute({ action: 'open_url', url: 'https://nonexistent.invalid/' });
    // The old implementation returned success: true here unconditionally.
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('NOT verified');
    const v = (r.data as { verification: { status: string; evidence: { errorPage: boolean } } }).verification;
    expect(v.status).toBe('FAILURE');
    expect(v.evidence.errorPage).toBe(true);
  });

  it('open_url reports UNKNOWN (not success) when the page cannot be observed', async () => {
    const spec: FakePageSpec = { url: 'https://example.com/', sendCalls: [], evalFails: true };
    const session = makeSession(spec);
    const tool = new BrowserTool(session);
    const r = await tool.execute({ action: 'open_url', url: 'https://example.com/' });
    expect(r.success).toBe(false);
    const v = (r.data as { verification: { status: string } }).verification;
    expect(v.status).toBe('UNKNOWN');
  });

  it('search verifies the real results page and fails honestly when it does not land', async () => {
    const ok: FakePageSpec = { url: 'https://www.google.com/search?q=blaxin', sendCalls: [] };
    const okTool = new BrowserTool(makeSession(ok));
    const good = await okTool.execute({ action: 'search', query: 'blaxin' });
    expect(good.success).toBe(true);
    expect(good.output).toContain('OBSERVED at');

    const bad: FakePageSpec = { url: 'chrome-error://chromewebdata/', title: 'dead.test', errorPage: true, sendCalls: [] };
    const badTool = new BrowserTool(makeSession(bad));
    const failed = await badTool.execute({ action: 'search', query: 'blaxin' });
    expect(failed.success).toBe(false);
    expect(String(failed.error)).toContain('NOT verified');
  });

  it('session desync exhaustion surfaces a diagnostic error — no fake success', async () => {
    const session = new BrowserSession();
    const deps: BrowserSessionDeps = {
      ensureCdpPage: async () => { throw new Error('no browser binary'); },
      listPageTargets: async () => { throw new Error('cdp dead'); },
      attachToTargetId: async () => { throw new Error('cannot attach'); },
    };
    session.useDeps(deps);
    const tool = new BrowserTool(session);
    const r = await tool.execute({ action: 'open_url', url: 'https://example.com/' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('Browser session lost');
  });

  it('first-acquire failure still yields the full desync → recovery event trail', async () => {
    const session = new BrowserSession();
    const seen: Array<{ type: string; detail: string }> = [];
    session.setEventListener((e) => seen.push({ type: e.type, detail: e.detail }));
    session.useDeps({
      ensureCdpPage: async () => { throw new Error('no browser binary'); },
      listPageTargets: async () => { throw new Error('cdp dead'); },
      attachToTargetId: async () => { throw new Error('cannot attach'); },
    });
    const tool = new BrowserTool(session);
    const r = await tool.execute({ action: 'open_url', url: 'https://example.com/' });
    expect(r.success).toBe(false);
    // The event trail shows the REAL diagnostic sequence — not a silent throw.
    expect(seen.some((e) => e.type === 'session-desync')).toBe(true);
    expect(seen.filter((e) => e.type === 'session-lost')).toHaveLength(1);
  });

  it('a mid-action desync that RECOVERS is surfaced in the result (never silently swallowed)', async () => {
    // Pre-warm a live session, then the target VANISHES from the real
    // list (reuse-path acquire consults it) → desync → recovery adopts a
    // fresh observable page via relaunch → navigation still succeeds and
    // the result carries the REAL desync+recovery trail.
    const recoveredPage = fakeCdp({ url: 'https://example.com/', sendCalls: [] });
    const session = new BrowserSession();
    let listCalls = 0;
    session.useDeps({
      ensureCdpPage: async () => recoveredPage,
      listPageTargets: async () => {
        listCalls++;
        if (listCalls === 1) return []; // reuse acquire: target vanished → desync
        return [{ targetId: 'target-recovered', url: 'https://example.com/', title: 'Example' }];
      },
      attachToTargetId: async () => { throw new Error('cannot attach'); },
    });
    await session.acquire(); // pre-warm (fresh path — no list consult)
    const tool = new BrowserTool(session);
    const r = await tool.execute({ action: 'open_url', url: 'https://example.com/' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('SESSION_DESYNC recovered');
    expect((r.data as { sessionEvents?: unknown[] }).sessionEvents?.length).toBeGreaterThan(0);
  });

  it('a mid-action desync that LOSES the session keeps the desync note on the failure', async () => {
    const session = new BrowserSession();
    const dyingPage = fakeCdp({ url: 'https://example.com/', sendCalls: [] });
    // The session acquires fine, then the page dies MID-navigation:
    // verifyUrl gets no observations → UNKNOWN → reacquire() runs the
    // bounded recovery cycle → every strategy fails → session lost.
    session.useDeps({
      ensureCdpPage: async () => dyingPage,
      listPageTargets: async () => [{ targetId: 'target-fake', url: 'https://example.com/', title: 'Fake' }],
      attachToTargetId: async () => dyingPage,
    });
    // Kill the page: eval always fails (renderer gone) — every recovery
    // strategy that connects to a page still finds it unobservable.
    (dyingPage as unknown as { eval: () => Promise<unknown> }).eval = async () => { throw new Error('page died'); };

    const tool = new BrowserTool(session);
    const r = await tool.execute({ action: 'open_url', url: 'https://example.com/' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('SESSION_DESYNC');
  });

  it('UNKNOWN verification triggers the desync → reacquire → re-verify cycle (recovers the real answer)', async () => {
    // The page is dead UNTIL recovery relaunches it; then it really lands
    // at the expected URL. The action must return the REAL success with
    // the desync trail — not a fabricated UNKNOWN.
    const session = new BrowserSession();
    const deadPage = fakeCdp({ url: 'about:blank', sendCalls: [], evalFails: true });
    const livePage = fakeCdp({ url: 'https://example.com/', sendCalls: [] });
    let ensureCalls = 0;
    session.useDeps({
      ensureCdpPage: async () => {
        ensureCalls++;
        return ensureCalls === 1 ? deadPage : livePage;
      },
      listPageTargets: async () => [{ targetId: 'target-fake', url: 'https://example.com/', title: 'Fake' }],
      attachToTargetId: async () => deadPage,
    });
    const tool = new BrowserTool(session);
    const r = await tool.execute({ action: 'open_url', url: 'https://example.com/' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('URL verified');
    expect(r.output).toContain('SESSION_DESYNC recovered');
  });

  it('open_new_tab creates a REAL page target and verifies it in the page list', async () => {
    const spec: FakePageSpec = { url: 'https://example.com/', sendCalls: [] };
    const session = makeSession(spec);
    // CDP answers Target.createTarget with a real target id.
    spec.sendCalls.push({ method: 'Target.createTarget', params: {} }); // shape only; response comes from send below
    const cdp = await session.acquire();
    (cdp as unknown as { send: (m: string, p?: Record<string, unknown>) => Promise<unknown> }).send = async (method: string, params: Record<string, unknown> = {}) => {
      spec.sendCalls.push({ method, params });
      if (method === 'Target.createTarget') return { targetId: 'target-new' };
      return {};
    };
    // The session's target list gains the new tab (real /json simulation).
    session.useDeps({
      ensureCdpPage: async () => cdp,
      listPageTargets: async () => [
        { targetId: 'target-fake', url: spec.url, title: 'Fake' },
        { targetId: 'target-new', url: 'https://example.net/', title: 'New' },
      ],
      attachToTargetId: async () => cdp,
    });

    const tool = new BrowserTool(session);
    const r = await tool.execute({ action: 'open_new_tab', url: 'https://example.net/' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('verified');
    expect(spec.sendCalls.some((c) => c.method === 'Target.createTarget')).toBe(true);
  });

  it('open_new_tab fails honestly when the target never appears in the page list', async () => {
    const spec: FakePageSpec = { url: 'https://example.com/', sendCalls: [] };
    const session = makeSession(spec);
    const cdp = await session.acquire();
    (cdp as unknown as { send: (m: string, p?: Record<string, unknown>) => Promise<unknown> }).send = async (method: string, params: Record<string, unknown> = {}) => {
      spec.sendCalls.push({ method, params });
      if (method === 'Target.createTarget') return { targetId: 'target-ghost' };
      return {};
    };
    session.useDeps({
      ensureCdpPage: async () => cdp,
      listPageTargets: async () => [{ targetId: 'target-fake', url: spec.url, title: 'Fake' }],
      attachToTargetId: async () => cdp,
    });

    const tool = new BrowserTool(session);
    const r = await tool.execute({ action: 'open_new_tab', url: 'https://ghost.test/' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('NOT verified');
  });

  it('close_tab closes the CURRENT target via CDP and verifies its disappearance', async () => {
    const spec: FakePageSpec = { url: 'https://example.com/', sendCalls: [] };
    const session = makeSession(spec);
    const cdp = await session.acquire();
    (cdp as unknown as { send: (m: string, p?: Record<string, unknown>) => Promise<unknown> }).send = async (method: string, params: Record<string, unknown> = {}) => {
      spec.sendCalls.push({ method, params });
      return {};
    };
    // After the close, the target list no longer contains the page.
    session.useDeps({
      ensureCdpPage: async () => cdp,
      listPageTargets: async () => [],
      attachToTargetId: async () => cdp,
    });

    const tool = new BrowserTool(session);
    const r = await tool.execute({ action: 'close_tab' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('verified gone');
    expect(spec.sendCalls.some((c) => c.method === 'Target.closeTarget')).toBe(true);
    // Intentional teardown must NOT be recorded as a desync (§46: no
    // invented failure events).
    expect(session.recentEvents().some((e) => e.type === 'session-desync' && e.detail.includes('Invalidated'))).toBe(false);
  });

  it('close_tab fails honestly when the target survives the close (no fake success)', async () => {
    const spec: FakePageSpec = { url: 'https://example.com/', sendCalls: [] };
    const session = makeSession(spec);
    const cdp = await session.acquire();
    (cdp as unknown as { send: (m: string, p?: Record<string, unknown>) => Promise<unknown> }).send = async (method: string, params: Record<string, unknown> = {}) => {
      spec.sendCalls.push({ method, params });
      return {};
    };
    // The target STILL appears in the page list after closeTarget —
    // the close did not actually take effect.
    session.useDeps({
      ensureCdpPage: async () => cdp,
      listPageTargets: async () => [{ targetId: 'target-fake', url: spec.url, title: 'Fake' }],
      attachToTargetId: async () => cdp,
    });

    const tool = new BrowserTool(session);
    const r = await tool.execute({ action: 'close_tab' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('NOT verified');
  });
});

// ── Orchestrator: blaxin_web doctrine in the system prompt ───────

interface Ev { event: string; data: any }

describe('Orchestrator browser-flow guidance', () => {
  it('the system prompt steers the model to grounded web actions', async () => {
    const fakes = buildFakes();
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script.push({ content: 'Done.' });
    const orch = new AgentOrchestrator({
      providers: fakes.providers,
      toolRegistry: fakes.tools,
      sessionState: fakes.session,
      memoryStore: fakes.memory,
      getConfig: () => fakes.config,
    });

    await orch.processMessage('open the browser and navigate to github');

    const system = provider.lastMessages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system!.content).toContain('WEB AUTOMATION');
    expect(system!.content).toContain('blaxin_web');
    expect(system!.content).toContain('action=snapshot');
    expect(system!.content).toContain('verify_playback');
    // The doctrine explicitly demotes blind clicking.
    expect(system!.content).toContain('LAST RESORT');
  });

  it('guidance is present even when no skills are selected (always-on doctrine)', async () => {
    const fakes = buildFakes();
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script.push({ content: 'Done.' });
    const orch = new AgentOrchestrator({
      providers: fakes.providers,
      toolRegistry: fakes.tools,
      sessionState: fakes.session,
      memoryStore: fakes.memory,
      getConfig: () => fakes.config,
      skillRegistry: { matchSkills: () => [], buildSkillContext: () => ({ context: '', selected: [] }) } as unknown as SkillRegistry,
    });

    await orch.processMessage('order a pizza with extra cheese');

    const system = provider.lastMessages.find((m) => m.role === 'system');
    expect(system!.content).toContain('WEB AUTOMATION');
  });
});
