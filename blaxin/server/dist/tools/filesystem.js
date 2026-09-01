import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from 'fs';
import { join, dirname } from 'path';
export class FileSystemTool {
    name = 'filesystem';
    description = 'Read, write, create, and manage files and directories on the system.';
    definition = {
        type: 'function',
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
    async execute(args) {
        const operation = args.operation;
        const filePath = args.path;
        if (!operation || !filePath) {
            return { success: false, output: '', error: 'Operation and path are required' };
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
                    writeFileSync(filePath, args.content || '');
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
                    const newPath = args.newPath;
                    if (!newPath)
                        return { success: false, output: '', error: 'New path required for rename' };
                    renameSync(filePath, newPath);
                    return { success: true, output: `Renamed: ${filePath} -> ${newPath}` };
                }
                default:
                    return { success: false, output: '', error: `Unknown operation: ${operation}` };
            }
        }
        catch (error) {
            return { success: false, output: '', error: error.message };
        }
    }
    requiresConfirmation(args) {
        const op = args.operation;
        return op === 'delete' || op === 'write';
    }
}
//# sourceMappingURL=filesystem.js.map