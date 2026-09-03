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
      return { ...defaultConfig, ...stored };
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
