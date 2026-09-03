import { Tool, ToolResult } from '../types.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync, realpathSync } from 'fs';
import { join, dirname, resolve, parse } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

// Paths BLAXIN refuses to mutate. These are system-critical or hold
// credentials. Reads remain possible; destructive/write operations are
// blocked even when the user is prompted, because mistakes here are
// unrecoverable and these paths are never legitimate write targets for
// a desktop assistant.
const PROTECTED_ROOTS = [
  '/etc', '/usr', '/boot', '/bin', '/sbin', '/lib', '/lib64',
  '/proc', '/sys', '/dev', '/run', '/root', '/srv',
  '/var/lib', '/var/cache', '/var/log', '/var/backups', '/var/spool',
];

const PROTECTED_HOME_DIRS = [
  '.ssh', '.gnupg', '.aws', '.kube', '.config/rclone', '.password-store',
  '.local/share/keyrings', '.mozilla', '.config/google-chrome',
  '.config/chromium', '.config/BraveSoftware', '.docker',
];

const SENSITIVE_FILE_NAMES = [
  '.blaxin-credentials', '.netrc', '.npmrc', '.pypirc',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'credentials', 'credentials.json',
];

function isProtectedPath(filePath: string): boolean {
  let abs = resolve(filePath);
  try {
    if (existsSync(abs)) abs = realpathSync(abs);
  } catch { /* keep resolved path */ }

  const { dir, base } = parse(abs);
  const loweredBase = base.toLowerCase();

  // Sensitive file names anywhere in the tree
  if (SENSITIVE_FILE_NAMES.includes(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  if (!base.endsWith('.pub') && (
    loweredBase.endsWith('.pem') ||
    loweredBase.endsWith('.key') ||
    loweredBase.endsWith('.p12') ||
    loweredBase.endsWith('.pfx') ||
    loweredBase.endsWith('.kdbx')
  )) {
    return true;
  }

  // Protected system roots
  if (PROTECTED_ROOTS.some((root) => abs === root || abs.startsWith(root + '/'))) {
    return true;
  }

  // Protected home subdirectories (credentials, browser profiles)
  const home = homedir();
  if (home && (abs === home || abs.startsWith(home + '/'))) {
    const rel = abs.slice(home.length + 1);
    if (PROTECTED_HOME_DIRS.some((d) => rel === d || rel.startsWith(d + '/'))) {
      return true;
    }
  }

  return false;
}

export class FileSystemTool implements Tool {
  name = 'filesystem';
  description = 'Read, write, create, and manage files and directories on the system.';

  definition = {
    type: 'function' as const,
    function: {
      name: 'filesystem',
      description: 'Perform file system operations: read, write, create, delete, list, and get info about files and directories.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['read', 'write', 'create_dir', 'delete', 'list', 'info', 'exists', 'rename'],
            description: 'The file system operation to perform',
          },
          path: {
            type: 'string',
            description: 'The file or directory path',
          },
          content: {
            type: 'string',
            description: 'Content to write (for write operation)',
          },
          newPath: {
            type: 'string',
            description: 'New path for rename operation',
          },
        },
        required: ['operation', 'path'],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const operation = args.operation as string;
    const filePath = args.path as string;

    if (!operation || !filePath) {
      return { success: false, output: '', error: 'Operation and path are required' };
    }

    const destructive = ['delete', 'write', 'rename', 'create_dir'].includes(operation);
    if (destructive && isProtectedPath(filePath)) {
      logger.warn('filesystem', `Blocked ${operation} on protected path: ${filePath}`);
      return {
        success: false,
        output: '',
        error: `BLAXIN protects ${filePath} from ${operation}. This path is system-critical or holds credentials. Use the terminal with care only if you are sure.`,
      };
    }
    if (operation === 'rename' && args.newPath && isProtectedPath(args.newPath as string)) {
      logger.warn('filesystem', `Blocked rename to protected path: ${args.newPath}`);
      return {
        success: false,
        output: '',
        error: `BLAXIN protects ${args.newPath} from being a rename target. This path is system-critical or holds credentials.`,
      };
    }

    try {
      switch (operation) {
        case 'read': {
          if (!existsSync(filePath)) {
            return { success: false, output: '', error: `File not found: ${filePath}` };
          }
          const content = readFileSync(filePath, 'utf-8');
          return { success: true, output: content.slice(0, 50000), data: { filePath, length: content.length } };
        }

        case 'write': {
          const dir = dirname(filePath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(filePath, args.content as string || '');
          return { success: true, output: `File written: ${filePath}` };
        }

        case 'create_dir': {
          mkdirSync(filePath, { recursive: true });
          return { success: true, output: `Directory created: ${filePath}` };
        }

        case 'delete': {
          if (!existsSync(filePath)) {
            return { success: false, output: '', error: `Path not found: ${filePath}` };
          }
          const stat = statSync(filePath);
          if (stat.isDirectory()) {
            // Don't recursively delete directories
            return { success: false, output: '', error: 'Use terminal with rm -rf to delete directories. This tool only deletes files.' };
          }
          unlinkSync(filePath);
          return { success: true, output: `File deleted: ${filePath}` };
        }

        case 'list': {
          if (!existsSync(filePath)) {
            return { success: false, output: '', error: `Directory not found: ${filePath}` };
          }
          const items = readdirSync(filePath);
          const details = items.map(item => {
            const fullPath = join(filePath, item);
            const stats = statSync(fullPath);
            return `${stats.isDirectory() ? '[DIR]' : '[FILE]'} ${item} (${stats.size} bytes)`;
          });
          return { success: true, output: details.join('\n'), data: { items, count: items.length } };
        }

        case 'info': {
          if (!existsSync(filePath)) {
            return { success: false, output: '', error: `Path not found: ${filePath}` };
          }
          const stats = statSync(filePath);
          return {
            success: true,
            output: JSON.stringify({
              path: filePath,
              type: stats.isDirectory() ? 'directory' : 'file',
              size: stats.size,
              created: stats.birthtime.toISOString(),
              modified: stats.mtime.toISOString(),
              permissions: stats.mode.toString(8),
            }, null, 2),
          };
        }

        case 'exists': {
          const exists = existsSync(filePath);
          return { success: true, output: exists ? 'Exists' : 'Does not exist', data: { exists } };
        }

        case 'rename': {
          const newPath = args.newPath as string;
          if (!newPath) return { success: false, output: '', error: 'New path required for rename' };
          renameSync(filePath, newPath);
          return { success: true, output: `Renamed: ${filePath} -> ${newPath}` };
        }

        default:
          return { success: false, output: '', error: `Unknown operation: ${operation}` };
      }
    } catch (error: any) {
      return { success: false, output: '', error: error.message };
    }
  }

  requiresConfirmation(args: Record<string, unknown>): boolean {
    const op = args.operation as string;
    return op === 'delete' || op === 'write';
  }
}
