// Web-agent honesty tests — session-based actions + tri-state outcomes (§22/§24/§27/§28/§68)
// =============================================================
// Pins: navigation is VERIFIED with real URL evidence (open to a dead URL
// is an honest FAILURE, never "we sent navigate → success"), playback is
// verified from the real video element (clicked ≠ playing), grounding
// refusals stay refusals, and the session layer is the only page source.
// Deterministic via injected session deps + a scripted PageEval.
// =============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebAgentTool, WEB_AGENT_TIMING } from '../../tools/web-agent.js';
import { BrowserSession, BrowserSessionDeps, browserSession } from '../../tools/browser-session.js';
import type { CdpPage, PageEval } from '../../tools/cdp-browser.js';

// ── Scripted page: answers the real production expressions ─────────

interface Script {
  location: { url: string; title: string; errorPage?: boolean };
  bodyText?: string;
  elements?: Array<Record<string, unknown>>;
  video?: { playing: boolean; currentTime: number; duration: number; title: string } | null;
  clickOk?: boolean;
}

function scriptedPage(script: Script): PageEval {
  return {
    isOpen: () => true,
    getTargetId: () => 't-1',
    close: () => undefined,
    async eval<T>(expression: string): Promise<T> {
      if (expression.includes('location.href')) {
        return { url: script.location.url, title: script.location.title, errorPage: script.location.errorPage ?? false } as T;
      }
      if (expression.includes('querySelectorAll') && expression.includes('getBoundingClientRect')) {
        return JSON.stringify(script.elements ?? []) as T;
      }
      if (expression.includes("querySelector('video')")) {
        return (script.video ? JSON.stringify(script.video) : null) as T;
      }
      if (expression.includes('scrollIntoView') && expression.includes('.click()')) {
        return (script.clickOk ?? true) as T;
      }
      if (expression.includes('document.body')) {
        return (script.bodyText ?? '') as T;
      }
      throw new Error(`scriptedPage: unhandled ${expression.slice(0, 50)}`);
    },
    send: async () => ({}),
  } as unknown as PageEval;
}

// ── Session wired to the scripted page ─────────────────────────────

function wireSession(script: Script): void {
  const page = scriptedPage(script) as unknown as CdpPage;
  const deps: BrowserSessionDeps = {
    ensureCdpPage: vi.fn(async () => page),
    listPageTargets: vi.fn(async () => [{ targetId: 't-1', url: script.location.url, title: script.location.title }]),
    attachToTargetId: vi.fn(async () => page),
  };
  // The process-wide singleton is what the tool uses — swap its deps and
  // clear any prior connection state so each test starts fresh.
  browserSession.useDeps(deps);
  (browserSession as unknown as { cdp: CdpPage | null }).cdp = null;
  (browserSession as unknown as { targetId: string | null }).targetId = null;
  (browserSession as unknown as { recoveryAttempts: number }).recoveryAttempts = 0;
  (browserSession as unknown as { lastKnownUrl: string | null }).lastKnownUrl = null;
}

beforeEach(() => {
  // Shorten bounded waits — honesty logic untouched, tests stay fast.
  WEB_AGENT_TIMING.navVerifyMs = 120;
  WEB_AGENT_TIMING.playVerifyMs = 120;
  WEB_AGENT_TIMING.verifyOnlyMs = 120;
  WEB_AGENT_TIMING.clickSettleMs = 5;
});

// ── open: navigation is verified, never assumed ────────────────────

describe('blaxin_web open — verified navigation (§24/§68)', () => {
  it('SUCCESS with real URL evidence when the page truly arrives', async () => {
    wireSession({ location: { url: 'https://example.com/', title: 'Example' } });
    const tool = new WebAgentTool();
    const r = await tool.execute({ action: 'open', url: 'example.com' });
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/URL verified/);
    expect((r.data as { verification: { evidence: { url: string } } }).verification.evidence.url).toContain('example.com');
  });

  it('FAILURE — not success — when navigation lands on a chrome error page', async () => {
    wireSession({ location: { url: 'chrome-error://chromewebdata/', title: 'dead.test', errorPage: true } });
    const tool = new WebAgentTool();
    const r = await tool.execute({ action: 'open', url: 'https://dead.test' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Chrome error page/);
  });

  it('FAILURE when the URL never matches (redirect elsewhere)', async () => {
    wireSession({ location: { url: 'https://wrong.test/somewhere', title: 'Wrong' } });
    const tool = new WebAgentTool();
    const r = await tool.execute({ action: 'open', url: 'https://expected.test' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/NOT verified/);
  });

  it('rejects an invalid URL before touching the browser', async () => {
    const tool = new WebAgentTool();
    const r = await tool.execute({ action: 'open', url: 'not a url ??' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Invalid URL/);
  });
});

// ── youtube_play: playback = real video state (§24) ────────────────

describe('blaxin_web youtube_play — clicked is NOT playing', () => {
  const YT_RESULTS = (videoId: string, title: string) => [{
    index: 0, role: 'link', text: title, ariaLabel: title, placeholder: null,
    href: `https://www.youtube.com/watch?v=${videoId}`, tag: 'a',
    rect: { x: 10, y: 10, width: 300, height: 60 }, inViewport: true,
  }];

  it('SUCCESS only when the video element REALLY plays', async () => {
    wireSession({
      location: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Never Gonna Give You Up' },
      elements: YT_RESULTS('dQw4w9WgXcQ', 'Never Gonna Give You Up (Official Video)'),
      video: { playing: true, currentTime: 2.5, duration: 213, title: 'Never Gonna Give You Up' },
    });
    const tool = new WebAgentTool();
    const r = await tool.execute({ action: 'youtube_play', query: 'never gonna give you up' });
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/PLAYING \(verified\)/);
  });

  it('FAILURE when the video exists but stays paused — no false success', async () => {
    wireSession({
      location: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Never Gonna Give You Up' },
      elements: YT_RESULTS('dQw4w9WgXcQ', 'Never Gonna Give You Up (Official Video)'),
      video: { playing: false, currentTime: 0, duration: 213, title: 'Never Gonna Give You Up' },
    });
    const tool = new WebAgentTool();
    const r = await tool.execute({ action: 'youtube_play', query: 'never gonna give you up' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/NOT verified|NOT playing|not playing/i);
  });

  it('FAILURE when no video element ever appears (player blocked)', async () => {
    wireSession({
      location: { url: 'https://www.youtube.com/watch?v=x', title: 'Watch' },
      elements: YT_RESULTS('x', 'Some video'),
      video: null,
    });
    const tool = new WebAgentTool();
    const r = await tool.execute({ action: 'youtube_play', query: 'anything' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No <video>/);
  });

  it('FAILURE when YouTube search yields no video links (bot-wall) — honest', async () => {
    wireSession({
      location: { url: 'https://www.youtube.com/results?search_query=x', title: 'results' },
      elements: [],
    });
    const tool = new WebAgentTool();
    const r = await tool.execute({ action: 'youtube_play', query: 'anything' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/honest failure|No video results/i);
  });
});

// ── click: grounding refusals stay refusals ────────────────────────

describe('blaxin_web click — grounding honesty', () => {
  it('refuses to click on an ambiguous target (no confident match)', async () => {
    wireSession({ location: { url: 'https://x.test', title: 'X' }, elements: [] });
    const tool = new WebAgentTool();
    const r = await tool.execute({ action: 'click', target: 'the login button probably' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No confident match/);
  });

  it('reports failure when the grounded element vanishes before click', async () => {
    wireSession({
      location: { url: 'https://x.test', title: 'X' },
      elements: [{ index: 0, role: 'button', text: 'Submit', ariaLabel: null, placeholder: null, href: null, tag: 'button', rect: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true }],
      clickOk: false,
    });
    const tool = new WebAgentTool();
    const r = await tool.execute({ action: 'click', target: 'Submit' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/vanished/);
  });
});

// ── verify_playback: standalone verification primitive ─────────────

describe('blaxin_web verify_playback', () => {
  it('reports success ONLY with real playing evidence', async () => {
    wireSession({
      location: { url: 'https://www.youtube.com/watch?v=z', title: 'Z' },
      video: { playing: true, currentTime: 9, duration: 300, title: 'Z' },
    });
    const tool = new WebAgentTool();
    const r = await tool.execute({ action: 'verify_playback' });
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/PLAYING/);
  });

  it('reports honest failure when paused', async () => {
    wireSession({
      location: { url: 'https://www.youtube.com/watch?v=z', title: 'Z' },
      video: { playing: false, currentTime: 4, duration: 300, title: 'Z' },
    });
    const tool = new WebAgentTool();
    const r = await tool.execute({ action: 'verify_playback' });
    expect(r.success).toBe(false);
  });
});

// ── Session is the only page source (§22) ──────────────────────────

describe('blaxin_web uses the ONE authoritative session', () => {
  it('consecutive actions reuse the same session acquire path', async () => {
    wireSession({ location: { url: 'https://stable.test/a', title: 'Stable' } });
    const tool = new WebAgentTool();
    await tool.execute({ action: 'state' });
    await tool.execute({ action: 'snapshot' });
    const snap = browserSession.snapshot();
    expect(snap.healthy).toBe(true);
    expect(snap.targetId).toBe('t-1');
  });
});
