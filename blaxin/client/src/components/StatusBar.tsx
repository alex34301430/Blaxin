import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../utils/store';
import { FiWifi, FiWifiOff, FiCpu, FiSquare, FiTrash2, FiMic, FiCpu as FiBrainIcon } from 'react-icons/fi';

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
  const { connected, agentState, agentDescription, activeProvider, activeModel, messages, isListening, brainStatus, setCurrentPage } = useAppStore();
  const liveRef = useRef<HTMLSpanElement>(null);
  const lastAnnouncedState = useRef<string | null>(null);

  // Screen-reader live region: announce real agent-state transitions in
  // plain words (never animation-only). The status bar is visible on every
  // page, so users hear about task progress even outside the Chat tab.
  useEffect(() => {
    if (!connected) return;
    const prev = lastAnnouncedState.current;
    lastAnnouncedState.current = agentState;
    if (prev === agentState) return;
    if (prev === null) return; // boot — don't announce the initial idle
    if (agentState === 'idle' && prev === 'idle') return;

    const text: Record<string, string> = {
      idle: 'BLAXIN is idle',
      thinking: 'BLAXIN is thinking',
      planning: 'BLAXIN is planning',
      executing: 'BLAXIN is executing an action',
      observing: 'BLAXIN is observing the result',
      waiting: 'BLAXIN is waiting',
      'requires-confirmation': 'BLAXIN needs your approval',
      completed: agentDescription && !agentDescription.toLowerCase().includes('completed')
        ? `Task completed: ${agentDescription}`
        : 'Task completed',
      error: agentDescription ? `BLAXIN error: ${agentDescription}` : 'BLAXIN encountered an error',
    };
    const msg = text[agentState] || `BLAXIN state: ${agentState}`;
    const el = liveRef.current;
    if (!el) return;
    el.textContent = '';
    // Re-set on the next frame so identical text is still re-announced.
    requestAnimationFrame(() => { el.textContent = msg; });
  }, [agentState, agentDescription, connected]);

  const showActivity = agentState !== 'idle' && agentState !== 'completed' && agentState !== 'error';

  // Brain badge — mirror of the authoritative server status. Every link
  // state the server reports is shown with its own truthful color: green
  // only for CONNECTED, yellow for transient link states (connecting /
  // reconnecting / degraded), red for terminal failures (revoked /
  // incompatible / error). Local (embedded) mode is labelled as such;
  // clicking opens the Brain page.
  const brainExternal = brainStatus?.mode === 'external';
  const brainLink = brainStatus?.brain ?? null;
  const brainState = brainLink?.state ?? null;
  const chipStyle: Record<string, { color: string; label: string }> = {
    CONNECTED: { color: 'var(--accent-green)', label: 'BRAIN ONLINE' },
    CONNECTING: { color: 'var(--accent-yellow)', label: 'BRAIN CONNECTING' },
    AUTHENTICATING: { color: 'var(--accent-yellow)', label: 'BRAIN AUTHENTICATING' },
    RECONNECTING: { color: 'var(--accent-yellow)', label: 'BRAIN RECONNECTING' },
    DEGRADED: { color: 'var(--accent-yellow)', label: 'BRAIN DEGRADED' },
    REVOKED: { color: 'var(--accent-red)', label: 'BRAIN REVOKED' },
    INCOMPATIBLE: { color: 'var(--accent-red)', label: 'BRAIN INCOMPATIBLE' },
    ERROR: { color: 'var(--accent-red)', label: 'BRAIN ERROR' },
    DISCONNECTED: { color: 'var(--text-muted)', label: 'BRAIN OFFLINE' },
  };
  const chip = brainState ? (chipStyle[brainState] ?? { color: 'var(--accent-red)', label: `BRAIN ${brainState.toUpperCase()}` }) : null;
  const brainChip = brainStatus === null ? null : brainExternal
    ? (chip ?? { color: 'var(--text-muted)', label: 'BRAIN OFFLINE' })
    : { color: 'var(--text-muted)', label: 'BRAIN LOCAL' };
  const brainChipTitle = brainExternal
    ? `${brainState ?? 'DISCONNECTED'}${brainLink?.lastError ? ` — ${brainLink.lastError}` : ''} — open Brain panel`
    : 'Embedded (local) Brain — open Brain panel';

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
      {/* Visually hidden polite live region (screen readers). */}
      <span
        ref={liveRef}
        role="status"
        style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' }}
      />
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

      {/* Brain badge */}
      {brainChip && (
        <>
          <button
            onClick={() => setCurrentPage('brain')}
            title={brainChipTitle}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
              color: brainChip.color, fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 1,
            }}
          >
            <FiBrainIcon size={11} />
            {brainChip.label}
          </button>
          <div style={{ width: 1, height: 20, background: 'var(--border-subtle)' }} />
        </>
      )}

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
        aria-label="Clear conversation"
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
