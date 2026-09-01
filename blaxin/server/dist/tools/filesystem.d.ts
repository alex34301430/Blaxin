import { Tool, ToolResult } from '../types.js';
export declare class FileSystemTool implements Tool {
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
                    operation: {
                        type: string;
                        enum: string[];
                        description: string;
                    };
                    path: {
                        type: string;
                        description: string;
                    };
                    content: {
                        type: string;
                        description: string;
                    };
                    newPath: {
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
//# sourceMappingURL=filesystem.d.ts.map