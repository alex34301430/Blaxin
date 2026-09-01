import { Tool, ToolResult } from '../types.js';
export declare class SystemInfoTool implements Tool {
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
                    info: {
                        type: string;
                        enum: string[];
                        description: string;
                    };
                };
                required: string[];
            };
        };
    };
    execute(args: Record<string, unknown>): Promise<ToolResult>;
}
//# sourceMappingURL=system-info.d.ts.map