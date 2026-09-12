import { Tool, ToolResult } from '../types.js';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Injectable command runner (verification seam). The default shells out to
 * the real clipboard tools; tests inject fakes to drive honest outcomes.
 */
export type ClipboardRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number,
  input?: string
) => Promise<{ stdout: string; stderr: string }>;

/** Real runner: execFile for reads, stdin-fed spawn for writes (no shell). */
const defaultRunner: ClipboardRunner = (cmd, args, timeoutMs, input) =>
  input === undefined
    ? execFileAsync(cmd, args, { timeout: timeoutMs, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } })
    : new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, {
          timeout: timeoutMs,
          env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
        });
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          proc.kill();
          reject(new Error('Timeout'));
        }, timeoutMs);

        proc.stdin.write(input);
        proc.stdin.end();

        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d) => { stdout += d; });
        proc.stderr?.on('data', (d) => { stderr += d; });

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (killed) return;
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(`Exit code ${code}`));
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          if (!killed) reject(err);
        });
      });

const NO_TOOL_ERROR = 'No clipboard tool available. Install xclip, xsel, or wl-clipboard.';
// Read-specific: every reader failed. State BOTH plausible causes honestly
// instead of asserting the wrong diagnosis (the old code said "No clipboard
// tool available" even when the tools existed and the clipboard was simply
// empty/unowned).
const READ_UNAVAILABLE_ERROR = 'Clipboard read failed: none of the clipboard readers (xclip, xsel, wl-paste) could read the selection. This usually means no clipboard utility is installed, or the clipboard is currently empty/unowned. Install one: sudo apt install xclip';

export class ClipboardTool implements Tool {
  name = 'clipboard';
  description = 'Read from and write to the system clipboard.';

  definition = {
    type: 'function' as const,
    function: {
      name: 'clipboard',
      description: 'Get or set the system clipboard content.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write'],
            description: 'Read from or write to clipboard',
          },
          text: {
            type: 'string',
            description: 'Text to write to clipboard (for write action)',
          },
        },
        required: ['action'],
      },
    },
  };

  constructor(private runner: ClipboardRunner = defaultRunner) {}

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;

    try {
      switch (action) {
        case 'read': {
          // Try xclip
          try {
            const { stdout } = await this.runner('xclip', ['-selection', 'clipboard', '-o'], 3000);
            // xclip exits 0 with empty output when the clipboard is empty —
            // that is an EMPTY clipboard, not a missing tool. The old code
            // fell through to "No clipboard tool available", a wrong
            // diagnosis the model would then report to the user.
            return { success: true, output: stdout, data: { content: stdout, empty: stdout.length === 0 } };
          } catch { /* tool missing or display error — try next */ }
          // Try xsel
          try {
            const { stdout } = await this.runner('xsel', ['--clipboard', '--output'], 3000);
            return { success: true, output: stdout, data: { content: stdout, empty: stdout.length === 0 } };
          } catch { /* try next */ }
          // Try wl-paste (Wayland)
          try {
            const { stdout } = await this.runner('wl-paste', [], 3000);
            return { success: true, output: stdout, data: { content: stdout, empty: stdout.length === 0 } };
          } catch { /* try next */ }
          return { success: false, output: '', error: READ_UNAVAILABLE_ERROR };
        }

        case 'write': {
          const text = args.text as string;
          if (text === undefined) return { success: false, output: '', error: 'Text is required' };
          // stdin-fed spawn (no shell injection surface); input routed
          // through the runner seam so writes are testable.
          try {
            await this.runner('xclip', ['-selection', 'clipboard'], 3000, text);
          } catch { try {
            await this.runner('xsel', ['--clipboard', '--input'], 3000, text);
          } catch { try {
            await this.runner('wl-copy', [], 3000, text);
          } catch {
            return { success: false, output: '', error: NO_TOOL_ERROR };
          } } }

          // Verification-in-depth: read the clipboard BACK and compare. The
          // old code trusted the writer's exit code alone; xclip can exit 0
          // and still not own the selection (another owner takes over, or
          // the daemon exits before a reader attaches).
          await new Promise((r) => setTimeout(r, 150));
          let readBack: string | null = null;
          try {
            const { stdout } = await this.runner('xclip', ['-selection', 'clipboard', '-o'], 3000);
            readBack = stdout;
          } catch { try {
            const { stdout } = await this.runner('xsel', ['--clipboard', '--output'], 3000);
            readBack = stdout;
          } catch { try {
            const { stdout } = await this.runner('wl-paste', [], 3000);
            readBack = stdout;
          } catch {
            readBack = null;
          } } }

          if (readBack === null) {
            return {
              success: false,
              output: '',
              error: 'Clipboard write NOT verified: the write command ran but the clipboard could not be read back',
              data: { verified: false },
            };
          }
          if (readBack !== text) {
            return {
              success: false,
              output: '',
              error: `Clipboard write NOT verified: clipboard content (${readBack.length} chars) does not match what was written (${text.length} chars)`,
              data: { verified: false, expectedLength: text.length, actualLength: readBack.length },
            };
          }
          return { success: true, output: `Text copied to clipboard — verified by read-back (${text.length} chars)`, data: { verified: true, chars: text.length } };
        }

        default:
          return { success: false, output: '', error: `Unknown action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, output: '', error: `Clipboard error: ${error.message}` };
    }
  }
}
