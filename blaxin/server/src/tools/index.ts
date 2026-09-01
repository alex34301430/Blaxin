import { Tool, ToolDefinition, ToolResult } from '../types.js';
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
  private tools: Map<string, Tool> = new Map();
  private enabledTools: Set<string> = new Set();

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

  private register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    this.enabledTools.add(tool.name);
    logger.info('tools', `Registered tool: ${tool.name}`);
  }

  getTool(name: string): Tool | undefined {
    if (!this.enabledTools.has(name)) return undefined;
    return this.tools.get(name);
  }

  getAllTools(): Tool[] {
    return Array.from(this.tools.values()).filter(t => this.enabledTools.has(t.name));
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.getAllTools().map(t => t.definition);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
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
        new Promise<ToolResult>((_, reject) => 
          setTimeout(() => reject(new Error(`Tool "${name}" timed out after 30s`)), 30000)
        ),
      ]);
      
      logger.info('tools', `Tool ${name} completed: ${result.success ? 'success' : 'failed'}`);
      return result;
    } catch (error: any) {
      logger.error('tools', `Tool ${name} error: ${error.message}`);
      return { success: false, output: '', error: error.message };
    }
  }

  requiresConfirmation(name: string, args: Record<string, unknown>): boolean {
    const tool = this.tools.get(name);
    if (!tool?.requiresConfirmation) return false;
    return tool.requiresConfirmation(args);
  }

  setEnabled(name: string, enabled: boolean): void {
    if (enabled) {
      this.enabledTools.add(name);
    } else {
      this.enabledTools.delete(name);
    }
  }

  getEnabledStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    for (const [name] of this.tools) {
      status[name] = this.enabledTools.has(name);
    }
    return status;
  }

  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length > 200) {
        sanitized[key] = value.slice(0, 200) + '...';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}

export const toolRegistry = new ToolRegistry();
