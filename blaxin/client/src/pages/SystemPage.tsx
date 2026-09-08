import React, { useEffect, useState } from 'react';
import { api, CapabilityInfo } from '../services/api';
import { useSystemTelemetry } from '../hooks/useSystemTelemetry';
import {
  FiCpu, FiClock, FiServer, FiWifi,
  FiZap, FiCheckCircle, FiXCircle, FiTerminal, FiFile, FiGlobe,
  FiMonitor, FiClipboard, FiSearch, FiInfo,
} from 'react-icons/fi';

const toolIcons: Record<string, React.ReactNode> = {
  terminal: <FiTerminal size={14} />,
  filesystem: <FiFile size={14} />,
  browser: <FiGlobe size={14} />,
  'computer-control': <FiMonitor size={14} />,
  clipboard: <FiClipboard size={14} />,
  search: <FiSearch size={14} />,
  'system-info': <FiInfo size={14} />,
  screenshot: <FiMonitor size={14} />,
};

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(sec % 60)}s`;
}

function MetricBar({ label, percent, color }: { label: string; percent: number; color: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
        marginBottom: 4,
      }}>
        <span>{label}</span>
        <span style={{ color }}>{clamped}%</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-tertiary)', overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${clamped}%`, background: color,
          boxShadow: `0 0 8px ${color}`, transition: 'width 0.4s ease',
        }} />
      </div>
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-lg)', overflow: 'hidden',
    }}>
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ color: 'var(--accent-primary)' }}>{icon}</span>
        <span style={{
          fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: 1, color: 'var(--text-secondary)',
        }}>{title}</span>
      </div>
      <div style={{ padding: '16px' }}>{children}</div>
    </div>
  );
}

function TelemetryPanel() {
  const { data, error } = useSystemTelemetry();

  if (error) {
    return (
      <Panel title="System Telemetry" icon={<FiServer size={14} />}>
        <div style={{ fontSize: 12, color: 'var(--accent-red)' }}>{error}</div>
      </Panel>
    );
  }
  if (!data) {
    return (
      <Panel title="System Telemetry" icon={<FiServer size={14} />}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Reading live system state…</div>
      </Panel>
    );
  }

  const cpuColor = data.cpu.usagePercent >= 85 ? 'var(--accent-red)' : data.cpu.usagePercent >= 60 ? 'var(--accent-yellow)' : 'var(--accent-primary)';
  const memColor = data.memory.percent >= 85 ? 'var(--accent-red)' : data.memory.percent >= 60 ? 'var(--accent-yellow)' : 'var(--accent-green)';
  const diskColor = data.disk && data.disk.percent >= 90 ? 'var(--accent-red)' : data.disk && data.disk.percent >= 75 ? 'var(--accent-yellow)' : 'var(--accent-secondary)';

  return (
    <Panel title="System Telemetry" icon={<FiServer size={14} />}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <InfoChip icon={<FiWifi size={11} />} label={`${data.os.platform} ${data.os.arch}`} />
        <InfoChip icon={<FiClock size={11} />} label={`up ${fmtDuration(data.uptimeSec)}`} />
        <InfoChip icon={<FiServer size={11} />} label={data.os.hostname} />
        <InfoChip icon={<FiZap size={11} />} label={`node ${data.nodeVersion.replace(/^v/, '')}`} />
      </div>

      <MetricBar label={`CPU · ${data.cpu.cores} cores · load ${data.cpu.loadAvg.one.toFixed(2)}`} percent={data.cpu.usagePercent} color={cpuColor} />
      <MetricBar label={`RAM · ${fmtBytes(data.memory.usedBytes)} / ${fmtBytes(data.memory.totalBytes)}`} percent={data.memory.percent} color={memColor} />
      {data.disk && (
        <MetricBar
          label={`DISK · ${fmtBytes(data.disk.usedBytes)} / ${fmtBytes(data.disk.totalBytes)} (${data.disk.mount})`}
          percent={data.disk.percent}
          color={diskColor}
        />
      )}

      {data.cpu.model && (
        <div style={{
          marginTop: 8, fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {data.cpu.model}
        </div>
      )}
    </Panel>
  );
}

function InfoChip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '3px 8px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)',
      fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
    }}>
      {icon}
      {label}
    </div>
  );
}

function CapabilitiesPanel() {
  const [caps, setCaps] = useState<CapabilityInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getCapabilities()
      .then((c) => { if (!cancelled) setCaps(c); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  const enabledCount = caps?.filter((c) => c.enabled).length ?? 0;

  return (
    <Panel title={`Capabilities${caps ? ` · ${enabledCount}/${caps.length} enabled` : ''}`} icon={<FiZap size={14} />}>
      {error && <div style={{ fontSize: 12, color: 'var(--accent-red)' }}>{error}</div>}
      {!caps && !error && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>}
      {caps && caps.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No capabilities advertised.</div>}
      {caps && caps.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {caps.map((c) => (
            <div key={c.name} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)',
            }}>
              <span style={{ color: c.enabled ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                {toolIcons[c.name] || <FiZap size={14} />}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 12, fontWeight: 500, color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 0.5,
                }}>
                  {c.name}
                </div>
                <div style={{
                  fontSize: 10, color: 'var(--text-muted)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {c.description}
                </div>
              </div>
              {c.enabled
                ? <FiCheckCircle size={14} color="var(--accent-green)" />
                : <FiXCircle size={14} color="var(--accent-red)" />}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function SystemPage() {
  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{
          fontSize: 16, fontWeight: 700, color: 'var(--text-primary)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <FiCpu size={18} color="var(--accent-primary)" />
          SYSTEM
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
          REAL HARDWARE STATE · CPU / RAM / DISK · CAPABILITIES
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
        <TelemetryPanel />
        <CapabilitiesPanel />
      </div>
    </div>
  );
}