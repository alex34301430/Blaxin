import { Tool, ToolDefinition, ToolResult } from '../types.js';
declare class ToolRegistry {
    private tools;
    private enabledTools;
    constructor();
    private register;
    getTool(name: string): Tool | undefined;
    getAllTools(): Tool[];
    getToolDefinitions(): ToolDefinition[];
    execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
    requiresConfirmation(name: string, args: Record<string, unknown>): boolean;
    setEnabled(name: string, enabled: boolean): void;
    getEnabledStatus(): Record<string, boolean>;
    private sanitizeArgs;
}
export declare const toolRegistry: ToolRegistry;
export {};
//# sourceMappingURL=index.d.ts.map