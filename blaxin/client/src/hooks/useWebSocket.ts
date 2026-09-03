import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../utils/store';
import { getWsUrl } from '../services/endpoints';

const HEARTBEAT_INTERVAL_MS = 25000;
const RECONNECT_DELAY_MS = 3000;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const {
    setConnected,
    setAgentState,
    setAgentDescription,
    addMessage,
    addToolExecution,
    setProviders,
    setActiveProvider,
    setActiveModel,
    setModels,
    setLastError,
    setPendingConfirmation,
  } = useAppStore();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(getWsUrl('/ws'));
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        console.log('[BLAXIN] WebSocket connected');

        // Heartbeat keeps dead connections from lingering silently
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        heartbeatRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, HEARTBEAT_INTERVAL_MS);
      };

      ws.onclose = () => {
        setConnected(false);
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        console.log('[BLAXIN] WebSocket disconnected, reconnecting...');
        reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      ws.onerror = (error) => {
        console.error('[BLAXIN] WebSocket error:', error);
      };

      ws.onmessage = (event) => {
        try {
          const { event: eventType, data } = JSON.parse(event.data);

          switch (eventType) {
            case 'connected':
              if (data.state) {
                setAgentState(data.state);
                setAgentDescription(data.description || null);
              }
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
              setAgentDescription(data.description || null);
              // When the agent goes idle/completed/error, drop stale confirmations
              if (['idle', 'completed', 'error'].includes(data.state)) {
                setPendingConfirmation(null);
              }
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

            case 'confirmation-required':
              if (data && data.description) {
                setPendingConfirmation({
                  taskId: data.taskId,
                  stepId: data.stepId,
                  description: data.description,
                  action: typeof data.action === 'string' ? data.action : JSON.stringify(data.action || {}),
                });
              }
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

            case 'provider-status':
            case 'pong':
            case 'task-progress':
              // Informational — no client state change required
              break;
          }
        } catch (err) {
          console.error('[BLAXIN] Failed to parse message:', err);
        }
      };
    } catch (err) {
      console.error('[BLAXIN] Connection failed:', err);
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimerRef.current);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((payload: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const sendMessage = useCallback((content: string) => {
    send({ type: 'user-message', data: { content } });
  }, [send]);

  const stopAgent = useCallback(() => {
    send({ type: 'stop' });
  }, [send]);

  const clearHistory = useCallback(() => {
    send({ type: 'clear' });
    useAppStore.getState().clearMessages();
    useAppStore.getState().clearToolExecutions();
  }, [send]);

  const respondToConfirmation = useCallback((approved: boolean) => {
    const conf = useAppStore.getState().pendingConfirmation;
    if (!conf) return;
    send({
      type: 'confirmation-response',
      data: {
        taskId: conf.taskId,
        stepId: conf.stepId,
        approved,
      },
    });
    useAppStore.getState().setPendingConfirmation(null);
  }, [send]);

  return {
    sendMessage,
    stopAgent,
    clearHistory,
    respondToConfirmation,
  };
}
