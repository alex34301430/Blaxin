// REAL-Chromium CDP verification (env-gated: BLAXIN_REAL_CHROME=1)
// =============================================================
// Proves the grounding/scroll/verification layer against a REAL
// headless Chromium over the real DevTools Protocol — deterministic
// data: pages, no network dependency. Skipped silently in normal runs
// (CI/headless suites stay green); run explicitly with:
//   BLAXIN_REAL_CHROME=1 npx vitest run src/__tests__/agency/cdp-real-browser.test.ts
// Live YouTube end-to-end (network + bot-walls) stays a manual probe,
// NOT an automated claim.
// =============================================================

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'child_process';

const REAL = !!process.env.BLAXIN_REAL_CHROME;
const d = REAL ? describe : describe.skip;
const PORT = 9333 + Math.floor(Math.random() * 400);

// env must be set BEFORE the module import reads BLAXIN_CDP_PORT.
process.env.BLAXIN_CDP_PORT = String(PORT);
const { CdpPage, snapshotInteractives, findTarget, clickTarget, adaptiveScroll, verifyPlayback, isCdpAlive } = await import('../../tools/cdp-browser.js');

const CHILDREN: ReturnType<typeof execFile>[] = [];

async function launchHeadlessChrome(): Promise<void> {
  const bins = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  const extraSandbox = process.env.BLAXIN_E2E_NO_SANDBOX ? ['--no-sandbox'] : [];
  for (const bin of bins) {
    const ok = await new Promise<boolean>((resolve) => {
      execFile('which', [bin], (error) => resolve(!error));
    });
    if (!ok) continue;
    const child = execFile(bin, [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=/tmp/blaxin-cdp-test-${PORT}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      ...extraSandbox,
      'about:blank',
    ], () => undefined);
    child.on('error', () => undefined);
    child.unref();
    CHILDREN.push(child);
    // Wait for the CDP endpoint (bounded).
    for (let i = 0; i < 20; i++) {
      if (await isCdpAlive()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('No Chromium/Chrome with CDP could be started');
}

const PAGE_WITH_LINKS = 'data:text/html,' + encodeURIComponent(`
  <html><head><title>Grounding Test Page</title></head><body>
    <h1>Real page</h1>
    <a href="#next" aria-label="More information">More information</a>
    <button aria-label="Accept">Accept</button>
    <input placeholder="Search here" />
    <div id="result" style="display:none">CLICKED</div>
    <script>
      document.querySelector('a').addEventListener('click', () => {
        const r = document.getElementById('result');
        r.style.display = 'block';
        r.textContent = 'CLICKED-LINK';
      });
    </script>
  </body></html>
`);

const TALL_PAGE = 'data:text/html,' + encodeURIComponent(`
  <html><head><title>Tall Page</title></head><body style="margin:0">
    ${Array.from({ length: 60 }, (_, i) => `<div style="height:200px">filler ${i}</div>`).join('')}
    <button id="bottom" aria-label="Load more comments">Load more comments</button>
  </body></html>
`);

d('real Chromium CDP (BLAXIN_REAL_CHROME=1)', () => {
  let cdp: InstanceType<typeof CdpPage>;

  afterAll(() => {
    cdp?.close();
  });

  it('launches headless Chrome with CDP and attaches', async () => {
    await launchHeadlessChrome();
    cdp = await CdpPage.attach(null);
    expect(await isCdpAlive()).toBe(true);
  }, 30_000);

  it('grounds a semantic target in the real DOM and verifies the click landed', async () => {
    await cdp.send('Page.navigate', { url: PAGE_WITH_LINKS });
    await new Promise((r) => setTimeout(r, 800));

    const els = await snapshotInteractives(cdp);
    expect(els.length).toBeGreaterThanOrEqual(3); // a, button, input are REAL

    const target = findTarget(els, 'More information', 0.5);
    expect(target).not.toBeNull();
    expect(target!.element.tag).toBe('a');
    expect(target!.confidence).toBeGreaterThanOrEqual(0.9);

    const ok = await clickTarget(cdp, target!);
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    // VERIFY with real page state — the click really landed.
    const clicked = await cdp.eval<string>(
      `document.getElementById('result').textContent`
    );
    expect(clicked).toBe('CLICKED-LINK');
  }, 20_000);

  it('refuses to ground a target that does not exist — honest failure', async () => {
    const els = await snapshotInteractives(cdp);
    expect(findTarget(els, 'totally absent thing', 0.5)).toBeNull();
  }, 20_000);

  it('adaptively scrolls a real tall page until the bottom target is found', async () => {
    await cdp.send('Page.navigate', { url: TALL_PAGE });
    await new Promise((r) => setTimeout(r, 800));

    const steps = await adaptiveScroll(cdp, 'Load more comments', { stepPx: 900, maxSteps: 15 });
    expect(steps.at(-1)!.outcome).toBe('TARGET_FOUND');
    // The button is at the real bottom (~12,000px page): several REAL
    // scroll steps must have happened, each verified by real scrollY.
    expect(steps.filter((s) => s.outcome === 'SCROLLED').length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('reports playback honestly: no video on the page → NOT playing', async () => {
    const pb = await verifyPlayback(cdp, 800);
    expect(pb.playing).toBe(false);
  }, 20_000);
}, 60_000);
