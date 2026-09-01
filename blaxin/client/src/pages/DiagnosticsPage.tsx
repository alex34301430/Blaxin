import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { 
  FiMonitor, FiCheck, FiX, FiAlertTriangle, FiRefreshCw, 
  FiLoader, FiServer, FiCpu, FiTool, FiGlobe, FiFile,
  FiZap, FiShield, FiWifi, FiWifiOff
} from 'react-icons/fi';

interface DiagnosticCheck {
  name: string;
  status: 'ok' | 'warning' | 'error' | 'unknown';
  message: string;
  details?: string;
  suggestion?: string;
}

interface DiagnosticGroup {
  name: string;
  icon: string;
  checks: DiagnosticCheck[];
}

const groupIcons: Record<string, React.ReactNode> = {
  server: <FiServer size={14} />,
  cpu: <FiCpu size={14} />,
  tool: <FiTool size={14} />,
  monitor: <FiMonitor size={14} />,
  globe: <FiGlobe size={14} />,
  file: <FiFile size={14} />,
};

const statusConfig: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  ok: { color: 'var(--accent-green)', icon: <FiCheck size={12} />, label: 'OK' },
  warning: { color: 'var(--accent-yellow)', icon: <FiAlertTriangle size={12} />, label: 'WARN' },
  error: { color: 'var(--accent-red)', icon: <FiX size={12} />, label: 'FAIL' },
  unknown: { color: 'var(--text-muted)', icon: <FiAlertTriangle size={12} />, label: '???' },
};

export function DiagnosticsPage() {
  const [result, setResult] = useState<{ overall: string; groups: DiagnosticGroup[]; timestamp: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const runDiagnostics = async () => {
    setLoading(true);
    try {
      const data = await api.diagnostics();
      setResult(data);
      setLastRun(new Date().toLocaleTimeString());
    } catch (err: any) {
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runDiagnostics();
  }, []);

  const overallConfig = result
    ? statusConfig[result.overall] || statusConfig.unknown
    : null;

  return (
    <div style={{
      flex: 1,
      overflow: 'auto',
      padding: 24,
    }}>
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between', 
        marginBottom: 24 
      }}>
        <div>
          <h2 style={{ 
            fontSize: 20, 
            fontWeight: 700, 
            marginBottom: 4, 
            display: 'flex', 
            alignItems: 'center', 
            gap: 10,
            color: 'var(--text-primary)',
          }}>
            <FiMonitor size={20} color="var(--accent-primary)" /> 
            System Diagnostics
          </h2>
          <p style={{ 
            fontSize: 13, 
            color: 'var(--text-secondary)',
          }}>
            Check all BLAXIN components and dependencies
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {lastRun && (
            <span style={{ 
              fontSize: 11, 
              color: 'var(--text-muted)', 
              fontFamily: 'var(--font-mono)' 
            }}>
              Last: {lastRun}
            </span>
          )}
          <button
            onClick={runDiagnostics}
            disabled={loading}
            style={{
              padding: '8px 16px',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              borderRadius: 'var(--radius-md)',
              fontSize: 12,
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <FiRefreshCw size={12} className={loading ? 'spin' : ''} />
            {loading ? 'Running...' : 'Re-run'}
          </button>
        </div>
      </div>

      {/* Overall status banner */}
      {overallConfig && (
        <div style={{
          padding: '14px 18px',
          background: `${overallConfig.color}10`,
          border: `1px solid ${overallConfig.color}30`,
          borderRadius: 'var(--radius-md)',
          marginBottom: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <div style={{ color: overallConfig.color, display: 'flex', alignItems: 'center', gap: 6 }}>
            {overallConfig.icon}
            <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: 1, fontSize: 14 }}>
              SYSTEM {overallConfig.label.toUpperCase()}
            </span>
          </div>
          <div style={{ flex: 1 }} />
          {result && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {result.groups.reduce((sum, g) => sum + g.checks.filter(c => c.status === 'error').length, 0)} errors,{' '}
              {result.groups.reduce((sum, g) => sum + g.checks.filter(c => c.status === 'warning').length, 0)} warnings
            </span>
          )}
        </div>
      )}

      {/* Loading state */}
      {loading && !result && (
        <div style={{
          padding: '60px',
          textAlign: 'center',
          color: 'var(--accent-primary)',
        }}>
          <FiLoader size={28} className="spin" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 13 }}>Running diagnostics...</div>
        </div>
      )}

      {/* Diagnostic groups */}
      {result && result.groups.map((group, gi) => (
        <div
          key={gi}
          style={{
            marginBottom: 16,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}
        >
          {/* Group header */}
          <div style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'var(--bg-tertiary)',
          }}>
            <div style={{ color: 'var(--accent-primary)', display: 'flex' }}>
              {groupIcons[group.icon] || <FiZap size={14} />}
            </div>
            <span style={{
              fontSize: 12,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 1,
              color: 'var(--text-secondary)',
            }}>
              {group.name}
            </span>
            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', gap: 4 }}>
              {group.checks.map((check, ci) => (
                <div
                  key={ci}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: statusConfig[check.status]?.color || 'var(--text-muted)',
                  }}
                  title={check.message}
                />
              ))}
            </div>
          </div>

          {/* Checks */}
          <div style={{ padding: '4px 0' }}>
            {group.checks.map((check, ci) => {
              const cfg = statusConfig[check.status] || statusConfig.unknown;
              return (
                <div
                  key={ci}
                  style={{
                    padding: '8px 16px',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                  }}
                >
                  <div style={{
                    width: 22,
                    height: 22,
                    borderRadius: 'var(--radius-sm)',
                    background: `${cfg.color}15`,
                    color: cfg.color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: 1,
                  }}>
                    {cfg.icon}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: 'var(--text-primary)',
                      marginBottom: 2,
                    }}>
                      {check.message}
                    </div>
                    {check.details && (
                      <div style={{
                        fontSize: 11,
                        color: 'var(--text-muted)',
                        fontFamily: 'var(--font-mono)',
                      }}>
                        {check.details}
                      </div>
                    )}
                    {check.suggestion && (
                      <div style={{
                        marginTop: 4,
                        padding: '6px 10px',
                        background: `${cfg.color}08`,
                        border: `1px solid ${cfg.color}20`,
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 11,
                        color: cfg.color,
                        lineHeight: 1.5,
                      }}>
                        💡 {check.suggestion}
                      </div>
                    )}
                  </div>

                  <div style={{
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 9,
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 700,
                    letterSpacing: 0.5,
                    background: `${cfg.color}15`,
                    color: cfg.color,
                    flexShrink: 0,
                  }}>
                    {cfg.label}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
