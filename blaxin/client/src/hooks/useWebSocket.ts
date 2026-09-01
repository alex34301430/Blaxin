import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../utils/store';

// Build WebSocket URL relative to current page — works behind reverse proxy
const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const {
    setConnected,
    setAgentState,
    addMessage,
    addToolExecution,
    setProviders,
    setActiveProvider,
    setActiveModel,
    setModels,
    setLastError,
  } = useAppStore();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        console.log('[BLAXIN] WebSocket connected');
      };

      ws.onclose = () => {
        setConnected(false);
        console.log('[BLAXIN] WebSocket disconnected, reconnecting...');
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = (error) => {
        console.error('[BLAXIN] WebSocket error:', error);
      };

      ws.onmessage = (event) => {
        try {
          const { event: eventType, data } = JSON.parse(event.data);
          
          switch (eventType) {
            case 'connected':
              if (data.state) setAgentState(data.state);
              if (data.activeProvider) setActiveProvider(data.activeProvider);
              if (data.activeModel) setActiveModel(data.activeModel);
              break;

            case 'agent-message':
              addMessage({
                id: data.id,
                role: data.role === 'assistant' ? 'assistant' : data.role === 'user' ? 'user' : 'system',
                content: data.content,
                timestamp: data.timestamp,
              });
              break;

            case 'agent-state':
              setAgentState(data.state);
              break;

            case 'tool-execution':
              addToolExecution({
                toolName: data.toolName,
                args: data.args,
                state: data.state,
                result: data.result,
              });
              break;

            case 'error':
              setLastError(data.message);
              break;

            case 'models-list':
              setModels(data);
              break;

            case 'activity':
              // Activity updates from the agent (thinking, executing, etc.)
              if (data && data.type && data.content) {
                useAppStore.getState().addToolExecution({
                  toolName: data.type,
                  args: {},
                  state: 'executing',
                  result: data.content.slice(0, 200),
                });
              }
              break;

            case 'confirmation-required':
              // Handle confirmation requests
              if (data && data.description) {
                useAppStore.getState().setLastError(
                  `Confirmation needed: ${data.description}`
                );
              }
              break;

            case 'provider-status':
              // Update provider status
              break;

            case 'pong':
              // Heartbeat response
              break;
          }
        } catch (err) {
          console.error('[BLAXIN] Failed to parse message:', err);
        }
      };
    } catch (err) {
      console.error('[BLAXIN] Connection failed:', err);
      reconnectTimerRef.current = setTimeout(connect, 3000);
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const sendMessage = useCallback((content: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'user-message',
        data: { content },
      }));
    }
  }, []);

  const stopAgent = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
    }
  }, []);

  const clearHistory = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'clear' }));
    }
    useAppStore.getState().clearMessages();
    useAppStore.getState().clearToolExecutions();
  }, []);

  return { sendMessage, stopAgent, clearHistory };
}
