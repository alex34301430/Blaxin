import React from 'react';
import { useAppStore } from '../utils/store';
import { FiWifi, FiWifiOff, FiCpu, FiSquare, FiTrash2, FiMic } from 'react-icons/fi';

const stateColors: Record<string, string> = {
  idle: 'var(--text-muted)',
  thinking: 'var(--accent-yellow)',
  planning: 'var(--accent-secondary)',
  executing: 'var(--accent-primary)',
  observing: 'var(--accent-green)',
  waiting: 'var(--accent-yellow)',
  completed: 'var(--accent-green)',
  error: 'var(--accent-red)',
  'requires-confirmation': 'var(--accent-yellow)',
};

const stateLabels: Record<string, string> = {
  idle: 'IDLE',
  thinking: 'THINKING',
  planning: 'PLANNING',
  executing: 'EXECUTING',
  observing: 'OBSERVING',
  waiting: 'WAITING',
  completed: 'DONE',
  error: 'ERROR',
  'requires-confirmation': 'CONFIRM',
};

export function StatusBar({ onStop, onClear }: { onStop: () => void; onClear: () => void }) {
  const { connected, agentState, agentDescription, activeProvider, activeModel, messages, isListening } = useAppStore();

  const showActivity = agentState !== 'idle' && agentState !== 'completed' && agentState !== 'error';

  return (
    <div style={{
      height: 40,
      background: 'var(--bg-secondary)',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px',
      gap: 16,
      fontSize: 11,
      fontFamily: 'var(--font-mono)',
      position: 'relative',
      zIndex: 2,
    }}>
      {/* Connection Status */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        color: connected ? 'var(--accent-green)' : 'var(--accent-red)',
      }}>
        {connected ? <FiWifi size={12} /> : <FiWifiOff size={12} />}
        <span>{connected ? 'LIVE' : 'OFFLINE'}</span>
      </div>

      <div style={{ 
        width: 1, 
        height: 20, 
        background: 'var(--border-subtle)' 
      }} />

      {/* Agent State */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        color: stateColors[agentState] || 'var(--text-muted)',
      }}>
        <div style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: stateColors[agentState],
          boxShadow: agentState !== 'idle' ? `0 0 8px ${stateColors[agentState]}` : 'none',
          animation: ['thinking', 'planning', 'executing', 'observing'].includes(agentState) 
            ? 'pulse-glow 1.5s ease-in-out infinite' 
            : 'none',
        }} />
        <span style={{ letterSpacing: 1 }}>
          {stateLabels[agentState] || agentState.toUpperCase()}
        </span>
      </div>

      <div style={{ 
        width: 1, 
        height: 20, 
        background: 'var(--border-subtle)' 
      }} />

      {/* Provider & Model */}
      {activeProvider && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--text-secondary)',
        }}>
          <FiCpu size={12} color="var(--accent-secondary)" />
          <span>{activeProvider}</span>
          {activeModel && (
            <>
              <span style={{ color: 'var(--text-muted)' }}>•</span>
              <span style={{ color: 'var(--text-primary)' }}>{activeModel}</span>
            </>
          )}
        </div>
      )}

      {/* Live activity description — the user always knows what BLAXIN is doing */}
      <div style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        overflow: 'hidden',
        padding: '0 8px',
      }}>
        {showActivity && (
          <div style={{
            color: 'var(--accent-primary)',
            fontSize: 11,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '100%',
          }}>
            ▸ {agentDescription || 'Working...'}
          </div>
        )}
        {isListening && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            color: 'var(--accent-red)',
            marginLeft: 12,
            whiteSpace: 'nowrap',
          }}>
            <FiMic size={11} />
            <span style={{ letterSpacing: 1, animation: 'pulse-glow 1s ease-in-out infinite' }}>LISTENING</span>
          </div>
        )}
      </div>

      {/* Message count */}
      <div style={{
        color: 'var(--text-muted)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
      }}>
        {messages.length} messages
      </div>

      {/* Actions */}
      {agentState !== 'idle' && agentState !== 'completed' && agentState !== 'error' && (
        <button
          onClick={onStop}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 10px',
            background: 'rgba(255, 51, 85, 0.15)',
            color: 'var(--accent-red)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
          }}
        >
          <FiSquare size={10} />
          STOP
        </button>
      )}

      <button
        onClick={onClear}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 8px',
          background: 'transparent',
          color: 'var(--text-muted)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 11,
        }}
        title="Clear conversation"
      >
        <FiTrash2 size={12} />
      </button>
    </div>
  );
}
