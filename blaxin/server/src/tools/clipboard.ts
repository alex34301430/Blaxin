import { Tool, ToolResult } from '../types.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;

    try {
      switch (action) {
        case 'read': {
          // Try xclip
          try {
            const { stdout } = await execAsync('DISPLAY=:0 xclip -selection clipboard -o', { timeout: 3000 });
            return { success: true, output: stdout, data: { content: stdout } };
          } catch {}
          // Try xsel
          try {
            const { stdout } = await execAsync('DISPLAY=:0 xsel --clipboard --output', { timeout: 3000 });
            return { success: true, output: stdout, data: { content: stdout } };
          } catch {}
          return { success: false, output: '', error: 'No clipboard tool available. Install xclip or xsel.' };
        }

        case 'write': {
          const text = args.text as string;
          if (text === undefined) return { success: false, output: '', error: 'Text is required' };
          // Try xclip
          try {
            await execAsync(`DISPLAY=:0 echo -n ${JSON.stringify(text)} | xclip -selection clipboard`, { timeout: 3000 });
            return { success: true, output: 'Text copied to clipboard' };
          } catch {}
          // Try xsel
          try {
            await execAsync(`DISPLAY=:0 echo -n ${JSON.stringify(text)} | xsel --clipboard --input`, { timeout: 3000 });
            return { success: true, output: 'Text copied to clipboard' };
          } catch {}
          return { success: false, output: '', error: 'No clipboard tool available. Install xclip or xsel.' };
        }

        default:
          return { success: false, output: '', error: `Unknown action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, output: '', error: `Clipboard error: ${error.message}` };
    }
  }
}
