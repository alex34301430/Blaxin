import { Tool, ToolResult } from '../types.js';
export declare class TerminalTool implements Tool {
    name: string;
    description: string;
    definition: {
        type: "function";
        function: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    command: {
                        type: string;
                        description: string;
                    };
                    cwd: {
                        type: string;
                        description: string;
                    };
                    timeout: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
    };
    execute(args: Record<string, unknown>): Promise<ToolResult>;
    requiresConfirmation(args: Record<string, unknown>): boolean;
}
//# sourceMappingURL=terminal.d.ts.map