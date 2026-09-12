// Verification-engine tests — the honesty contract (directive §27/§28)
// =============================================================
// Pins: tri-state outcomes, UNKNOWN never becomes SUCCESS, evidence is
// carried, chrome-error pages are FAILURE (not success), query-exact URL
// matching (one video must not verify as another), and off-screen is NOT
// visible (§20). All deterministic via the PageEval seam.
// =============================================================

import { describe, it, expect } from 'vitest';
import {
  urlMatches, verifyUrl, verifyTitle, verifyText, verifyElementVisible,
  verifyPlaybackTri, verifyStateChange,
} from '../../tools/verification.js';
import type { PageEval } from '../../tools/cdp-browser.js';

// ── Scriptable fake page (implements PageEval) ─────────────────────

interface PageScript {
  location?: { url: string; title: string; errorPage?: boolean };
  bodyText?: string;
  elements?: Array<{ index: number; role: string; text: string; ariaLabel: string | null; placeholder: string | null; href: string | null; tag: string; rect: { x: number; y: number; width: number; height: number }; inViewport: boolean }>;
  video?: { playing: boolean; currentTime: number; duration: number; title: string } | null;
  stateValue?: unknown;
  failEval?: boolean;
}

function fakePage(script: PageScript): PageEval {
  return {
    async eval<T>(expression: string): Promise<T> {
      if (script.failEval) throw new Error('page gone');
      if (expression.includes('location.href')) {
        return {
          url: script.location?.url ?? 'about:blank',
          title: script.location?.title ?? '',
          errorPage: script.location?.errorPage ?? false,
        } as T;
      }
      if (expression.includes('document.body')) {
        return (script.bodyText ?? '') as T;
      }
      if (expression.includes('querySelectorAll') && expression.includes('getBoundingClientRect')) {
        return JSON.stringify(script.elements ?? []) as T;
      }
      if (expression.includes("querySelector('video')")) {
        return (script.video ? JSON.stringify(script.video) : null) as T;
      }
      if (expression.includes('__state')) {
        return script.stateValue as T;
      }
      throw new Error(`fakePage: unhandled expression: ${expression.slice(0, 60)}`);
    },
  } as unknown as PageEval;
}

const SHORT = 80; // ms — bounded wait windows for fast deterministic tests

// ── urlMatches (pure comparator) ───────────────────────────────────

describe('urlMatches (false-success guard)', () => {
  it('matches the same video across www host variations', () => {
    expect(urlMatches('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
  });

  it('NEVER verifies one video as another (query-exact)', () => {
    expect(urlMatches('https://www.youtube.com/watch?v=OTHER', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
  });

  it('treats a bare-domain expectation as host-level', () => {
    expect(urlMatches('https://www.youtube.com/anything', 'https://youtube.com')).toBe(true);
  });

  it('rejects a different host even with identical path', () => {
    expect(urlMatches('https://evil.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
  });
});

// ── verifyUrl ──────────────────────────────────────────────────────

describe('verifyUrl (tri-state)', () => {
  it('SUCCESS when the real location reaches the expected URL', async () => {
    const page = fakePage({ location: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Rick Astley' } });
    const v = await verifyUrl(page, 'https://youtube.com/watch?v=dQw4w9WgXcQ', SHORT);
    expect(v.status).toBe('SUCCESS');
    expect(v.method).toBe('url-match');
    expect(v.evidence?.url).toContain('youtube.com');
  });

  it('FAILURE (not success) on a chrome error page — honest navigation failure', async () => {
    const page = fakePage({ location: { url: 'chrome-error://chromewebdata/', title: 'www.youtube.com', errorPage: true } });
    const v = await verifyUrl(page, 'https://youtube.com', SHORT);
    expect(v.status).toBe('FAILURE');
    expect(v.detail).toMatch(/Chrome error page/);
  });

  it('FAILURE with observed evidence when the URL never matches', async () => {
    const page = fakePage({ location: { url: 'https://example.com/somewhere-else', title: 'Elsewhere' } });
    const v = await verifyUrl(page, 'https://youtube.com', SHORT);
    expect(v.status).toBe('FAILURE');
    expect(v.evidence?.url).toBe('https://example.com/somewhere-else');
  });

  it('UNKNOWN when the page cannot be observed — never converted to success', async () => {
    const page = fakePage({ failEval: true });
    const v = await verifyUrl(page, 'https://youtube.com', SHORT);
    expect(v.status).toBe('UNKNOWN');
    expect(v.evidence).toBeNull();
    expect(v.confidence).toBe(0);
  });
});

// ── verifyTitle / verifyText ───────────────────────────────────────

describe('verifyTitle', () => {
  it('SUCCESS on real title containment', async () => {
    const page = fakePage({ location: { url: 'https://x.test', title: 'Never Gonna Give You Up - YouTube' } });
    const v = await verifyTitle(page, 'give you up', SHORT);
    expect(v.status).toBe('SUCCESS');
  });
  it('UNKNOWN when unobservable', async () => {
    const v = await verifyTitle(fakePage({ failEval: true }), 'anything', SHORT);
    expect(v.status).toBe('UNKNOWN');
  });
});

describe('verifyText', () => {
  it('SUCCESS when the body text really contains the text', async () => {
    const page = fakePage({ bodyText: 'Official video for Shape of You' });
    const v = await verifyText(page, 'shape of you', SHORT);
    expect(v.status).toBe('SUCCESS');
  });
  it('UNKNOWN when the body cannot be read', async () => {
    const v = await verifyText(fakePage({ failEval: true }), 'anything', SHORT);
    expect(v.status).toBe('UNKNOWN');
  });
});

// ── verifyElementVisible (§20: DOM presence ≠ visibility) ──────────

describe('verifyElementVisible', () => {
  it('FAILURE for an off-screen element — exists but NOT visible', async () => {
    const page = fakePage({
      elements: [{
        index: 0, role: 'button', text: 'Play', ariaLabel: 'Play', placeholder: null,
        href: null, tag: 'button', rect: { x: 10, y: 2000, width: 120, height: 40 }, inViewport: false,
      }],
    });
    const v = await verifyElementVisible(page, 'Play');
    expect(v.status).toBe('FAILURE');
    expect(v.evidence?.inViewport).toBe(false);
    expect(v.detail).toMatch(/OFF-SCREEN/);
  });

  it('FAILURE when nothing matches — grounding refuses to guess', async () => {
    const v = await verifyElementVisible(fakePage({ elements: [] }), 'Play button');
    expect(v.status).toBe('FAILURE');
    expect(v.evidence?.found).toBe(false);
  });

  it('UNKNOWN when the DOM cannot be snapshotted', async () => {
    const v = await verifyElementVisible(fakePage({ failEval: true }), 'Play');
    expect(v.status).toBe('UNKNOWN');
  });

  it('SUCCESS for a really-visible element', async () => {
    const page = fakePage({
      elements: [{
        index: 0, role: 'button', text: 'Play', ariaLabel: 'Play', placeholder: null,
        href: null, tag: 'button', rect: { x: 10, y: 20, width: 120, height: 40 }, inViewport: true,
      }],
    });
    const v = await verifyElementVisible(page, 'Play');
    expect(v.status).toBe('SUCCESS');
    expect(v.evidence?.inViewport).toBe(true);
  });
});

// ── verifyPlaybackTri (§24 playback honesty) ───────────────────────

describe('verifyPlaybackTri', () => {
  it('SUCCESS from real video state (currentTime advancing, not paused)', async () => {
    const page = fakePage({ video: { playing: true, currentTime: 3.2, duration: 240, title: 'Shape of You' } });
    const v = await verifyPlaybackTri(page, SHORT);
    expect(v.status).toBe('SUCCESS');
    expect(v.evidence?.playing).toBe(true);
    expect(v.detail).toMatch(/PLAYING/);
  });

  it('FAILURE when a video exists but is paused — "clicked" is not "playing"', async () => {
    const page = fakePage({ video: { playing: false, currentTime: 0, duration: 240, title: 'Shape of You' } });
    const v = await verifyPlaybackTri(page, SHORT);
    expect(v.status).toBe('FAILURE');
    expect(v.evidence?.playing).toBe(false);
  });

  it('FAILURE when there is no video element at all', async () => {
    const page = fakePage({ video: null });
    const v = await verifyPlaybackTri(page, SHORT);
    expect(v.status).toBe('FAILURE');
    expect(v.detail).toMatch(/No <video>/);
  });

  it('UNKNOWN when the page cannot be observed — playback UNVERIFIED', async () => {
    const v = await verifyPlaybackTri(fakePage({ failEval: true }), SHORT);
    expect(v.status).toBe('UNKNOWN');
    expect(v.detail).toMatch(/UNVERIFIED/);
  });
});

// ── verifyStateChange (temporal verification, §26) ─────────────────

describe('verifyStateChange', () => {
  it('SUCCESS when the state actually changes through the window', async () => {
    const script: PageScript = { stateValue: { t: 0 } };
    const page = fakePage(script);
    const p = verifyStateChange(page, '__state', 900, 80);
    // Reality moves mid-window (e.g. playback currentTime advanced).
    setTimeout(() => { script.stateValue = { t: 1.5 }; }, 150);
    const v = await p;
    expect(v.status).toBe('SUCCESS');
    expect(v.evidence?.before).toEqual({ t: 0 });
    expect(v.evidence?.after).toEqual({ t: 1.5 });
  });

  it('FAILURE when the state provably stays the same', async () => {
    const page = fakePage({ stateValue: { t: 0 } });
    const v = await verifyStateChange(page, '__state', 250, 60);
    expect(v.status).toBe('FAILURE');
    expect(v.evidence?.before).toEqual(v.evidence?.after);
  });

  it('UNKNOWN when the initial state cannot be observed', async () => {
    const v = await verifyStateChange(fakePage({ failEval: true }), '__state', 250, 60);
    expect(v.status).toBe('UNKNOWN');
  });
});
