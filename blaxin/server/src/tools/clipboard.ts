import { Tool, ToolResult } from '../types.js';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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

  private writeToStdin(command: string, args: string[], input: string, timeout = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        timeout,
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
      });
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        proc.kill();
        reject(new Error('Timeout'));
      }, timeout);

      proc.stdin.write(input);
      proc.stdin.end();

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (killed) return;
        if (code === 0) resolve();
        else reject(new Error(`Exit code ${code}`));
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!killed) reject(err);
      });
    });
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;
    const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };

    try {
      switch (action) {
        case 'read': {
          // Try xclip
          try {
            const { stdout } = await execFileAsync('xclip', ['-selection', 'clipboard', '-o'], {
              timeout: 3000,
              env,
            });
            return { success: true, output: stdout, data: { content: stdout } };
          } catch {}
          // Try xsel
          try {
            const { stdout } = await execFileAsync('xsel', ['--clipboard', '--output'], {
              timeout: 3000,
              env,
            });
            return { success: true, output: stdout, data: { content: stdout } };
          } catch {}
          // Try wl-paste (Wayland)
          try {
            const { stdout } = await execFileAsync('wl-paste', [], {
              timeout: 3000,
            });
            return { success: true, output: stdout, data: { content: stdout } };
          } catch {}
          return { success: false, output: '', error: 'No clipboard tool available. Install xclip, xsel, or wl-clipboard.' };
        }

        case 'write': {
          const text = args.text as string;
          if (text === undefined) return { success: false, output: '', error: 'Text is required' };
          // Use spawn with stdin to avoid shell injection
          try {
            await this.writeToStdin('xclip', ['-selection', 'clipboard'], text);
            return { success: true, output: 'Text copied to clipboard' };
          } catch {}
          // Try xsel
          try {
            await this.writeToStdin('xsel', ['--clipboard', '--input'], text);
            return { success: true, output: 'Text copied to clipboard' };
          } catch {}
          // Try wl-copy (Wayland)
          try {
            await this.writeToStdin('wl-copy', [], text);
            return { success: true, output: 'Text copied to clipboard' };
          } catch {}
          return { success: false, output: '', error: 'No clipboard tool available. Install xclip, xsel, or wl-clipboard.' };
        }

        default:
          return { success: false, output: '', error: `Unknown action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, output: '', error: `Clipboard error: ${error.message}` };
    }
  }
}
