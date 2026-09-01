import { Tool, ToolResult } from '../types.js';
export declare class SearchTool implements Tool {
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
                    query: {
                        type: string;
                        description: string;
                    };
                    numResults: {
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
//# sourceMappingURL=search.d.ts.map