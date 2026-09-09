// BLAXIN Command Router
// =============================================================
// Deterministic slash-command parsing. Commands are the Jarvis
// control plane: they execute locally (clear/stop/status/…) with
// zero model involvement, exactly like the fast-path router handles
// single tool actions. Unknown commands return null and are treated
// as ordinary messages.
// =============================================================

export interface CommandAction {
  command: string;
  args: Record<string, unknown>;
}

const MAX_COMMAND_LENGTH = 1000;

/** Parse a leading `/command` into a structured action, or null. */
export function classifyCommand(raw: string): CommandAction | null {
  const input = String(raw || '').trim();
  if (!input.startsWith('/')) return null;
  if (input.length > MAX_COMMAND_LENGTH) return null;

  const [head, ...rest] = input.split(/\s+/);
  const command = (head || '').toLowerCase();
  const argText = rest.join(' ').trim();

  switch (command) {
    case '/help':
    case '/h':
      return { command: 'help', args: {} };

    case '/status':
    case '/state':
      return { command: 'status', args: {} };

    case '/clear':
    case '/new':
      return { command: 'clear', args: {} };

    case '/stop':
    case '/cancel':
      return { command: 'stop', args: {} };

    case '/memory':
    case '/mem':
      return { command: 'memory', args: { query: argText || undefined } };

    case '/queue':
    case '/tasks':
      return { command: 'queue', args: {} };

    case '/missions':
    case '/mission':
      return { command: 'missions', args: {} };

    case '/version':
    case '/v':
      return { command: 'version', args: {} };

    case '/mission-new':
    case '/mission-create': {
      if (!argText) return null;
      // An objective must precede any '|' separated steps.
      if (argText.trim().startsWith('|')) return null;
      // Steps may be separated by '|' — a deterministic decomposition
      // the user controls explicitly.
      const parts = argText.split('|').map((p) => p.trim()).filter(Boolean);
      const objective = parts.shift() || '';
      if (!objective) return null;
      return {
        command: 'mission-new',
        args: { objective, steps: parts },
      };
    }

    default:
      return null;
  }
}

/** Human-readable help text rendered as an agent reply. */
export function commandHelpText(): string {
  return [
    'BLAXIN JARVIS — COMMAND INTERFACE',
    '  /help            Show this help',
    '  /status          Agent, model, queue and mission state',
    '  /clear           Reset the conversation (memory is kept)',
    '  /stop            Stop the current task',
    '  /memory [q]      Show remembered notes (optionally filtered)',
    '  /queue           Show the pending task queue',
    '  /missions        Show persistent missions',
    '  /mission-new <objective> | <step1> | <step2> …',
    '                   Create a mission with explicit steps',
    '  /version         Show BLAXIN version',
    '',
    'Anything else is handled by the agent (fast path first, LLM when needed).',
  ].join('\n');
}