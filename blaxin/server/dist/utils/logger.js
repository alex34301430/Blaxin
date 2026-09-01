// BLAXIN Logger - Never logs secrets
var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["DEBUG"] = 0] = "DEBUG";
    LogLevel[LogLevel["INFO"] = 1] = "INFO";
    LogLevel[LogLevel["WARN"] = 2] = "WARN";
    LogLevel[LogLevel["ERROR"] = 3] = "ERROR";
})(LogLevel || (LogLevel = {}));
const SENSITIVE_PATTERNS = [
    /sk-or-[a-zA-Z0-9]+/,
    /sk-[a-zA-Z0-9]+/,
    /key[=:]\s*["']?[a-zA-Z0-9\-_.]+/gi,
    /apikey[=:]\s*["']?[a-zA-Z0-9\-_.]+/gi,
    /token[=:]\s*["']?[a-zA-Z0-9\-_.]+/gi,
    /authorization[=:]\s*[a-zA-Z0-9\-_. ]+/gi,
];
function maskSecrets(text) {
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
function log(level, component, message, data) {
    if (level < currentLevel)
        return;
    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level];
    const prefix = `[${timestamp}] [${levelStr}] [${component}]`;
    const safeMessage = maskSecrets(message);
    if (level === LogLevel.ERROR) {
        console.error(`${prefix} ${safeMessage}`, data ? maskSecrets(JSON.stringify(data)) : '');
    }
    else if (level === LogLevel.WARN) {
        console.warn(`${prefix} ${safeMessage}`, data ? maskSecrets(JSON.stringify(data)) : '');
    }
    else {
        console.log(`${prefix} ${safeMessage}`, data ? maskSecrets(JSON.stringify(data)) : '');
    }
}
export const logger = {
    debug: (component, message, data) => log(LogLevel.DEBUG, component, message, data),
    info: (component, message, data) => log(LogLevel.INFO, component, message, data),
    warn: (component, message, data) => log(LogLevel.WARN, component, message, data),
    error: (component, message, data) => log(LogLevel.ERROR, component, message, data),
    setLevel: (level) => {
        currentLevel = LogLevel[level.toUpperCase()];
    },
};
//# sourceMappingURL=logger.js.map