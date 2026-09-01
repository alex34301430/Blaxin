import { Tool, ToolResult } from '../types.js';
export declare class BrowserTool implements Tool {
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
                    url: {
                        type: string;
                        description: string;
                    };
                    query: {
                        type: string;
                        description: string;
                    };
                    browser: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
    };
    private findBrowser;
    execute(args: Record<string, unknown>): Promise<ToolResult>;
    requiresConfirmation(args: Record<string, unknown>): boolean;
}
//# sourceMappingURL=browser.d.ts.map