// BLAXIN input validation
// =============================================================
// Shared validation used by every entry point that accepts a user
// message, so the REST and WebSocket paths cannot disagree about what
// is a valid request.

/** True when `value` is a non-empty (after trimming) message string. */
export function isValidUserMessage(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Normalize a validated message (trim). Call only after isValidUserMessage. */
export function normalizeUserMessage(value: string): string {
  return value.trim();
}