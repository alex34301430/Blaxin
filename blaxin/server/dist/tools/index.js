import { TerminalTool } from './terminal.js';
import { FileSystemTool } from './filesystem.js';
import { ScreenshotTool } from './screenshot.js';
import { ComputerControlTool } from './computer-control.js';
import { BrowserTool } from './browser.js';
import { ClipboardTool } from './clipboard.js';
import { SearchTool } from './search.js';
import { SystemInfoTool } from './system-info.js';
import { logger } from '../utils/logger.js';
class ToolRegistry {
    tools = new Map();
    enabledTools = new Set();
    constructor() {
        this.register(new TerminalTool());
        this.register(new FileSystemTool());
        this.register(new ScreenshotTool());
        this.register(new ComputerControlTool());
        this.register(new BrowserTool());
        this.register(new ClipboardTool());
        this.register(new SearchTool());
        this.register(new SystemInfoTool());
    }
    register(tool) {
        this.tools.set(tool.name, tool);
        this.enabledTools.add(tool.name);
        logger.info('tools', `Registered tool: ${tool.name}`);
    }
    getTool(name) {
        if (!this.enabledTools.has(name))
            return undefined;
        return this.tools.get(name);
    }
    getAllTools() {
        return Array.from(this.tools.values()).filter(t => this.enabledTools.has(t.name));
    }
    getToolDefinitions() {
        return this.getAllTools().map(t => t.definition);
    }
    async execute(name, args) {
        const tool = this.tools.get(name);
        if (!tool) {
            return { success: false, output: '', error: `Unknown tool: ${name}` };
        }
        if (!this.enabledTools.has(name)) {
            return { success: false, output: '', error: `Tool "${name}" is disabled` };
        }
        logger.info('tools', `Executing tool: ${name}`, { args: this.sanitizeArgs(args) });
        try {
            const result = await Promise.race([
                tool.execute(args),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool "${name}" timed out after 30s`)), 30000)),
            ]);
            logger.info('tools', `Tool ${name} completed: ${result.success ? 'success' : 'failed'}`);
            return result;
        }
        catch (error) {
            logger.error('tools', `Tool ${name} error: ${error.message}`);
            return { success: false, output: '', error: error.message };
        }
    }
    requiresConfirmation(name, args) {
        const tool = this.tools.get(name);
        if (!tool?.requiresConfirmation)
            return false;
        return tool.requiresConfirmation(args);
    }
    setEnabled(name, enabled) {
        if (enabled) {
            this.enabledTools.add(name);
        }
        else {
            this.enabledTools.delete(name);
        }
    }
    getEnabledStatus() {
        const status = {};
        for (const [name] of this.tools) {
            status[name] = this.enabledTools.has(name);
        }
        return status;
    }
    sanitizeArgs(args) {
        const sanitized = {};
        for (const [key, value] of Object.entries(args)) {
            if (typeof value === 'string' && value.length > 200) {
                sanitized[key] = value.slice(0, 200) + '...';
            }
            else {
                sanitized[key] = value;
            }
        }
        return sanitized;
    }
}
export const toolRegistry = new ToolRegistry();
//# sourceMappingURL=index.js.map