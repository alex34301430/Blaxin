// BLAXIN Fast-Path Router
// =============================================================
// Deterministic, LLM-free classification of unambiguous tool requests.
//
// The core rule of the execution architecture: never use an LLM when
// deterministic software can safely solve the task. Requests that match
// a crisp, single-action pattern are dispatched straight to the tool,
// skipping the model round trip entirely (the orchestrator still runs
// the normal confirmation gate, so the permission system is untouched).
//
// Everything that does NOT match — or that touches anything even mildly
// ambiguous — returns null and is handled by the full agent loop.
// =============================================================

import { existsSync, statSync } from 'fs';
import { homedir } from 'os';

export interface DirectAction {
  tool: string;
  args: Record<string, unknown>;
  /** Short human description shown in the UI and step list. */
  summary: string;
}

// Phrases that indicate a request is a multi-step or otherwise complex
// task, not a single direct tool action. When present, defer to the LLM.
const COMPLEXITY_MARKERS = [
  ' and then',
  ' and ',
  ' then ',
  'also ',
  'after that',
  'in addition',
  'both ',
  'instead',
  'compare',
  'summarize',
  'summary of',
  'what does it say',
  'tell me about',
  'according to',
  'because ',
  ' if ',
  ' when you',
  ' after you',
  ' first ',
  ' meanwhile',
  ' twice',
  ' three times',
  'each ',
  'every ',
];

// Anything asking us NOT to do something must not be auto-executed.
const NEGATION = /^(don'?t|do not|please don'?t|never|stop|not|avoid|cancel|no\b)/i;

const MAX_MESSAGE_LENGTH = 300;

function stripPoliteness(input: string): string {
  let text = input.trim();
  for (let i = 0; i < 3; i++) {
    const before = text;
    text = text.replace(
      /^(please\s+|can you\s+|could you\s+|would you\s+|will you\s+|hey\s+(blaxin|brickson|assistant)[,\s!]*|ok(ay)?\s+(blaxin|assistant)?[,\s!]*|blaxin[,\s!]*)/i,
      '',
    ).trim();
    if (text === before) break;
  }
  return text;
}

function looksComplex(text: string): boolean {
  return COMPLEXITY_MARKERS.some((m) => text.toLowerCase().includes(m));
}

/** Expand a leading `~` / `~/` to the user's home directory. */
export function expandHome(path: string): string {
  const home = homedir();
  if (path === '~') return home || path;
  if (path.startsWith('~/')) return path.replace(/^~\//, home ? `${home}/` : '');
  return path;
}

/** Strip trailing sentence punctuation from an extracted path/query. */
function cleanTrailing(value: string): string {
  return value.replace(/[.,;:!?]+$/, '').trim();
}

function isProbablyUrl(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return true;
  // Bare domain: single token with a dot and a plausible TLD tail.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)) {
    const tld = value.split('.').pop() || '';
    if (!/^[a-z]{2,24}$/i.test(tld)) return false;
    // Common non-TLD suffixes (e.g. "file.txt", "archive.tar.gz" …) are
    // files, not URLs — route those to the filesystem instead.
    if (['txt', 'md', 'json', 'csv', 'log', 'html', 'htm', 'css', 'js', 'ts', 'tsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'sh', 'toml', 'yaml', 'yml', 'xml', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'zip', 'tar', 'gz', 'deb', 'appimage', 'mp3', 'mp4', 'flac', 'wav'].includes(tld.toLowerCase())) {
      return false;
    }
    return true;
  }
  return false;
}

function pathKind(path: string): 'file' | 'dir' | 'missing' {
  try {
    const expanded = expandHome(path);
    if (!existsSync(expanded)) return 'missing';
    return statSync(expanded).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

/**
 * Classify a user message as a direct, single-tool action.
 * Returns null when the request should go through the LLM agent loop.
 */
export function classifyDirect(rawMessage: string): DirectAction | null {
  const message = rawMessage?.trim() || '';
  if (!message || message.length > MAX_MESSAGE_LENGTH) return null;
  if (NEGATION.test(message)) return null;

  const text = stripPoliteness(message);
  if (!text || text.length > MAX_MESSAGE_LENGTH) return null;
  const lower = text.toLowerCase();
  if (looksComplex(text)) return null;

  // ── Screenshot ────────────────────────────────────────────────
  if (
    /^(take|grab|capture|get)\s+(a\s+)?(screen\s*shot|screenshot|snapshot)$/.test(lower) ||
    /^screenshot(\s+(the\s+)?(screen|desktop|display))?$/.test(lower) ||
    /^(capture|grab|take|get)\s+(a\s+)?(picture|photo)?\s*of\s+(the\s+)?(screen|desktop|display)$/.test(lower) ||
    /^(capture|grab|take|get)\s+(the\s+)?(screen|desktop|display)$/.test(lower)
  ) {
    return { tool: 'screenshot', args: {}, summary: 'Taking a screenshot…' };
  }

  // ── Clipboard read ────────────────────────────────────────────
  if (
    /^what('s| is| is on)\s+(on\s+)?(my\s+|the\s+)?clipboard\b/.test(lower) ||
    /^(read|get|show)\s+(me\s+)?(the\s+|my\s+)?(system\s+)?clipboard\s*(content|contents)?$/.test(lower)
  ) {
    return { tool: 'clipboard', args: { action: 'read' }, summary: 'Reading the clipboard…' };
  }

  // ── System info ───────────────────────────────────────────────
  if (
    /^(how much (ram|memory) (do i (have|use)|is (free|used|left)))/.test(lower) ||
    lower === 'ram' || lower === 'memory' || lower === 'free memory' ||
    /^memory\s*(usage|info|status)$/.test(lower) || /^ram\s*(usage|info|status)$/.test(lower)
  ) {
    return { tool: 'system-info', args: { info: 'memory' }, summary: 'Checking memory usage…' };
  }
  if (
    lower === 'cpu' || lower === 'processor usage' ||
    /^cpu\s*(usage|info|status)$/.test(lower) ||
    /^(how (busy|loaded) is (my\s+)?(cpu|processor))/.test(lower) ||
    /^what('s| is)\s+my\s+(cpu|processor)/.test(lower)
  ) {
    return { tool: 'system-info', args: { info: 'cpu' }, summary: 'Checking CPU…' };
  }
  if (
    lower === 'disk' || lower === 'storage' ||
    /^disk\s*(usage|space|info|status)$/.test(lower) ||
    /^(how much (disk space|storage) (do i (have|use)|is (free|used|left)))/.test(lower)
  ) {
    return { tool: 'system-info', args: { info: 'disk' }, summary: 'Checking disk usage…' };
  }
  if (
    lower === 'system info' || lower === 'system information' || lower === 'system status' ||
    lower === 'computer info' || /^system\s+(info|information|status|details)$/.test(lower)
  ) {
    return { tool: 'system-info', args: { info: 'all' }, summary: 'Gathering system information…' };
  }

  // ── Open a URL ────────────────────────────────────────────────
  const openMatch = text.match(/^open\s+(.+)$/i);
  let openedTarget = '';
  if (openMatch) {
    const target = cleanTrailing(openMatch[1]);
    if (target && isProbablyUrl(target)) {
      openedTarget = target;
      return {
        tool: 'browser',
        args: { action: 'open_url', url: /^https?:\/\//i.test(target) ? target : `https://${target}` },
        summary: `Opening ${target}…`,
      };
    }
  }

  // ── Read a file / "what's in <path>" ─────────────────────────
  const readMatch = text.match(/^(read|open|show|cat|print)\s+(me\s+)?(the\s+)?(file\s+|contents?\s+of\s+)?(.+)$/i);
  if (readMatch && !openedTarget) {
    const verb = (readMatch[1] || '').toLowerCase();
    const filePhrasing = !!readMatch[4]; // "open the file …", "read contents of …"
    const target = cleanTrailing(readMatch[5]);
    const kind = target ? pathKind(target) : 'missing';
    if (kind === 'file') {
      return {
        tool: 'filesystem',
        args: { operation: 'read', path: expandHome(target) },
        summary: `Reading ${target}…`,
      };
    }
    if (kind === 'dir') {
      return {
        tool: 'filesystem',
        args: { operation: 'list', path: expandHome(target) },
        summary: `Listing ${target}…`,
      };
    }
    // A missing target is only ambiguous for bare "open <target>" (which
    // may be an app to launch); "read/cat …" or "open the file …" with a
    // missing path is unresolvable and goes to the LLM loop.
    if (filePhrasing || verb !== 'open') return null;
    // else: fall through to the app-launch handling below
  }

  // ── "what's in <path>" (handles both files and directories) ──
  const whatsInMatch = text.match(/^(what|what's|what is)\s+(is\s+)?(in|inside)\s+(.+)$/i);
  if (whatsInMatch) {
    const target = cleanTrailing(whatsInMatch[4]);
    const kind = target ? pathKind(target) : 'missing';
    if (kind === 'file') {
      return {
        tool: 'filesystem',
        args: { operation: 'read', path: expandHome(target) },
        summary: `Reading ${target}…`,
      };
    }
    if (kind === 'dir') {
      return {
        tool: 'filesystem',
        args: { operation: 'list', path: expandHome(target) },
        summary: `Listing ${target}…`,
      };
    }
    return null;
  }

  // ── Launch an application (from "open <app>") ────────────────
  if (openMatch) {
    const target = cleanTrailing(openMatch[1]);
    if (target && /^[a-z0-9][a-z0-9 .+_-]*$/i.test(target) && !target.includes('/')) {
      return {
        tool: 'computer-control',
        args: { action: 'launch_app', app: target },
        summary: `Launching ${target}…`,
      };
    }
    return null;
  }

  // ── List a directory ──────────────────────────────────────────
  const listMatch =
    text.match(/^(list|show)\s+(me\s+)?(the\s+)?(contents|files|directories|dirs|folders|items)\s+(in|of)\s+(.+)$/i) ||
    text.match(/^(what|what's)\s+(is\s+)?(inside|in)\s+(the\s+)?(dir|directory|folder)\s+(.+)$/i) ||
    text.match(/^(show|list)\s+(me\s+)?(the\s+)?contents\s+of\s+(.+)$/i);
  if (listMatch) {
    const target = cleanTrailing(listMatch[listMatch.length - 1]);
    if (target && pathKind(target) === 'dir') {
      return {
        tool: 'filesystem',
        args: { operation: 'list', path: expandHome(target) },
        summary: `Listing ${target}…`,
      };
    }
    return null;
  }

  // ── `ls <path>` (bash-style shortcut) ────────────────────────
  const lsMatch = text.match(/^ls(\s+(.+))?$/i);
  if (lsMatch) {
    const target = lsMatch[2] ? cleanTrailing(lsMatch[2]) : homedir() || '.';
    if (pathKind(target) !== 'missing') {
      return {
        tool: 'filesystem',
        args: { operation: 'list', path: expandHome(target) },
        summary: `Listing ${target}…`,
      };
    }
    return null;
  }

  // ── Web search ────────────────────────────────────────────────
  const searchMatch = text.match(/^(?:search(\s+(?:the\s+)?(?:web|internet|online))?\s+for\s+|google\s+)(.+)$/i);
  if (searchMatch) {
    const query = cleanTrailing(searchMatch[2]);
    if (query && query.length <= 200) {
      return { tool: 'search', args: { query }, summary: `Searching the web for “${query}”…` };
    }
    return null;
  }

  return null;
}
