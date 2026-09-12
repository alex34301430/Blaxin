// CDP browser layer tests — deterministic, no real browser (directive §30)
// =============================================================
// The PageEval seam lets the grounding / scroll / verification logic be
// tested against a fake page that mimics the REAL DOM responses. The
// tests pin the honesty contract: no confident match → null (no guess),
// zero-size elements are not targets, playback is verified from real
// video state, and adaptive scroll stops on real boundaries.
// =============================================================

import { describe, it, expect } from 'vitest';
import {
  snapshotInteractives, findTarget, scoreElement,
  adaptiveScroll, verifyPlayback, typeIntoSearch, clickTarget,
  InteractiveElement,
} from '../../tools/cdp-browser.js';

// ── Fake page: implements PageEval against a canned DOM ──

interface FakePageState {
  elements: Array<Partial<InteractiveElement> & { id?: string }>;
  scroll: { top: number; height: number; vh: number };
  video: { playing: boolean; currentTime: number; duration: number; title: string } | null;
  clickedIndex?: number;
  typedValue?: string;
}

function el(partial: Partial<InteractiveElement>, i: number): InteractiveElement {
  return {
    index: partial.index ?? i,
    role: partial.role ?? 'button',
    text: partial.text ?? '',
    ariaLabel: partial.ariaLabel ?? null,
    placeholder: partial.placeholder ?? null,
    href: partial.href ?? null,
    tag: partial.tag ?? 'button',
    rect: partial.rect ?? { x: 10, y: 10 + i * 50, width: 120, height: 40 },
    inViewport: partial.inViewport ?? true,
  };
}

/** The same selector list the production code uses in the page. */
const SELECTOR = `'a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], [aria-label]'`;

class FakePage {
  constructor(public state: FakePageState) {}
  private calls: string[] = [];
  lastCall(): string { return this.calls.at(-1) ?? ''; }

  async eval<T>(expression: string): Promise<T> {
    this.calls.push(expression);
    if (expression.includes('querySelectorAll') && expression.includes('getBoundingClientRect')) {
      // snapshotInteractives — the production code JSON.stringifies.
      return JSON.stringify(this.state.elements.map((e, i) => el(e, i))) as T;
    }
    if (expression.includes('scrollY')) {
      return { ...this.state.scroll } as T;
    }
    if (expression.includes("querySelector('video')")) {
      const v = this.state.video;
      return (v ? JSON.stringify({
        playing: v.playing, currentTime: v.currentTime, duration: v.duration, videoTitle: v.title,
      }) : null) as T;
    }
    if (expression.includes('scrollIntoView') && expression.includes('.click()')) {
      const m = expression.match(/querySelectorAll\([^)]+\)\[(\d+)\]/);
      this.state.clickedIndex = m ? Number(m[1]) : -1;
      return true as T;
    }
    if (expression.includes('dispatchEvent(new Event')) {
      // Emulate the production guard: only input/textarea accept typing.
      const m = expression.match(/all\[(\d+)\]/);
      const idx = m ? Number(m[1]) : -1;
      const target = this.state.elements[idx];
      const tag = (target?.tag ?? 'button').toLowerCase();
      if (!/^(input|textarea)$/.test(tag)) return false as T;
      this.state.typedValue = m ? `idx:${idx}` : 'active';
      return true as T;
    }
    if (expression.includes('scrollBy')) {
      const m = expression.match(/top: (-?\d+)/);
      const delta = m ? Number(m[1]) : 0;
      const maxTop = Math.max(0, this.state.scroll.height - this.state.scroll.vh);
      this.state.scroll.top = Math.min(maxTop, Math.max(0, this.state.scroll.top + delta));
      return true as T;
    }
    throw new Error(`FakePage: unhandled expression: ${expression.slice(0, 80)}`);
  }
}

// Reinterpret: the functions take PageEval; FakePage satisfies it.
const asPage = (p: FakePage) => p as unknown as Parameters<typeof snapshotInteractives>[0];

// ── snapshot + grounding ──

describe('snapshotInteractives', () => {
  it('filters zero-size and invisible elements — they are not real targets', async () => {
    const page = new FakePage({
      elements: [
        { text: 'Visible', rect: { x: 0, y: 0, width: 100, height: 30 } },
        { text: 'Hidden', rect: { x: 0, y: 0, width: 0, height: 0 } },
      ],
      scroll: { top: 0, height: 800, vh: 600 },
      video: null,
    });
    const els = await snapshotInteractives(asPage(page));
    expect(els).toHaveLength(1);
    expect(els[0].text).toBe('Visible');
  });
});

describe('findTarget (semantic grounding with honest confidence)', () => {
  const pool = (): InteractiveElement[] => [
    el({ ariaLabel: 'Search', role: 'input', tag: 'input', placeholder: 'Search YouTube' }, 0),
    el({ text: 'Sign in', role: 'link', tag: 'a', href: 'https://accounts.google.com' }, 1),
    el({ text: 'Never Gonna Give You Up', ariaLabel: 'Never Gonna Give You Up by Rick Astley', role: 'link', tag: 'a', href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, 2),
  ];

  it('matches exact aria-label with high confidence', () => {
    const t = findTarget(pool(), 'Search', 0.5);
    expect(t).not.toBeNull();
    expect(t!.element.index).toBe(0);
    expect(t!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(t!.point.x).toBe(10 + 120 / 2);
  });

  it('matches by substring', () => {
    const t = findTarget(pool(), 'Sign', 0.5);
    expect(t!.element.index).toBe(1);
    expect(t!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('matches by word overlap across label variants', () => {
    const t = findTarget(pool(), 'never gonna give you up rick astley', 0.5);
    expect(t!.element.index).toBe(2);
    expect(t!.confidence).toBeLessThan(0.9); // honest: not an exact match
  });

  it('returns null when nothing matches — refuses to guess', () => {
    expect(findTarget(pool(), 'completely unrelated thing', 0.5)).toBeNull();
  });

  it('still grounds off-screen elements (clicks scroll them into view)', () => {
    const offscreen = el({ ariaLabel: 'Deep target', rect: { x: 10, y: 4000, width: 200, height: 40 }, inViewport: false }, 0);
    const t = findTarget([offscreen], 'Deep target', 0.5);
    expect(t).not.toBeNull();
    expect(t!.element.inViewport).toBe(false);
  });

  it('returns null below the minimum confidence', () => {
    // 'up' is a short word — overlap alone scores low; require 0.95.
    expect(findTarget(pool(), 'never gonna give you up rick astley', 0.95)).toBeNull();
  });

  it('scores prefer aria-label exact over weaker text hits', () => {
    const els = pool();
    const best = els.map((e) => scoreElement(e, 'search'))
      .map((s) => s?.score ?? 0)
      .reduce((a, b) => Math.max(a, b), 0);
    expect(best).toBeGreaterThanOrEqual(0.9);
  });
});

// ── actions ──

describe('clickTarget / typeIntoSearch', () => {
  it('clicks the grounded element by its snapshot index', async () => {
    const page = new FakePage({
      elements: [el({ text: 'A' }, 0), el({ text: 'Target' }, 1)],
      scroll: { top: 0, height: 800, vh: 600 }, video: null,
    });
    const els = await snapshotInteractives(asPage(page));
    const target = findTarget(els, 'Target', 0.5)!;
    const ok = await clickTarget(asPage(page), target);
    expect(ok).toBe(true);
    expect(page.state.clickedIndex).toBe(1);
  });

  it('types into the correct element (index identity preserved across selectors)', async () => {
    const page = new FakePage({
      elements: [el({ text: 'link', role: 'link', tag: 'a', href: 'https://x' }, 0), el({ role: 'input', tag: 'input', placeholder: 'q' }, 1)],
      scroll: { top: 0, height: 800, vh: 600 }, video: null,
    });
    const els = await snapshotInteractives(asPage(page));
    const input = findTarget(els, 'q', 0.5)!;
    const ok = await typeIntoSearch(asPage(page), input, 'hello world');
    expect(ok).toBe(true);
    // The typed element must be the REAL index 1 — the regression guard
    // for the selector/index mismatch class of bug.
    expect(page.state.typedValue).toBe('idx:1');
  });

  it('refuses to type into a non-input grounded element', async () => {
    const page = new FakePage({
      elements: [el({ text: 'Not an input', role: 'button', tag: 'button' }, 0)],
      scroll: { top: 0, height: 800, vh: 600 }, video: null,
    });
    const els = await snapshotInteractives(asPage(page));
    const button = findTarget(els, 'Not an input', 0.5)!;
    const ok = await typeIntoSearch(asPage(page), button, 'text');
    expect(ok).toBe(false);
  });
});

// ── adaptive scroll ──

describe('adaptiveScroll', () => {
  function scrollPage(opts: {
    height: number; vh: number; targetInPool?: boolean; elements?: InteractiveElement[];
  }) {
    const state: FakePageState = {
      elements: opts.elements ?? [],
      scroll: { top: 0, height: opts.height, vh: opts.vh },
      video: null,
    };
    const page = new FakePage(state);
    if (opts.targetInPool) {
      // Give the fake a real matching element in its DOM.
      state.elements = [{ ariaLabel: 'Show more', role: 'button', tag: 'button' }];
    }
    return page;
  }

  it('stops with TARGET_FOUND when the semantic target becomes visible', async () => {
    const page = new FakePage({
      elements: [],
      scroll: { top: 0, height: 5000, vh: 600 },
      video: null,
    });
    // After the first scrollBy, the "target" appears in the DOM.
    const origEval = page.eval.bind(page);
    let scrollCalls = 0;
    (page as any).eval = async (expr: string) => {
      if (expr.includes('scrollBy')) {
        scrollCalls++;
        if (scrollCalls === 1) {
          page.state.elements = [{ ariaLabel: 'Load more comments', role: 'button', tag: 'button' }];
        }
      }
      return origEval(expr);
    };

    const steps = await adaptiveScroll(asPage(page), 'Load more comments', { stepPx: 400, maxSteps: 8 });
    expect(steps.at(-1)!.outcome).toBe('TARGET_FOUND');
    expect(steps.at(-1)!.target).toBeTruthy();
    expect(steps).toHaveLength(2); // 1 scroll + found on next observe
  });

  it('stops with BOUNDARY_REACHED at the real end of the page', async () => {
    const page = scrollPage({ height: 1500, vh: 600 }); // max scroll = 900
    const steps = await adaptiveScroll(asPage(page), 'Nonexistent target', { stepPx: 400, maxSteps: 10 });
    expect(steps.at(-1)!.outcome).toBe('BOUNDARY_REACHED');
    // No infinite scroll loop: bounded steps even with a huge maxSteps.
    expect(steps.length).toBeLessThanOrEqual(4);
  });

  it('stops immediately when already at the boundary', async () => {
    const page = scrollPage({ height: 600, vh: 600 });
    const steps = await adaptiveScroll(asPage(page), null, {});
    expect(steps).toHaveLength(1);
    expect(steps[0].outcome).toBe('BOUNDARY_REACHED');
  });

  it('honors maxSteps as a hard bound', async () => {
    // Tall page, target never appears.
    const page = scrollPage({ height: 100000, vh: 600 });
    const steps = await adaptiveScroll(asPage(page), 'Nothing like this exists', { stepPx: 500, maxSteps: 5 });
    expect(steps).toHaveLength(5);
    expect(steps.at(-1)!.outcome).toBe('MAX_STEPS');
  });

  it('scrolls upward with direction=up and stops at the top boundary', async () => {
    const page = scrollPage({ height: 3000, vh: 600 });
    page.state.scroll.top = 2000;
    const steps = await adaptiveScroll(asPage(page), null, { direction: 'up', stepPx: 700, maxSteps: 10 });
    expect(steps.at(-1)!.outcome).toBe('BOUNDARY_REACHED');
    expect(page.state.scroll.top).toBe(0);
  });
});

// ── playback verification ──

describe('verifyPlayback (real video state, never assumed)', () => {
  it('confirms playback only when the video is really advancing', async () => {
    const page = new FakePage({
      elements: [], scroll: { top: 0, height: 800, vh: 600 },
      video: { playing: true, currentTime: 12.4, duration: 213, title: 'Rick Astley - Never Gonna Give You Up' },
    });
    const pb = await verifyPlayback(asPage(page), 1000);
    expect(pb.playing).toBe(true);
    expect(pb.currentTime).toBe(12.4);
    expect(pb.videoTitle).toContain('Rick Astley');
  });

  it('reports honestly when the video is paused — never fakes success', async () => {
    const page = new FakePage({
      elements: [], scroll: { top: 0, height: 800, vh: 600 },
      video: { playing: false, currentTime: 0, duration: 0, title: 'x' },
    });
    const pb = await verifyPlayback(asPage(page), 800);
    expect(pb.playing).toBe(false);
  });

  it('reports no-video honestly (no video element on the page)', async () => {
    const page = new FakePage({ elements: [], scroll: { top: 0, height: 800, vh: 600 }, video: null });
    const pb = await verifyPlayback(asPage(page), 800);
    expect(pb.playing).toBe(false);
    expect(pb.currentTime).toBe(0);
  });
});
