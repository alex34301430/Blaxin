import React from 'react';
import { useAppStore, ActiveTask, ActiveTaskStep, RiskTier, PermissionScope } from '../utils/store';
import {
  FiZap, FiTerminal, FiFile, FiGlobe, FiMonitor, FiClipboard, FiSearch,
  FiInfo, FiShield, FiCheckCircle, FiXCircle, FiClock, FiLoader,
} from 'react-icons/fi';

// Same palette/labels as the StatusBar so the panel never contradicts it.
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

const stepColors: Record<ActiveTaskStep['state'], string> = {
  pending: 'var(--text-muted)',
  executing: 'var(--accent-primary)',
  retrying: 'var(--accent-yellow)',
  completed: 'var(--accent-green)',
  failed: 'var(--accent-red)',
  skipped: 'var(--text-muted)',
};

const stepLabels: Record<ActiveTaskStep['state'], string> = {
  pending: 'PENDING',
  executing: 'RUNNING',
  retrying: 'RETRY',
  completed: 'DONE',
  failed: 'FAILED',
  skipped: 'SKIPPED',
};

// Risk tiers — declared danger, color-coded (never invented: server-sent).
const riskColors: Record<RiskTier, string> = {
  LOW: 'var(--accent-green)',
  MEDIUM: 'var(--accent-yellow)',
  HIGH: '#FF6B35',
  CRITICAL: 'var(--accent-red)',
};

// Permission scopes — how this step was authorized.
const scopeLabels: Record<PermissionScope, string> = {
  ALWAYS_ALLOW: 'AUTO',
  ALLOW_ONCE: 'APPROVED',
  ALLOW_TASK: 'TASK',
  ALLOW_SESSION: 'SESSION',
  DENY: 'DENIED',
};
const scopeColors: Record<PermissionScope, string> = {
  ALWAYS_ALLOW: 'var(--text-muted)',
  ALLOW_ONCE: 'var(--accent-green)',
  ALLOW_TASK: 'var(--accent-secondary)',
  ALLOW_SESSION: 'var(--accent-secondary)',
  DENY: 'var(--accent-red)',
};

const toolIcons: Record<string, React.ReactNode> = {
  terminal: <FiTerminal size={12} />,
  filesystem: <FiFile size={12} />,
  browser: <FiGlobe size={12} />,
  'computer-control': <FiMonitor size={12} />,
  clipboard: <FiClipboard size={12} />,
  search: <FiSearch size={12} />,
  'system-info': <FiInfo size={12} />,
  screenshot: <FiMonitor size={12} />,
};

function StepStateIcon({ state }: { state: ActiveTaskStep['state'] }) {
  switch (state) {
    case 'completed': return <FiCheckCircle size={11} />;
    case 'failed': return <FiXCircle size={11} />;
    case 'executing':
    case 'retrying': return <FiLoader size={11} className="spin" />;
    default: return <FiClock size={11} />;
  }
}

function StepRow({ step }: { step: ActiveTaskStep }) {
  const color = stepColors[step.state];
  const riskColor = step.riskTier ? riskColors[step.riskTier] : undefined;
  const scope = step.permissionScope;
  return (
    <div data-testid="active-task-step" style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      padding: '5px 0',
      borderBottom: '1px solid var(--border-subtle)',
      opacity: step.state === 'pending' ? 0.55 : 1,
    }}>
      <div style={{
        color,
        marginTop: 2,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
      }}>
        <StepStateIcon state={step.state} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 11,
          color: 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {step.description}
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginTop: 2,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}>
          <span style={{
            fontSize: 9,
            color,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            fontFamily: 'var(--font-mono)',
          }}>
            {stepLabels[step.state]}
          </span>
          {step.toolName && (
            <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              · {step.toolName}
            </span>
          )}
          {/* Risk tier — real server-computed value */}
          {step.riskTier && (
            <span style={{
              fontSize: 8,
              letterSpacing: 0.5,
              fontFamily: 'var(--font-mono)',
              color: riskColor,
              border: `1px solid ${riskColor}55`,
              borderRadius: 'var(--radius-sm)',
              padding: '0 4px',
              lineHeight: '14px',
            }}>
              {step.riskTier}
            </span>
          )}
          {/* Permission scope — how this step was authorized */}
          {scope && (
            <span style={{
              fontSize: 8,
              letterSpacing: 0.5,
              fontFamily: 'var(--font-mono)',
              color: scopeColors[scope],
              border: `1px solid ${scopeColors[scope]}55`,
              borderRadius: 'var(--radius-sm)',
              padding: '0 4px',
              lineHeight: '14px',
            }}>
              {scopeLabels[scope]}
            </span>
          )}
          {step.state === 'skipped' && step.error && (
            <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              — {step.error}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function ActiveTaskPanel() {
  const { currentTask, agentState } = useAppStore();
  if (!currentTask) return null;

  const task: ActiveTask = currentTask;
  const active = task.steps.filter(s => s.state === 'completed').length;
  const total = task.steps.length;
  const percent = total > 0 ? Math.round((active / total) * 100) : 0;
  const awaitingApproval = agentState === 'requires-confirmation';
  const stateColor = stateColors[agentState] || 'var(--text-muted)';

  // External-mode tasks arrive without step lists (the Brain owns the
  // steps); show state + objective honestly instead of an empty list.
  const steps: ActiveTaskStep[] = task.steps || [];

  return (
    <div style={{
      borderBottom: '1px solid var(--border-subtle)',
      background: 'var(--bg-primary)',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px 8px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <FiZap size={14} color={stateColor} />
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 1,
          color: 'var(--text-secondary)',
        }}>
          Active Task
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: stateColor,
            boxShadow: awaitingApproval || ['thinking', 'planning', 'executing', 'observing'].includes(agentState)
              ? `0 0 8px ${stateColor}` : 'none',
            animation: awaitingApproval || ['thinking', 'planning', 'executing', 'observing'].includes(agentState)
              ? 'pulse-glow 1.5s ease-in-out infinite' : 'none',
          }} />
          <span style={{ fontSize: 9, letterSpacing: 1, color: stateColor, fontFamily: 'var(--font-mono)' }}>
            {stateLabels[agentState] || String(agentState).toUpperCase()}
          </span>
        </div>
      </div>

      {/* Objective */}
      <div style={{ padding: '0 16px 8px' }}>
        <div style={{
          fontSize: 11,
          color: 'var(--text-secondary)',
          fontStyle: 'italic',
          lineHeight: 1.45,
          maxHeight: 44,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}>
          {task.instruction}
        </div>
      </div>

      {/* Progress (real step counts — never fabricated) */}
      {total > 0 && (
        <div style={{ padding: '0 16px 8px' }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 9,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
            marginBottom: 4,
          }}>
            <span>{active}/{total} steps</span>
            <span>{percent}%</span>
          </div>
          <div style={{
            height: 3,
            borderRadius: 2,
            background: 'var(--bg-secondary)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${percent}%`,
              background: 'var(--accent-primary)',
              boxShadow: '0 0 6px var(--accent-primary)',
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      )}

      {/* Awaiting approval banner */}
      {awaitingApproval && (
        <div style={{
          margin: '0 16px 8px',
          padding: '6px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'rgba(255, 204, 0, 0.08)',
          border: '1px solid rgba(255, 204, 0, 0.25)',
          borderRadius: 'var(--radius-sm)',
        }}>
          <FiShield size={11} color="var(--accent-yellow)" />
          <span style={{
            fontSize: 9,
            letterSpacing: 1,
            color: 'var(--accent-yellow)',
            fontFamily: 'var(--font-mono)',
            animation: 'pulse-glow 1.2s ease-in-out infinite',
          }}>
            AWAITING APPROVAL
          </span>
        </div>
      )}

      {/* Steps */}
      {steps.length > 0 && (
        <div style={{
          maxHeight: 220,
          overflowY: 'auto',
          padding: '0 16px 8px',
        }}>
          {steps.map(step => <StepRow key={step.id} step={step} />)}
        </div>
      )}

      {steps.length === 0 && (
        <div style={{
          padding: '0 16px 12px',
          fontSize: 10,
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
        }}>
          {task.state ? String(task.state).toUpperCase() : 'RUNNING'} — step detail unavailable (external Brain)
        </div>
      )}
    </div>
  );
}