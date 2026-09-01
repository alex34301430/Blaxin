import React from 'react';
import { useAppStore, ToolExecution } from '../utils/store';
import { FiTerminal, FiFile, FiGlobe, FiMonitor, FiClipboard, FiSearch, FiInfo, FiZap } from 'react-icons/fi';

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

const stateColors: Record<string, string> = {
  executing: 'var(--accent-primary)',
  completed: 'var(--accent-green)',
  failed: 'var(--accent-red)',
};

export function ActivityPanel() {
  const { toolExecutions, agentState } = useAppStore();

  return (
    <div style={{
      width: 280,
      background: 'var(--bg-secondary)',
      borderLeft: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
      zIndex: 1,
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <FiZap size={14} color="var(--accent-primary)" />
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 1,
          color: 'var(--text-secondary)',
        }}>
          Activity
        </span>
        {agentState !== 'idle' && (
          <div style={{
            marginLeft: 'auto',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--accent-primary)',
            animation: 'pulse-glow 1.5s ease-in-out infinite',
          }} />
        )}
      </div>

      {/* Tool executions list */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '8px 0',
      }}>
        {toolExecutions.length === 0 && (
          <div style={{
            padding: '24px 16px',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: 12,
          }}>
            <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.3 }}>
              <FiZap size={24} />
            </div>
            No tool activity yet
          </div>
        )}

        {toolExecutions.map((exec, i) => (
          <ToolExecutionItem key={i} execution={exec} index={i} />
        ))}
      </div>
    </div>
  );
}

function ToolExecutionItem({ execution, index }: { execution: ToolExecution; index: number }) {
  const color = stateColors[execution.state] || 'var(--text-muted)';
  
  return (
    <div style={{
      padding: '8px 16px',
      borderBottom: '1px solid var(--border-subtle)',
      animation: 'fadeIn 0.2s ease',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 4,
      }}>
        <div style={{
          color,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 'var(--radius-sm)',
          background: `${color}15`,
        }}>
          {toolIcons[execution.toolName] || <FiZap size={12} />}
        </div>
        
        <div style={{ flex: 1 }}>
          <div style={{
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--text-primary)',
          }}>
            {execution.toolName}
          </div>
          <div style={{
            fontSize: 10,
            color,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            fontFamily: 'var(--font-mono)',
          }}>
            {execution.state}
          </div>
        </div>
      </div>

      {execution.result && (
        <div style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          padding: '4px 8px',
          background: 'var(--bg-primary)',
          borderRadius: 'var(--radius-sm)',
          maxHeight: 60,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {execution.result.slice(0, 150)}
        </div>
      )}
    </div>
  );
}
