import { ChatMessage, AgentState, AgentTask } from '../types.js';
type EventCallback = (event: string, data: any) => void;
export declare class AgentOrchestrator {
    private conversationHistory;
    private currentTask;
    private state;
    private eventCallback;
    private stepCount;
    setEventCallback(callback: EventCallback): void;
    private emit;
    private setState;
    processMessage(userMessage: string): Promise<void>;
    private executeLoop;
    private executeToolCall;
    getState(): AgentState;
    getCurrentTask(): AgentTask | null;
    getConversationHistory(): ChatMessage[];
    clearHistory(): void;
    stop(): void;
}
export declare const orchestrator: AgentOrchestrator;
export {};
//# sourceMappingURL=index.d.ts.map