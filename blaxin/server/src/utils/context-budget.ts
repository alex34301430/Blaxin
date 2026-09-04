// BLAXIN Context Budget
// =============================================================
// Guards how much text is stored in conversation history and replayed
// to the model. Unbounded tool outputs (terminal dumps, file reads)
// previously grew history without limit — bloating the state file and
// every subsequent model request payload. Truncation keeps the head and
// the tail (both are usually what matters) and marks the cut clearly.
// =============================================================

export const TOOL_RESULT_HISTORY_CAP = 12000; // chars per stored tool result
export const ASSISTANT_MESSAGE_CAP = 16000;   // chars per stored assistant message
export const MAX_HISTORY_MESSAGES = 30;       // messages replayed to the model
export const MAX_PERSISTED_MESSAGES = 100;    // messages kept in the session file

/**
 * Bound `text` to at most `maxChars`, keeping the head and the tail so
 * truncation never hides either the beginning of the output or the end
 * (exit codes / final lines). Returns the original string when it fits.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';
  if (maxChars < 40) return text.slice(0, maxChars);

  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  const omitted = text.length - headChars - tailChars;
  return (
    text.slice(0, headChars) +
    `\n… [truncated ${omitted} chars] …\n` +
    text.slice(text.length - tailChars)
  );
}

/**
 * Bound a tool result before it enters conversation history. The full
 * result is still delivered to events/UI; only the persisted/replayed
 * copy is capped, so the context window and state file stay bounded.
 */
export function budgetToolResultOutput(output: string): string {
  return truncateText(output, TOOL_RESULT_HISTORY_CAP);
}

/** Bound a model/agent message body before persisting it. */
export function budgetAssistantMessage(content: string): string {
  return truncateText(content, ASSISTANT_MESSAGE_CAP);
}
