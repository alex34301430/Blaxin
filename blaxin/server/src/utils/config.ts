import { AppConfig } from '../types.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dataPath } from './paths.js';

const CONFIG_FILE = dataPath('blaxin-config.json');

const defaultConfig: AppConfig = {
  server: {
    port: 3001,
    host: '0.0.0.0',
  },
  agent: {
    maxSteps: 20,
    maxRetries: 3,
    requireConfirmation: true,
    confirmationPatterns: [
      'delete',
      'remove',
      'rm ',
      'drop',
      'send',
      'purchase',
      'pay',
      'transfer',
      'sudo',
      'chmod',
      'format',
    ],
  },
  tools: {
    'computer-control': true,
    'screenshot': true,
    'terminal': true,
    'file-system': true,
    'browser': true,
    'clipboard': true,
    'search': true,
    'system-info': true,
  },
  appearance: {
    theme: 'cyberpunk',
    accentColor: '#00f0ff',
  },
};

export function loadConfig(): AppConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      const stored = JSON.parse(raw);
      // Deep-merge each subsection so a config written by an older
      // BLAXIN version cannot silently drop newer defaults
      // (e.g. agent.requireConfirmation, agent.confirmationPatterns).
      return {
        ...defaultConfig,
        ...stored,
        server: { ...defaultConfig.server, ...(stored.server || {}) },
        agent: { ...defaultConfig.agent, ...(stored.agent || {}) },
        tools: { ...defaultConfig.tools, ...(stored.tools || {}) },
        appearance: { ...defaultConfig.appearance, ...(stored.appearance || {}) },
      };
    }
  } catch (e) {
    // Fall through to defaults
  }
  return defaultConfig;
}

export function saveConfig(config: AppConfig): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    // Config save failed silently
  }
}

export function getConfig(): AppConfig {
  return loadConfig();
}

/**
 * Case-insensitive substring match against a list of danger patterns.
 * Used to decide whether a terminal command needs user confirmation.
 */
export function matchesAnyPattern(text: string, patterns: string[]): boolean {
  if (!text || !patterns || patterns.length === 0) return false;
  const lowered = text.toLowerCase();
  return patterns.some((p) => p && lowered.includes(p.toLowerCase()));
}
