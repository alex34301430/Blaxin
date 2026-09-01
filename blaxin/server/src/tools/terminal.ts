import { Tool, ToolResult } from '../types.js';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class TerminalTool implements Tool {
  name = 'terminal';
  description = 'Execute terminal/shell commands on the system. Use this to run programs, install packages, manage files via CLI, check system status, and perform system operations.';

  definition = {
    type: 'function' as const,
    function: {
      name: 'terminal',
      description: 'Execute a shell command and return its output. Use this for system operations, running programs, installing packages, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute',
          },
          cwd: {
            type: 'string',
            description: 'Working directory (optional, defaults to home directory)',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds (optional, defaults to 30)',
          },
        },
        required: ['command'],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const command = args.command as string;
    const cwd = (args.cwd as string) || process.env.HOME || '/tmp';
    const timeout = ((args.timeout as number) || 30) * 1000;

    if (!command) {
      return { success: false, output: '', error: 'No command provided' };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        env: { ...process.env, TERM: 'dumb' },
      });

      const output = stdout.trim();
      const errorOutput = stderr.trim();

      return {
        success: true,
        output: output || (errorOutput ? `(stderr) ${errorOutput}` : '(no output)'),
        data: { stdout: output, stderr: errorOutput },
      };
    } catch (error: any) {
      const stdout = error.stdout?.trim() || '';
      const stderr = error.stderr?.trim() || error.message;
      
      return {
        success: false,
        output: stdout || '',
        error: stderr,
        data: { 
          exitCode: error.code,
          stdout,
          stderr,
        },
      };
    }
  }

  requiresConfirmation(args: Record<string, unknown>): boolean {
    const cmd = (args.command as string || '').toLowerCase();
    const dangerous = [
      'rm -rf', 'rm -r /', 'mkfs', 'dd if=', ':(){', 'fork',
      'shutdown', 'reboot', 'halt', 'init 0', 'init 6',
      'chmod -R 777', 'chown -R',
    ];
    return dangerous.some(d => cmd.includes(d));
  }
}
