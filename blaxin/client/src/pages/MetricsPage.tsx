import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, MetricsResponse, MetricsSummary, MetricsTask } from '../services/api';
import {
  FiBarChart2, FiRefreshCw, FiLoader, FiAlertTriangle, FiClock, FiZap,
  FiActivity, FiTrendingUp, FiLayers, FiCheckCircle, FiXCircle,
  FiPauseCircle, FiPlayCircle, FiDatabase,
} from 'react-icons/fi';

// ── Formatting helpers ──────────────────────────────────────────

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtTime(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

const kindColors: Record<string, string> = {
  direct: 'var(--accent-primary)',
  llm: 'var(--accent-secondary)',
};

const resultConfig: Record<string, { color: string; label: string }> = {
  completed: { color: 'var(--accent-green)', label: 'OK' },
  denied: { color: 'var(--accent-yellow)', label: 'DENIED' },
  stopped: { color: 'var(--accent-yellow)', label: 'STOPPED' },
  'step-limit': { color: 'var(--accent-yellow)', label: 'STEP LIMIT' },
  error: { color: 'var(--accent-red)', label: 'ERROR' },
  'no-provider': { color: 'var(--accent-red)', label: 'NO PROVIDER' },
};

// ── Small building blocks ───────────────────────────────────────

function StatCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      padding: '12px 14px',
      minWidth: 0,
    }}>
      <div style={{
        fontSize: 10, textTransform: 'uppercase', letterSpacing: 1,
        color: 'var(--text-muted)', marginBottom: 6, whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)',
        color: color || 'var(--text-primary)', lineHeight: 1.1,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Section({ title, icon, children }: {
  title: string; icon: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'var(--bg-tertiary)',
      }}>
        <span style={{ color: 'var(--accent-primary)', display: 'flex' }}>{icon}</span>
        <span style={{
          fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: 1, color: 'var(--text-secondary)',
        }}>
          {title}
        </span>
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}

/** Horizontal labeled bar (value relative to max). */
function HBar({ label, value, max, color, suffix }: {
  label: string; value: number; max: number; color: string; suffix?: string;
}) {
  const pct = max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', marginBottom: 4,
        fontSize: 11, color: 'var(--text-secondary)',
      }}>
        <span>{label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
          {fmtMs(value)}{suffix ? ` ${suffix}` : ''}
        </span>
      </div>
      <div style={{ height: 10, background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, height: '100%', background: color,
          borderRadius: 'var(--radius-sm)',
          boxShadow: `0 0 8px ${color}66`,
          transition: 'width 0.3s',
        }} />
      </div>
    </div>
  );
}

// ── Visualizations (inline SVG, zero dependencies) ──────────────

/** Latency trend: area/line chart of the most recent tasks. */
function TrendChart({ tasks }: { tasks: MetricsTask[] }) {
  if (tasks.length === 0) return <EmptyChart />;
  const W = 640, H = 170, padL = 44, padR = 12, padT = 14, padB = 22;
  const ordered = [...tasks].sort((a, b) => a.startedAt - b.startedAt).slice(-80);
  const yMax = Math.max(...ordered.map((t) => t.totalMs), 1);
  const n = ordered.length;
  const x = (i: number) => padL + (i * (W - padL - padR)) / Math.max(1, n - 1);
  const y = (v: number) => H - padB - (v / yMax) * (H - padT - padB);

  const line = ordered.map((t, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(t.totalMs).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${H - padB} L${x(0).toFixed(1)},${H - padB} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {/* grid + y labels */}
      {[0, 0.5, 1].map((f) => {
        const gy = y(yMax * f);
        return (
          <g key={f}>
            <line x1={padL} y1={gy} x2={W - padR} y2={gy} stroke="var(--border-subtle)" strokeWidth={1} strokeDasharray="3 4" />
            <text x={padL - 6} y={gy + 3} textAnchor="end" fontSize={9} fill="var(--text-muted)" fontFamily="var(--font-mono)">
              {fmtMs(yMax * f)}
            </text>
          </g>
        );
      })}
      <path d={area} fill="var(--accent-primary)" opacity={0.12} />
      <path d={line} fill="none" stroke="var(--accent-primary)" strokeWidth={2} strokeLinejoin="round" />
      {/* last point */}
      <circle cx={x(n - 1)} cy={y(ordered[n - 1].totalMs)} r={3.5} fill="var(--accent-primary)" />
      <text x={padL} y={H - 6} fontSize={9} fill="var(--text-muted)" fontFamily="var(--font-mono)">
        {n} recent tasks · {fmtTime(ordered[0].startedAt)} → {fmtTime(ordered[n - 1].startedAt)}
      </text>
    </svg>
  );
}

/** Donut: direct vs LLM task share. */
function DonutChart({ summary }: { summary: MetricsSummary }) {
  const total = summary.direct + summary.llm;
  if (total === 0) return <EmptyChart />;
  const r = 52, C = 2 * Math.PI * r;
  const directDash = (summary.direct / total) * C;
  const llmDash = (summary.llm / total) * C;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
      <svg viewBox="0 0 140 140" style={{ width: 140, height: 140, flexShrink: 0 }}>
        <circle cx={70} cy={70} r={r} fill="none" stroke="var(--bg-tertiary)" strokeWidth={16} />
        <circle
          cx={70} cy={70} r={r} fill="none"
          stroke="var(--accent-primary)" strokeWidth={16}
          strokeDasharray={`${directDash} ${C - directDash}`}
          strokeLinecap="butt"
          transform="rotate(-90 70 70)"
        />
        <circle
          cx={70} cy={70} r={r} fill="none"
          stroke="var(--accent-secondary)" strokeWidth={16}
          strokeDasharray={`${llmDash} ${C - llmDash}`}
          strokeDashoffset={-directDash}
          strokeLinecap="butt"
          transform="rotate(-90 70 70)"
        />
        <text x={70} y={64} textAnchor="middle" fontSize={22} fontWeight={700}
          fill="var(--text-primary)" fontFamily="var(--font-mono)">{total}</text>
        <text x={70} y={82} textAnchor="middle" fontSize={9} fill="var(--text-muted)">tasks</text>
      </svg>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 120 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--accent-primary)' }} />
          Direct · {summary.direct} <span style={{ color: 'var(--text-muted)' }}>({Math.round((summary.direct / total) * 100)}%)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--accent-secondary)' }} />
          LLM · {summary.llm} <span style={{ color: 'var(--text-muted)' }}>({Math.round((summary.llm / total) * 100)}%)</span>
        </div>
      </div>
    </div>
  );
}

function EmptyChart() {
  return (
    <div style={{
      padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12,
    }}>
      No data yet
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────

const REFRESH_MS = 10000;
const FETCH_COUNT = 100;

export function MetricsPage() {
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const fetchingRef = useRef(false);

  const fetchMetrics = useCallback(async (silent = false) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    if (!silent) setLoading(true);
    try {
      const result = await api.metrics(FETCH_COUNT);
      setData(result);
      setError(null);
      setLastUpdated(new Date());
    } catch (err: any) {
      setError(err?.message || 'Failed to load metrics');
    } finally {
      fetchingRef.current = false;
      setLoading(false);
    }
  }, []);

  // Initial load.
  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  // Efficient polling: only while visible AND auto-refresh is on.
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (!autoRefresh || !visible) return;
    const timer = setInterval(() => { void fetchMetrics(true); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, visible, fetchMetrics]);

  const s = data?.summary;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 20, flexWrap: 'wrap', gap: 12,
      }}>
        <div>
          <h2 style={{
            fontSize: 20, fontWeight: 700, marginBottom: 4,
            display: 'flex', alignItems: 'center', gap: 10,
            color: 'var(--text-primary)',
          }}>
            <FiBarChart2 size={20} color="var(--accent-primary)" />
            Performance Metrics
          </h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Engine latency, model vs tool time, and parallelization
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {lastUpdated && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              Updated {lastUpdated.toLocaleTimeString([], { hour12: false })}
            </span>
          )}
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            title={autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh'}
            style={{
              padding: '8px 10px', background: 'var(--bg-tertiary)',
              color: autoRefresh ? 'var(--accent-primary)' : 'var(--text-muted)',
              borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)',
              display: 'flex', alignItems: 'center', fontSize: 12,
            }}
          >
            {autoRefresh ? <FiPauseCircle size={13} /> : <FiPlayCircle size={13} />}
            <span style={{ marginLeft: 5 }}>{autoRefresh ? 'Auto' : 'Manual'}</span>
          </button>
          <button
            onClick={() => { void fetchMetrics(); }}
            disabled={loading}
            style={{
              padding: '8px 14px', background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)', borderRadius: 'var(--radius-md)',
              fontSize: 12, border: '1px solid var(--border-subtle)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <FiRefreshCw size={12} className={loading ? 'spin' : ''} />
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div style={{
          padding: '14px 18px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10,
          background: 'var(--accent-red)10', border: '1px solid var(--accent-red)30',
          borderRadius: 'var(--radius-md)',
        }}>
          <FiAlertTriangle color="var(--accent-red)" size={16} />
          <span style={{ fontSize: 13, color: 'var(--text-primary)', flex: 1 }}>
            Could not load metrics: {error}
          </span>
          <button
            onClick={() => { void fetchMetrics(); }}
            style={{
              padding: '6px 12px', fontSize: 12, borderRadius: 'var(--radius-sm)',
              background: 'var(--accent-red)15', color: 'var(--accent-red)',
              border: '1px solid var(--accent-red)40',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading state (first load only) */}
      {loading && !data && (
        <div style={{ padding: '80px', textAlign: 'center', color: 'var(--accent-primary)' }}>
          <FiLoader size={30} className="spin" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 13 }}>Loading metrics...</div>
        </div>
      )}

      {s && (
        <>
          {/* Summary cards */}
          <div style={{
            display: 'grid', gap: 10,
            gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
            marginBottom: 20,
          }}>
            <StatCard label="Total tasks" value={String(s.samples)} color="var(--text-primary)" />
            <StatCard label="Succeeded" value={String(s.samples - s.errors)} color="var(--accent-green)" />
            <StatCard label="Failed / issues" value={String(s.errors)} color={s.errors > 0 ? 'var(--accent-red)' : 'var(--text-muted)'} />
            <StatCard label="Direct (no LLM)" value={String(s.direct)} color="var(--accent-primary)" />
            <StatCard label="LLM" value={String(s.llm)} color="var(--accent-secondary)" />
            <StatCard label="Avg latency" value={fmtMs(s.totalMs.p95)} sub={`p95 ${fmtMs(s.totalMs.p95)}`} color="var(--accent-yellow)" />
            <StatCard label="Median latency" value={fmtMs(s.totalMs.median)} sub={`min ${fmtMs(s.totalMs.min)} · max ${fmtMs(s.totalMs.max)}`} />
            <StatCard label="Min latency" value={fmtMs(s.totalMs.min)} color="var(--accent-green)" />
            <StatCard label="Max latency" value={fmtMs(s.totalMs.max)} color={s.totalMs.max > 5000 ? 'var(--accent-red)' : 'var(--text-primary)'} />
            <StatCard label="Model calls" value={String(s.modelCalls)} sub={fmtMs(s.totalModelMs)} color="var(--accent-secondary)" />
            <StatCard label="Model time" value={fmtMs(s.modelMs.median)} sub={`total ${fmtMs(s.totalModelMs)}`} color="var(--accent-secondary)" />
            <StatCard label="Tool calls" value={String(s.toolCalls)} sub={fmtMs(s.totalToolMs)} color="var(--accent-primary)" />
            <StatCard label="Tool time" value={fmtMs(s.toolMs.median)} sub={`total ${fmtMs(s.totalToolMs)}`} color="var(--accent-primary)" />
            <StatCard label="Queue wait" value={fmtMs(s.queueWaitMs.median)} sub={`p95 ${fmtMs(s.queueWaitMs.p95)}`} color="var(--accent-yellow)" />
            <StatCard label="Waves" value={String(s.waves)} color="var(--text-primary)" />
            <StatCard label="Parallel waves" value={String(s.parallelWaves)} sub={s.waves > 0 ? `${Math.round((s.parallelWaves / s.waves) * 100)}% of waves` : undefined} color="var(--accent-green)" />
          </div>

          {/* Visualizations */}
          <div style={{
            display: 'grid', gap: 16,
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            marginBottom: 20,
          }}>
            <Section title="Latency trend" icon={<FiTrendingUp size={13} />}>
              <TrendChart tasks={data?.tasks ?? []} />
            </Section>

            <Section title="Task type distribution" icon={<FiLayers size={13} />}>
              <DonutChart summary={s} />
            </Section>

            <Section title="Direct vs LLM latency" icon={<FiZap size={13} />}>
              <HBar
                label="Direct path (median)"
                value={s.byKind.direct.medianMs}
                max={Math.max(s.byKind.direct.medianMs, s.byKind.llm.medianMs, 1)}
                color="var(--accent-primary)"
              />
              <HBar
                label="LLM loop (median)"
                value={s.byKind.llm.medianMs}
                max={Math.max(s.byKind.direct.medianMs, s.byKind.llm.medianMs, 1)}
                color="var(--accent-secondary)"
              />
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 6 }}>
                direct n={s.byKind.direct.count} · llm n={s.byKind.llm.count}
              </div>
            </Section>

            <Section title="Model vs tool time" icon={<FiClock size={13} />}>
              <HBar
                label="Model time (median)"
                value={s.modelMs.median}
                max={Math.max(s.modelMs.median, s.toolMs.median, 1)}
                color="var(--accent-secondary)"
                suffix={`· Σ ${fmtMs(s.totalModelMs)}`}
              />
              <HBar
                label="Tool time (median)"
                value={s.toolMs.median}
                max={Math.max(s.modelMs.median, s.toolMs.median, 1)}
                color="var(--accent-primary)"
                suffix={`· Σ ${fmtMs(s.totalToolMs)}`}
              />
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 6 }}>
                model share: {s.totalModelMs + s.totalToolMs > 0 ? `${Math.round((s.totalModelMs / (s.totalModelMs + s.totalToolMs)) * 100)}%` : '—'}
              </div>
            </Section>

            <Section title="Parallelization" icon={<FiActivity size={13} />}>
              <HBar
                label="Parallel waves"
                value={s.parallelWaves}
                max={Math.max(s.waves, 1)}
                color="var(--accent-green)"
                suffix={`/ ${s.waves} waves`}
              />
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
                {s.waves > 0
                  ? `${s.parallelWaves} of ${s.waves} execution waves ran tools concurrently.`
                  : 'No tool waves recorded yet.'}
              </div>
            </Section>

            <Section title="Slowest recent tasks" icon={<FiActivity size={13} />}>
              {(() => {
                const slow = [...(data?.tasks ?? [])]
                  .sort((a, b) => b.totalMs - a.totalMs)
                  .slice(0, 5);
                if (slow.length === 0) return <EmptyChart />;
                const max = slow[0].totalMs;
                return slow.map((t) => (
                  <HBar
                    key={t.taskId}
                    label={`${fmtTime(t.startedAt)} · ${t.kind === 'direct' ? 'direct' : 'LLM'} · ${t.result}`}
                    value={t.totalMs}
                    max={max}
                    color={kindColors[t.kind] || 'var(--text-muted)'}
                  />
                ));
              })()}
            </Section>
          </div>

          {/* Recent task history */}
          <Section title={`Recent tasks (${data?.tasks.length ?? 0})`} icon={<FiDatabase size={13} />}>
            {data && data.tasks.length === 0 ? (
              <EmptyChart />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                      <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>Time</th>
                      <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>Kind</th>
                      <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'right' }}>Duration</th>
                      <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'right' }}>Model calls</th>
                      <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'right' }}>Model ms</th>
                      <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'right' }}>Tools</th>
                      <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'right' }}>Waves</th>
                      <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data!.tasks].reverse().map((t) => {
                      const rc = resultConfig[t.result] || { color: 'var(--text-muted)', label: t.result };
                      return (
                        <tr key={t.taskId} style={{ color: 'var(--text-secondary)' }}>
                          <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                            {fmtTime(t.startedAt)}
                          </td>
                          <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
                            <span style={{
                              padding: '2px 6px', borderRadius: 'var(--radius-sm)', fontSize: 10,
                              fontWeight: 700, letterSpacing: 0.5, fontFamily: 'var(--font-mono)',
                              background: `${kindColors[t.kind]}18`, color: kindColors[t.kind],
                            }}>
                              {t.kind === 'direct' ? 'DIRECT' : 'LLM'}
                            </span>
                          </td>
                          <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                            {fmtMs(t.totalMs)}
                          </td>
                          <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                            {t.modelCalls}
                          </td>
                          <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                            {fmtMs(t.modelMs)}
                          </td>
                          <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                            {t.toolCalls}
                          </td>
                          <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                            {t.parallelWaves > 0 ? `${t.parallelWaves}/${t.waves}` : t.waves}
                          </td>
                          <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              fontSize: 10, color: rc.color, fontFamily: 'var(--font-mono)', letterSpacing: 0.5,
                            }}>
                              {t.result === 'completed'
                                ? <FiCheckCircle size={11} />
                                : <FiXCircle size={11} />}
                              {rc.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* Empty-state hint when nothing has run yet */}
          {s.samples === 0 && (
            <div style={{
              padding: '28px', marginTop: 16, textAlign: 'center',
              background: 'var(--bg-secondary)', border: '1px dashed var(--border-subtle)',
              borderRadius: 'var(--radius-md)', color: 'var(--text-muted)', fontSize: 13,
            }}>
              <FiZap size={20} style={{ marginBottom: 8, color: 'var(--accent-primary)' }} />
              <div>No telemetry yet — run a few tasks and this page will fill with latency breakdowns.</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}