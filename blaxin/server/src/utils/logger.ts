// BLAXIN Logger - Never logs secrets

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const SENSITIVE_PATTERNS = [
  /sk-or-[a-zA-Z0-9]+/,
  /sk-[a-zA-Z0-9]+/,
  /key[=:]\s*["']?[a-zA-Z0-9\-_.]+/gi,
  /apikey[=:]\s*["']?[a-zA-Z0-9\-_.]+/gi,
  /token[=:]\s*["']?[a-zA-Z0-9\-_.]+/gi,
  /authorization[=:]\s*[a-zA-Z0-9\-_. ]+/gi,
];

function maskSecrets(text: string): string {
  let masked = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      if (match.length > 8) {
        return match.slice(0, 6) + '••••••••' + match.slice(-4);
      }
      return '••••••••';
    });
  }
  return masked;
}

let currentLevel = LogLevel.INFO;

function log(level: LogLevel, component: string, message: string, data?: unknown) {
  if (level < currentLevel) return;
  
  const timestamp = new Date().toISOString();
  const levelStr = LogLevel[level];
  const prefix = `[${timestamp}] [${levelStr}] [${component}]`;
  
  const safeMessage = maskSecrets(message);
  
  if (level === LogLevel.ERROR) {
    console.error(`${prefix} ${safeMessage}`, data ? maskSecrets(JSON.stringify(data)) : '');
  } else if (level === LogLevel.WARN) {
    console.warn(`${prefix} ${safeMessage}`, data ? maskSecrets(JSON.stringify(data)) : '');
  } else {
    console.log(`${prefix} ${safeMessage}`, data ? maskSecrets(JSON.stringify(data)) : '');
  }
}

export const logger = {
  debug: (component: string, message: string, data?: unknown) =>
    log(LogLevel.DEBUG, component, message, data),
  info: (component: string, message: string, data?: unknown) =>
    log(LogLevel.INFO, component, message, data),
  warn: (component: string, message: string, data?: unknown) =>
    log(LogLevel.WARN, component, message, data),
  error: (component: string, message: string, data?: unknown) =>
    log(LogLevel.ERROR, component, message, data),
  setLevel: (level: 'debug' | 'info' | 'warn' | 'error') => {
    currentLevel = LogLevel[level.toUpperCase() as keyof typeof LogLevel];
  },
};
