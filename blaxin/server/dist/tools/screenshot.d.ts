import { Tool, ToolResult } from '../types.js';
export declare class ScreenshotTool implements Tool {
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
                    region: {
                        type: string;
                        description: string;
                    };
                    window: {
                        type: string;
                        description: string;
                    };
                };
                required: never[];
            };
        };
    };
    execute(args: Record<string, unknown>): Promise<ToolResult>;
}
//# sourceMappingURL=screenshot.d.ts.map