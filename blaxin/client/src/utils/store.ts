import { create } from 'zustand';

export type AgentState = 'idle' | 'thinking' | 'planning' | 'executing' | 'observing' | 'waiting' | 'completed' | 'error' | 'requires-confirmation';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ToolExecution {
  toolName: string;
  args: Record<string, unknown>;
  state: string;
  result?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  isFree: boolean;
  isAvailable: boolean;
  capabilities: string[];
  contextWindow?: number;
  maxOutput?: number;
  description?: string;
  pricing?: { prompt: number; completion: number };
}

export interface ProviderStatus {
  id: string;
  name: string;
  hasKey: boolean;
  maskedKey?: string;
}

interface AppState {
  // Connection
  connected: boolean;
  setConnected: (connected: boolean) => void;

  // Agent
  agentState: AgentState;
  setAgentState: (state: AgentState) => void;
  agentDescription: string | null;
  setAgentDescription: (desc: string | null) => void;
  messages: ChatMessage[];
  addMessage: (msg: ChatMessage) => void;
  clearMessages: () => void;

  // Confirmation requests from the agent (high-impact tool actions)
  pendingConfirmation: {
    taskId?: string;
    stepId?: string;
    description: string;
    action: string;
  } | null;
  setPendingConfirmation: (conf: {
    taskId?: string;
    stepId?: string;
    description: string;
    action: string;
  } | null) => void;

  // Tools
  toolExecutions: ToolExecution[];
  addToolExecution: (exec: ToolExecution) => void;
  clearToolExecutions: () => void;

  // Providers & Models
  providers: ProviderStatus[];
  setProviders: (providers: ProviderStatus[]) => void;
  activeProvider: string | null;
  setActiveProvider: (id: string | null) => void;
  activeModel: string | null;
  setActiveModel: (id: string | null) => void;
  models: ModelInfo[];
  setModels: (models: ModelInfo[]) => void;

  // UI State
  currentPage: string;
  setCurrentPage: (page: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  // Voice
  voiceEnabled: boolean;
  setVoiceEnabled: (enabled: boolean) => void;
  ttsEnabled: boolean;
  setTtsEnabled: (enabled: boolean) => void;
  isListening: boolean;
  setIsListening: (listening: boolean) => void;
  voiceTranscript: string;
  setVoiceTranscript: (transcript: string) => void;

  // Error
  lastError: string | null;
  setLastError: (error: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  connected: false,
  setConnected: (connected) => set({ connected }),

  agentState: 'idle',
  setAgentState: (state) => set({ agentState: state }),
  agentDescription: null,
  setAgentDescription: (desc) => set({ agentDescription: desc }),
  messages: [],
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  clearMessages: () => set({ messages: [] }),

  pendingConfirmation: null,
  setPendingConfirmation: (conf) => set({ pendingConfirmation: conf }),

  toolExecutions: [],
  addToolExecution: (exec) => set((s) => ({
    toolExecutions: [...s.toolExecutions.slice(-20), exec],
  })),
  clearToolExecutions: () => set({ toolExecutions: [] }),

  providers: [],
  setProviders: (providers) => set({ providers }),
  activeProvider: null,
  setActiveProvider: (id) => set({ activeProvider: id }),
  activeModel: null,
  setActiveModel: (id) => set({ activeModel: id }),
  models: [],
  setModels: (models) => set({ models }),

  currentPage: 'chat',
  setCurrentPage: (page) => set({ currentPage: page }),
  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  voiceEnabled: false,
  setVoiceEnabled: (enabled) => set({ voiceEnabled: enabled }),
  ttsEnabled: true,
  setTtsEnabled: (enabled) => set({ ttsEnabled: enabled }),
  isListening: false,
  setIsListening: (listening) => set({ isListening: listening }),
  voiceTranscript: '',
  setVoiceTranscript: (transcript) => set({ voiceTranscript: transcript }),

  lastError: null,
  setLastError: (error) => set({ lastError: error }),
}));
