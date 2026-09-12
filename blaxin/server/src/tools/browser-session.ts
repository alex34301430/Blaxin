// BLAXIN browser session — ONE authoritative page identity (directive §22/§23/§25)
// =============================================================
// Problem this layer removes: every web action used to call ensureCdpPage()
// independently, which attaches to "the first page target" — two actions
// could act on two DIFFERENT tabs, and a navigation that regressed to
// about:blank went unnoticed (§25 regression).
//
// Model:
//   ACQUIRE   every action revalidates against REAL /json targets +
//             the page's REAL location — reality, not assumption (§32)
//   DESYNC    socket dead / target vanished / page regressed to
//             about:blank under us → real 'session-desync' event
//   RECOVER   bounded, strategy-varied (§29/§30):
//               1. reconnect to the SAME target id
//               2. attach to another existing non-blank page
//               3. relaunch/ensure a browser
//             Exhausted recovery throws a DIAGNOSTIC error (never a
//             fake success) and resets so the next mission starts clean.
// Events are real state transitions — the HUD may display them, nothing
// is invented for display purposes (§46).
// =============================================================

import {
  CdpPage, ensureCdpPage, listPageTargets, PageTargetSummary,
} from './cdp-browser.js';
import { logger } from '../utils/logger.js';

export type BrowserSessionEventType =
  | 'session-acquired'
  | 'session-desync'
  | 'session-recovered'
  | 'session-lost';

export interface BrowserSessionEvent {
  type: BrowserSessionEventType;
  detail: string;
  targetId: string | null;
  url: string | null;
  at: number;
}

export interface SessionSnapshot {
  healthy: boolean;
  targetId: string | null;
  lastKnownUrl: string | null;
  attachedAt: number | null;
}

export function isBlankUrl(url: string | null): boolean {
  if (!url) return false;
  return url === 'about:blank' || url.startsWith('about:blank');
}

/** Injectable transport deps — tests substitute fakes (no real browser). */
export interface BrowserSessionDeps {
  ensureCdpPage: typeof ensureCdpPage;
  listPageTargets: typeof listPageTargets;
  attachToTargetId: typeof CdpPage.attachToTargetId;
}

const realDeps: BrowserSessionDeps = {
  ensureCdpPage,
  listPageTargets,
  attachToTargetId: CdpPage.attachToTargetId,
};

export const MAX_RECOVERY_ATTEMPTS = 3;

/** Bounded event memory (§27: everything bounded). */
const EVENT_RING_MAX = 50;

export class BrowserSession {
  private cdp: CdpPage | null = null;
  private targetId: string | null = null;
  private lastKnownUrl: string | null = null;
  private attachedAt: number | null = null;
  private recoveryAttempts = 0;
  private listener: ((event: BrowserSessionEvent) => void) | null = null;
  /** Bounded ring of REAL state transitions (observable, never fabricated). */
  private eventRing: BrowserSessionEvent[] = [];

  constructor(private deps: BrowserSessionDeps = realDeps) {}

  setEventListener(listener: ((event: BrowserSessionEvent) => void) | null): void {
    this.listener = listener;
  }

  /** Test seam: swap transport deps (deterministic tests, no real browser). */
  useDeps(deps: BrowserSessionDeps): void {
    this.deps = deps;
  }

  /** Test seam: full reset including the event listener. */
  resetForTests(): void {
    this.reset();
    this.listener = null;
  }

  private emit(type: BrowserSessionEventType, detail: string, url: string | null = null): void {
    logger.info('browser-session', `${type}: ${detail}`);
    const event: BrowserSessionEvent = { type, detail, targetId: this.targetId, url, at: Date.now() };
    this.eventRing.push(event);
    if (this.eventRing.length > EVENT_RING_MAX) this.eventRing.shift();
    try {
      this.listener?.(event);
    } catch (e: any) {
      logger.warn('browser-session', `Listener failed: ${e?.message ?? e}`);
    }
  }

  /** REAL desync/recovery/loss events since a timestamp (result surfacing). */
  recentEvents(sinceTs = 0): BrowserSessionEvent[] {
    return this.eventRing.filter((e) => e.at >= sinceTs);
  }

  /** REAL page-target list via the transport deps (verification for tab actions). */
  async listTargets(timeoutMs = 2000): Promise<PageTargetSummary[]> {
    return this.deps.listPageTargets(timeoutMs);
  }

  /**
   * The attached page was closed INTENTIONALLY (e.g. close_tab) — reset
   * WITHOUT emitting a desync: an intentional teardown is not a failure.
   */
  release(): void {
    this.reset();
  }

  /** REAL page location — the ground truth for desync checks. */
  private async readUrl(cdp: CdpPage): Promise<string | null> {
    try {
      const loc = await cdp.eval<{ url?: string }>('(() => ({ url: location.href }))()');
      return typeof loc?.url === 'string' ? loc.url : null;
    } catch {
      return null;
    }
  }

  /**
   * The ONLY way web actions get a page (§22). Revalidates the existing
   * connection against reality before every action; recovers on desync.
   */
  async acquire(): Promise<CdpPage> {
    if (this.cdp?.isOpen() && this.targetId) {
      let targets: PageTargetSummary[] | null = null;
      try {
        targets = await this.deps.listPageTargets();
      } catch (e: any) {
        // The CDP endpoint itself is gone (browser quit) — full desync.
        this.emit('session-desync', `CDP endpoint unreachable: ${e?.message ?? e}`);
        return this.recover();
      }
      const ours = targets.find((t) => t.targetId === this.targetId);
      if (!ours) {
        this.emit('session-desync', `Page target ${this.targetId} vanished (tab closed or browser restarted)`);
        return this.recover();
      }
      // §25 guard: did the page regress to about:blank under us?
      const url = await this.readUrl(this.cdp);
      if (url === null) {
        // Page became unobservable — treat as desync (socket may be half-dead).
        this.emit('session-desync', 'Page stopped responding to evaluation');
        return this.recover();
      }
      if (isBlankUrl(url) && !isBlankUrl(this.lastKnownUrl) && this.lastKnownUrl !== null) {
        this.emit('session-desync', `Navigation regressed to about:blank (was ${this.lastKnownUrl})`);
        return this.recover();
      }
      this.lastKnownUrl = url;
      return this.cdp;
    }
    return this.freshAcquire();
  }

  private async freshAcquire(): Promise<CdpPage> {
    let cdp: CdpPage;
    try {
      cdp = await this.deps.ensureCdpPage(null);
    } catch (e: any) {
      // Even the FIRST acquire runs the bounded recovery cycle: desync
      // → reconnect/adopt/relaunch → exhaustion = diagnostic error with
      // the real event trail (never a bare throw with no observability).
      this.emit('session-desync', `No usable CDP page: ${e?.message ?? e}`);
      return this.recover();
    }
    this.cdp = cdp;
    this.targetId = cdp.getTargetId();
    this.attachedAt = Date.now();
    this.lastKnownUrl = await this.readUrl(cdp);
    this.recoveryAttempts = 0;
    this.emit('session-acquired', `Page target ${this.targetId} acquired`, this.lastKnownUrl);
    return cdp;
  }

  /**
   * PUBLIC desync contract (directive: SESSION_DESYNC → reconnect →
   * reacquire page → observe → verify → continue). Forces the bounded
   * recovery cycle even when the current connection LOOKS healthy — used
   * after an UNKNOWABLE observation (verification could not read the
   * page) so the action retries on a PROVEN-observable page instead of
   * reporting UNKNOWN when reality was reachable.
   */
  async reacquire(): Promise<CdpPage> {
    this.emit('session-desync', 'Page observation unreliable — forcing reconnect/reacquire');
    return this.recover();
  }

  /**
   * Bounded, strategy-varied recovery (§29/§30). Never retries the same
   * failing strategy indefinitely; exhaustion throws a diagnostic error.
   */
  private async recover(): Promise<CdpPage> {
    if (this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      this.emit('session-lost', `Recovery exhausted after ${MAX_RECOVERY_ATTEMPTS} attempts`);
      this.reset();
      throw new Error(
        `Browser session lost: ${MAX_RECOVERY_ATTEMPTS} recovery attempts failed ` +
        `(reconnect, alternate page, relaunch). Human attention required — no fake success.`,
      );
    }
    this.recoveryAttempts++;
    logger.info('browser-session', `Recovery attempt ${this.recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS}`);
    this.cdp?.close();
    this.cdp = null;

    // Strategy 1: reconnect to the SAME target (socket died, tab alive).
    // The page must be OBSERVABLE after reconnect — a renderer that no
    // longer evaluates is not a recovery, it is the same failure (§30).
    if (this.targetId) {
      try {
        const cdp = await this.deps.attachToTargetId(this.targetId);
        if ((await this.readUrl(cdp)) !== null) {
          this.adopt(cdp, `reconnected to same target ${this.targetId}`);
          return cdp;
        }
        logger.info('browser-session', 'Same-target reconnect succeeded but the page is unobservable — varying strategy');
      } catch { /* target gone — vary strategy */ }
    }

    // Strategy 2: adopt another existing page (non-blank first), again
    // requiring real observability before it counts as recovery.
    try {
      const targets = await this.deps.listPageTargets();
      const ordered = [
        ...targets.filter((t) => !isBlankUrl(t.url)),
        ...targets.filter((t) => isBlankUrl(t.url)),
      ];
      for (const candidate of ordered) {
        try {
          const cdp = await this.deps.attachToTargetId(candidate.targetId);
          if ((await this.readUrl(cdp)) !== null) {
            this.adopt(cdp, `adopted existing page ${candidate.targetId} (${candidate.url})`);
            return cdp;
          }
        } catch { /* next candidate */ }
      }
    } catch { /* no page list — vary strategy */ }

    // Strategy 3: ensure/relaunch a browser from scratch. The fresh page
    // must be OBSERVABLE to count as recovery (same bar as every other
    // strategy); a failure recurses into the next BOUNDED attempt so
    // exhaustion stays reachable (§30) instead of silently repeating the
    // same failing strategy forever.
    try {
      const cdp = await this.deps.ensureCdpPage(null);
      if ((await this.readUrl(cdp)) !== null) {
        this.adopt(cdp, 'relaunched browser with a fresh page');
        return cdp;
      }
      logger.info('browser-session', 'Fresh browser page is unobservable — recovery attempt failed');
    } catch (e: any) {
      logger.info('browser-session', `Relaunch strategy failed: ${e?.message ?? e}`);
    }
    return this.recover();
  }

  private adopt(cdp: CdpPage, detail: string): void {
    this.cdp = cdp;
    this.targetId = cdp.getTargetId();
    this.attachedAt = Date.now();
    this.recoveryAttempts = 0;
    // URL intentionally not read here — the next acquire() observation is
    // the authoritative moment (fresh pages may legitimately be blank).
    this.lastKnownUrl = null;
    this.emit('session-recovered', detail);
  }

  /**
   * After an INTENTIONAL navigation, record the expected URL so the next
   * acquire() does not misread legit navigation as about:blank regression.
   */
  recordNavigation(url: string): void {
    this.lastKnownUrl = url;
  }

  /** Force-invalidate the connection (explicit stale-reference teardown, §32). */
  invalidate(reason: string): void {
    this.emit('session-desync', `Invalidated: ${reason}`);
    this.reset();
  }

  private reset(): void {
    try { this.cdp?.close(); } catch { /* already gone */ }
    this.cdp = null;
    this.targetId = null;
    this.lastKnownUrl = null;
    this.attachedAt = null;
    this.recoveryAttempts = 0;
  }

  /** Real state snapshot (for status reporting — never fabricated). */
  snapshot(): SessionSnapshot {
    return {
      healthy: !!(this.cdp?.isOpen() && this.targetId),
      targetId: this.targetId,
      lastKnownUrl: this.lastKnownUrl,
      attachedAt: this.attachedAt,
    };
  }
}

/** Process-wide authoritative session (web-agent and future computer-use share it). */
export const browserSession = new BrowserSession();

/**
 * Honest result surfacing for the directive's desync contract:
 * SESSION_DESYNC → reconnect → reacquire page → observe → verify → continue.
 * The session performs that cycle internally; this renders the REAL events
 * that occurred since `sinceTs` into a note for the action's result so a
 * recovery is never silently swallowed. Null when nothing happened.
 */
export function desyncNote(
  session: BrowserSession,
  sinceTs: number,
): { note: string; events: BrowserSessionEvent[] } | null {
  const events = session
    .recentEvents(sinceTs)
    .filter((e) => e.type !== 'session-acquired');
  if (events.length === 0) return null;
  const lastDesync = [...events].reverse().find((e) => e.type === 'session-desync' || e.type === 'session-lost');
  const recovered = events.some((e) => e.type === 'session-recovered');
  const detail = lastDesync?.detail ?? 'unknown session event';
  return {
    note: recovered ? `[SESSION_DESYNC recovered: ${detail}]` : `[SESSION_DESYNC: ${detail}]`,
    events,
  };
}

/** Append the desync note to a ToolResult (output on success, error on failure). */
export function withDesyncNote(
  result: { success: boolean; output: string; error?: string; data?: Record<string, unknown> },
  note: { note: string; events: BrowserSessionEvent[] } | null,
): { success: boolean; output: string; error?: string; data?: Record<string, unknown> } {
  if (!note) return result;
  const data = { ...(result.data ?? {}), sessionEvents: note.events };
  if (result.success) return { ...result, output: `${result.output} ${note.note}`, data };
  return { ...result, error: `${result.error ?? ''} ${note.note}`.trim(), data };
}
