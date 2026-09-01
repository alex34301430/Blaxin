import { Tool, ToolResult } from '../types.js';
export declare class ClipboardTool implements Tool {
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
                    action: {
                        type: string;
                        enum: string[];
                        description: string;
                    };
                    text: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
    };
    execute(args: Record<string, unknown>): Promise<ToolResult>;
}
//# sourceMappingURL=clipboard.d.ts.map