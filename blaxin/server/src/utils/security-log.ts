// BLAXIN Security Event Log
// =============================================================
// Bounded, persisted ring of security-relevant events (origin
// blocks, credential changes, denied confirmations, transport
// decisions). The SECURITY_VAULT HUD panel renders this — every
// entry is a real event, never simulated.
// =============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dataPath } from './paths.js';
import { logger } from './logger.js';

export interface SecurityEvent {
  id: string;
  time: number;
  category: string;
  message: string;
}

const MAX_EVENTS = 100;
const MAX_FILE_SIZE = 1024 * 1024;

function newId(): string {
  return `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class SecurityLog {
  private events: SecurityEvent[] = [];
  private loaded = false;
  private readonly file: string;
  private listener: ((events: SecurityEvent[]) => void) | null = null;

  constructor() {
    this.file = process.env.BLAXIN_SECURITY_LOG_FILE
      ? dataPath(process.env.BLAXIN_SECURITY_LOG_FILE)
      : dataPath('.blaxin-state', 'security-log.json');
  }

  onChange(cb: (events: SecurityEvent[]) => void): void {
    this.listener = cb;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.file)) return;
      const stats = statSync(this.file);
      if (stats.size > MAX_FILE_SIZE) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as SecurityEvent[];
      if (Array.isArray(parsed)) {
        this.events = parsed.filter((e) => e && typeof e.message === 'string').slice(-MAX_EVENTS);
      }
    } catch (error: any) {
      logger.warn('security-log', `Failed to load security log: ${error.message}`);
    }
  }

  private save(): void {
    try {
      const dir = dataPath('.blaxin-state');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(this.events, null, 2), { mode: 0o600 });
    } catch (error: any) {
      logger.error('security-log', `Failed to save security log: ${error.message}`);
    }
  }

  /** Record a security event and notify listeners (newest first in list). */
  record(category: string, message: string): SecurityEvent {
    this.load();
    const event: SecurityEvent = {
      id: newId(),
      time: Date.now(),
      category: String(category).slice(0, 40),
      message: String(message).slice(0, 500),
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
    this.save();
    this.listener?.([...this.events]);
    logger.info('security-log', `${category}: ${message}`);
    return event;
  }

  list(limit = MAX_EVENTS): SecurityEvent[] {
    this.load();
    return [...this.events].reverse().slice(0, Math.max(1, Math.min(limit, MAX_EVENTS)));
  }

  clear(): void {
    this.load();
    this.events = [];
    this.save();
    this.listener?.([...this.events]);
  }
}

export const securityLog = new SecurityLog();