import { Tool, ToolResult } from '../types.js';
export declare class ComputerControlTool implements Tool {
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
                    x: {
                        type: string;
                        description: string;
                    };
                    y: {
                        type: string;
                        description: string;
                    };
                    text: {
                        type: string;
                        description: string;
                    };
                    key: {
                        type: string;
                        description: string;
                    };
                    app: {
                        type: string;
                        description: string;
                    };
                    windowTitle: {
                        type: string;
                        description: string;
                    };
                    amount: {
                        type: string;
                        description: string;
                    };
                    endX: {
                        type: string;
                        description: string;
                    };
                    endY: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
    };
    private runXdotool;
    private runXte;
    execute(args: Record<string, unknown>): Promise<ToolResult>;
    requiresConfirmation(args: Record<string, unknown>): boolean;
}
//# sourceMappingURL=computer-control.d.ts.map