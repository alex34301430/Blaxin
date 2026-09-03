import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../utils/store';
import { FiAlertTriangle, FiCheck, FiX, FiShield } from 'react-icons/fi';

/**
 * Confirmation gate for high-impact agent tool actions.
 * BLAXIN never silently executes operations the user must approve
 * (deletes, destructive shell commands, installs, etc.). When the
 * orchestrator emits `confirmation-required`, this modal explains
 * what the agent wants to do and asks for explicit approval.
 */
export function ConfirmationModal({
  onRespond,
}: {
  onRespond: (approved: boolean) => void;
}) {
  const { pendingConfirmation, agentState } = useAppStore();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (pendingConfirmation) {
      cancelRef.current?.focus();
    }
  }, [pendingConfirmation]);

  if (!pendingConfirmation) return null;

  let actionLabel = '';
  let actionDetail: string | null = null;
  try {
    const parsed = JSON.parse(pendingConfirmation.action);
    if (parsed?.tool) {
      actionLabel = String(parsed.tool);
    }
    if (parsed?.args) {
      const command = parsed.args?.command;
      actionDetail = typeof command === 'string' ? command : null;
    }
  } catch {
    actionLabel = pendingConfirmation.action.slice(0, 120);
  }

  const agentRunning = ['requires-confirmation', 'executing', 'thinking', 'observing', 'waiting', 'planning'].includes(agentState);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 300,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
        style={{
          width: 520,
          maxWidth: '90vw',
          background: 'var(--bg-secondary)',
          border: '1px solid rgba(255, 170, 0, 0.4)',
          borderRadius: 'var(--radius-xl)',
          overflow: 'hidden',
          boxShadow: '0 0 60px rgba(255, 170, 0, 0.12)',
        }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32,
            height: 32,
            borderRadius: 'var(--radius-md)',
            background: 'rgba(255, 170, 0, 0.15)',
            color: 'var(--accent-yellow)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <FiShield size={16} />
          </div>
          <div style={{ flex: 1 }}>
            <div id="confirmation-title" style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              BLAXIN needs your approval
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', letterSpacing: 0.5 }}>
              HIGH-IMPACT ACTION
            </div>
          </div>
        </div>

        <div style={{ padding: '20px' }}>
          <div style={{
            padding: '12px 14px',
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            marginBottom: 12,
            fontSize: 13,
            color: 'var(--text-primary)',
            lineHeight: 1.6,
          }}>
            {pendingConfirmation.description}
          </div>

          {actionLabel && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>
              Tool: <span style={{ color: 'var(--accent-primary)' }}>{actionLabel}</span>
              {actionDetail && (
                <div style={{ marginTop: 4, padding: '8px 10px', background: 'rgba(0, 0, 0, 0.3)', borderRadius: 'var(--radius-sm)', overflowWrap: 'break-word' }}>
                  {actionDetail}
                </div>
              )}
            </div>
          )}

          {!agentRunning && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginTop: 8,
              padding: '8px 10px', background: 'rgba(255, 51, 85, 0.08)',
              border: '1px solid rgba(255, 51, 85, 0.25)', borderRadius: 'var(--radius-sm)',
              fontSize: 11, color: 'var(--accent-red)',
            }}>
              <FiAlertTriangle size={12} />
              The agent is no longer running. This request has expired.
            </div>
          )}
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            ref={cancelRef}
            onClick={() => onRespond(false)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)', borderRadius: 'var(--radius-md)',
              fontSize: 13, border: '1px solid var(--border-subtle)',
            }}
          >
            <FiX size={12} /> Deny
          </button>
          <button
            onClick={() => onRespond(true)}
            disabled={!agentRunning}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 18px', background: 'linear-gradient(135deg, #ffaa00, #ff6600)',
              color: '#000', borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 600,
              opacity: agentRunning ? 1 : 0.4,
            }}
          >
            <FiCheck size={12} /> Approve
          </button>
        </div>
      </div>
    </div>
  );
}
