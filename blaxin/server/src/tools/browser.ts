import { Tool, ToolResult } from '../types.js';
import { browserSession, desyncNote, withDesyncNote, isBlankUrl } from './browser-session.js';
import { verifyUrl } from './verification.js';
import { logger } from '../utils/logger.js';

/** Structural shape of verifyUrl evidence (kept local — verification.ts owns the type). */
interface Located {
  url: string;
  title: string;
  errorPage: boolean;
}

export class BrowserTool implements Tool {
  name = 'browser';
  description = 'Open URLs in a web browser, search the web, and interact with web content.';

  /** The authoritative session (injectable for deterministic tests). */
  private readonly session: typeof browserSession;

  constructor(session: typeof browserSession = browserSession) {
    this.session = session;
  }

  definition = {
    type: 'function' as const,
    function: {
      name: 'browser',
      description: 'Open a URL in the browser, search the web, or open a specific website.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open_url', 'search', 'open_new_tab', 'close_tab'],
            description: 'The browser action to perform',
          },
          url: {
            type: 'string',
            description: 'URL to open (for open_url and open_new_tab)',
          },
          query: {
            type: 'string',
            description: 'Search query (for search action)',
          },
        },
        required: ['action'],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;

    try {
      switch (action) {
        case 'open_url':
        case 'search': {
          let targetUrl: string;
          if (action === 'search') {
            const query = args.query as string;
            if (!query) return { success: false, output: '', error: 'Search query is required' };
            targetUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
          } else {
            const url = args.url as string;
            if (!url) return { success: false, output: '', error: 'URL is required' };
            try {
              new URL(url);
            } catch {
              return { success: false, output: '', error: 'Invalid URL format' };
            }
            targetUrl = url;
          }

          // ONE authoritative session for every navigation (§22). acquire()
          // revalidates reality (target alive, page observable, no
          // about:blank regression) and recovers bounded on desync.
          const sinceTs = Date.now();
          const cdp = await this.session.acquire();
          await cdp.send('Page.navigate', { url: targetUrl });
          this.session.recordNavigation(targetUrl);
          // Load-settle IS verification: poll the REAL location until it
          // matches or the window closes. chrome-error = definitive FAILURE.
          let v = await verifyUrl(cdp, targetUrl, 8000);
          // Desync contract (§22/§29): an UNKNOWN (unobservable page) is
          // exactly the SESSION_DESYNC trigger — reconnect, reacquire the
          // page, and OBSERVE+VERIFY again before reporting. A page that
          // becomes observable through recovery still yields the real
          // answer; UNKNOWN is only reported when reality stays hidden.
          if (v.status === 'UNKNOWN') {
            try {
              const cdp2 = await this.session.reacquire();
              v = await verifyUrl(cdp2, targetUrl, 4000);
            } catch (e: any) {
              v = {
                status: 'UNKNOWN', method: 'url-match', evidence: null, confidence: 0,
                detail: `Reacquire after desync failed: ${e?.message ?? e} — URL unverified`,
              };
            }
          }
          const desync = desyncNote(this.session, sinceTs);
          if (v.status === 'SUCCESS') {
            const loc = v.evidence as unknown as Located | null;
            if (!loc) {
              // Evidence is structurally absent — refuse to fabricate a URL.
              return withDesyncNote({
                success: false,
                output: '',
                error: `${action} NOT verified — verification reported success without location evidence`,
              }, desync);
            }
            return withDesyncNote({
              success: true,
              output: `Opened URL: ${targetUrl} — OBSERVED at ${loc.url}, title: "${loc.title}" (URL verified).`,
              data: { verification: v },
            }, desync);
          }
          return withDesyncNote({
            success: false,
            output: '',
            error: `${action} NOT verified — ${v.detail}`,
            data: { verification: { method: v.method, status: v.status, evidence: v.evidence, confidence: v.confidence } },
          }, desync);
        }

        case 'open_new_tab': {
          const url = (args.url as string) || 'about:blank';
          if (url !== 'about:blank') {
            try { new URL(url); } catch {
              return { success: false, output: '', error: 'Invalid URL format' };
            }
          }
          const sinceTs = Date.now();
          // Create a REAL new page target through CDP (Target.createTarget)
          // and then VERIFY it: the target must appear in the REAL /json
          // page list at the expected URL. No more shell `--new-tab` guess
          // whose failure was previously reported as success (§68).
          const cdp = await this.session.acquire();
          const created = await cdp.send('Target.createTarget', { url });
          const newTargetId = created?.targetId ? String(created.targetId) : null;
          if (!newTargetId) {
            return withDesyncNote({
              success: false,
              output: '',
              error: 'open_new_tab NOT verified — Target.createTarget returned no targetId',
            }, desyncNote(this.session, sinceTs));
          }
          // The session stays on the ORIGINAL page (open_new_tab is a
          // side action, not a navigation of the working context).
          // Verify the new target REALLY exists with the expected URL.
          const deadline = Date.now() + 5000;
          let observed: { targetId: string; url: string; title: string } | null = null;
          while (Date.now() < deadline) {
            const targets = await this.session.listTargets();
            observed = targets.find((t) => t.targetId === newTargetId) ?? null;
            if (observed && (url === 'about:blank' ? isBlankUrl(observed.url) || observed.url === '' : urlMatchesLocation(observed.url, url))) break;
            await new Promise((r) => setTimeout(r, 250));
            observed = null;
          }
          if (!observed) {
            return withDesyncNote({
              success: false,
              output: '',
              error: `open_new_tab NOT verified — target ${newTargetId} not present in the real page list within 5s`,
            }, desyncNote(this.session, sinceTs));
          }
          logger.info('browser', `New tab created and verified: ${newTargetId} at ${observed.url}`);
          return withDesyncNote({
            success: true,
            output: `Opened new tab: ${observed.url} (target ${newTargetId} verified in the real page list).`,
            data: { targetId: newTargetId, url: observed.url },
          }, desyncNote(this.session, sinceTs));
        }

        case 'close_tab': {
          const sinceTs = Date.now();
          // Close the CURRENT authoritative page target through CDP and
          // VERIFY the disappearance — xdotool keyboard guessing cannot
          // prove which tab closed (or whether one closed at all).
          const cdp = await this.session.acquire();
          const targetId = cdp.getTargetId();
          if (!targetId) {
            return { success: false, output: '', error: 'close_tab failed — no page target attached' };
          }
          try {
            await cdp.send('Target.closeTarget', { targetId });
          } catch (e: any) {
            // The transport dying here is EXPECTED (we killed our own
            // page). Recovery/snapshot below decides the truth.
            logger.info('browser', `closeTarget transport closed (expected): ${e?.message ?? e}`);
          }
          this.session.release(); // intentional teardown — not a desync
          // VERIFY: the target is really gone from the REAL page list.
          const deadline = Date.now() + 5000;
          let gone = false;
          while (Date.now() < deadline) {
            try {
              const targets = await this.session.listTargets();
              gone = !targets.some((t) => t.targetId === targetId);
              if (gone) break;
            } catch { /* endpoint may be restarting — retry */ }
            await new Promise((r) => setTimeout(r, 250));
          }
          if (!gone) {
            return withDesyncNote({
              success: false,
              output: '',
              error: `close_tab NOT verified — target ${targetId} still present after close (5s)`,
            }, desyncNote(this.session, sinceTs));
          }
          return {
            success: true,
            output: `Closed tab (target ${targetId} verified gone from the real page list).`,
            data: { closedTargetId: targetId },
          };
        }

        default:
          return { success: false, output: '', error: `Unknown browser action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, output: '', error: `Browser error: ${error.message}` };
    }
  }

  requiresConfirmation(args: Record<string, unknown>): boolean {
    // Every action now manipulates real browser state through the session.
    return true;
  }
}

/** Loose location match for tab verification (host + path). */
function urlMatchesLocation(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    return a.host === e.host && a.pathname === e.pathname;
  } catch {
    return actual === expected;
  }
}
