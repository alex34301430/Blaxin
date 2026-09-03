// BLAXIN Memory System
// =============================================================
// Persistent, scoped memory for the agent. Keeps explicit user
// preferences and durable facts separate from the rolling conversation
// history (session-state.ts).
//
// Safety rules:
//   - Secrets are NEVER stored: content is scanned with the same
//     masking rules as the logger and refused/redacted if it looks like
//     an API key, token, or private key.
//   - Entries are capped in size and total count.
//   - Everything is inspectable and deletable through the API.
// =============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dataPath } from './paths.js';
import { logger } from './logger.js';

export type MemoryType = 'preference' | 'fact' | 'project' | 'action-result';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  source: 'user' | 'agent' | 'system';
  createdAt: number;
  lastUsedAt: number;
  /** Short label used for display and search, e.g. "working directory". */
  scope?: string;
}

// Overridable for tests; defaults to the runtime data directory.
const MEMORY_FILE = process.env.BLAXIN_MEMORY_FILE
  ? dataPath(process.env.BLAXIN_MEMORY_FILE)
  : dataPath('.blaxin-state', 'memory.json');
const MAX_ENTRIES = 200;
const MAX_CONTENT_LENGTH = 2000;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

// Mirrors the logger's sensitive patterns so memory never persists secrets.
const SENSITIVE_PATTERNS: RegExp[] = [
  /sk-or-v1-[a-zA-Z0-9-]{10,}/,
  /sk-ant-[a-zA-Z0-9-]{10,}/,
  /sk-[a-zA-Z0-9]{20,}/,
  /gsk_[a-zA-Z0-9]{20,}/,
  /AIza[a-zA-Z0-9_\-]{20,}/,
  /-----BEGIN [^-]*PRIVATE KEY-----/,
  /(?:BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY)/,
  /Bearer\s+[A-Za-z0-9\-._~+/]{20,}/i,
  /api[_-]?key[=:]\s*['"]?[A-Za-z0-9\-._]{16,}/i,
  /authorization[=:]\s*['"]?[A-Za-z0-9\-._]{16,}/i,
];

export function looksSensitive(content: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(content));
}

class MemoryStore {
  private entries: MemoryEntry[] = [];
  private loaded = false;

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(MEMORY_FILE)) return;
      const stats = statSync(MEMORY_FILE);
      if (stats.size > MAX_FILE_SIZE) {
        logger.warn('memory', 'Memory file too large, starting fresh');
        return;
      }
      const parsed = JSON.parse(readFileSync(MEMORY_FILE, 'utf-8')) as MemoryEntry[];
      if (Array.isArray(parsed)) {
        this.entries = parsed
          .filter((e) => e && typeof e.content === 'string')
          .slice(-MAX_ENTRIES);
      }
    } catch (error: any) {
      logger.warn('memory', `Failed to load memory: ${error.message}`);
    }
  }

  private save(): void {
    try {
      const dir = dataPath('.blaxin-state');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(MEMORY_FILE, JSON.stringify(this.entries, null, 2), { mode: 0o600 });
    } catch (error: any) {
      logger.error('memory', `Failed to save memory: ${error.message}`);
    }
  }

  /**
   * Add a memory entry. Returns null (and stores nothing) when the content
   * appears to contain a secret; the content is otherwise capped.
   */
  add(
    type: MemoryType,
    content: string,
    options: { source?: MemoryEntry['source']; scope?: string } = {},
  ): MemoryEntry | null {
    const text = String(content || '').trim();
    if (!text) return null;

    if (looksSensitive(text)) {
      logger.warn('memory', 'Refusing to store memory entry that looks like a secret');
      return null;
    }

    const truncated = text.slice(0, MAX_CONTENT_LENGTH);
    const now = Date.now();

    // De-duplicate identical content (case-sensitive) to avoid spam.
    const existing = this.entries.find((e) => e.content === truncated);
    if (existing) {
      existing.lastUsedAt = now;
      this.save();
      return existing;
    }

    const entry: MemoryEntry = {
      id: `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      content: truncated,
      source: options.source || 'system',
      scope: options.scope,
      createdAt: now,
      lastUsedAt: now,
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      // Drop the oldest least-recently-used entry.
      this.entries.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.save();
    return entry;
  }

  /** Search entries by substring (case-insensitive) and/or type. */
  search(query?: string, type?: MemoryType): MemoryEntry[] {
    this.load();
    const q = (query || '').trim().toLowerCase();
    return this.entries
      .filter((e) => {
        if (type && e.type !== type) return false;
        if (!q) return true;
        return (
          e.content.toLowerCase().includes(q) ||
          (e.scope || '').toLowerCase().includes(q) ||
          e.source.toLowerCase().includes(q)
        );
      })
      .slice(-50);
  }

  getAll(): MemoryEntry[] {
    this.load();
    return [...this.entries];
  }

  remove(id: string): boolean {
    this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  clear(): void {
    this.load();
    this.entries = [];
    try {
      const dir = dataPath('.blaxin-state');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(MEMORY_FILE, JSON.stringify([], null, 2), { mode: 0o600 });
    } catch (error: any) {
      logger.error('memory', `Failed to clear memory: ${error.message}`);
    }
  }
}

export const memoryStore = new MemoryStore();
