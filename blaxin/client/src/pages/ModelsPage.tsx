import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../utils/store';
import { api } from '../services/api';
import {
  FiCpu, FiRefreshCw, FiServer, FiCloud, FiZap, FiDownload,
  FiPower, FiSquare, FiTrash2, FiAlertTriangle, FiCheckCircle,
  FiLoader, FiTerminal, FiKey, FiLink, FiLayers,
} from 'react-icons/fi';

// ── Shared styles (matching the BLAXIN theme) ──────────────────

const btnBase: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 12px', borderRadius: 'var(--radius-md)', fontSize: 11,
  fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: 0.5,
  cursor: 'pointer', border: '1px solid var(--border-subtle)', background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)', border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)', fontSize: 11, fontFamily: 'var(--font-mono)',
  outline: 'none',
};

function Card({ title, icon, right, children }: {
  title: string; icon?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: 16, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {icon}
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-secondary)' }}>{title}</span>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function Row({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{k}</span>
      <span style={{ fontSize: 11, color: 'var(--text-primary)', fontFamily: mono ? 'var(--font-mono)' : undefined, textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}

function fmtBytes(b: number | null | undefined): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b; let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

function badge(color: string, text: string): React.ReactNode {
  return (
    <span style={{ padding: '2px 8px', borderRadius: 999, background: `${color}22`, color, fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
      {text}
    </span>
  );
}

const DEPLOY_COLORS: Record<string, string> = {
  READY: 'var(--accent-green)',
  FAILED: 'var(--accent-red)',
  CANCELLED: 'var(--text-muted)',
  DISCOVERING: 'var(--accent-yellow)',
  VALIDATING: 'var(--accent-yellow)',
  PREPARING: 'var(--accent-yellow)',
  INSTALLING_RUNTIME: 'var(--accent-yellow)',
  DOWNLOADING_MODEL: 'var(--accent-yellow)',
  VERIFYING_MODEL: 'var(--accent-yellow)',
  STARTING_SERVER: 'var(--accent-yellow)',
  HEALTH_CHECK: 'var(--accent-yellow)',
  CONNECTING_BRAIN: 'var(--accent-yellow)',
  INFERENCE_TEST: 'var(--accent-yellow)',
};

interface Notice { kind: 'ok' | 'err'; text: string }

export function ModelsPage() {
  const brainStatus = useAppStore((s) => s.brainStatus);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Local machine
  const [inventory, setInventory] = useState<any>(null);
  const [recommendation, setRecommendation] = useState<any>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<any>(null);
  const [runtimeLogs, setRuntimeLogs] = useState<string>('');
  const [catalog, setCatalog] = useState<any[]>([]);
  const [pullTarget, setPullTarget] = useState('');

  // Oracle Cloud
  const [cloudStatus, setCloudStatus] = useState<any>(null);
  const [topology, setTopology] = useState<any>(null);
  const [shapes, setShapes] = useState<any[]>([]);
  const [quota, setQuota] = useState<any[]>([]);
  const [instances, setInstances] = useState<any[]>([]);
  const [deployments, setDeployments] = useState<any[]>([]);
  const [tunnelInfo, setTunnelInfo] = useState<any>(null);

  // Connect form (credentials live only in this form until submitted)
  const [ociForm, setOciForm] = useState({ tenancy: '', user: '', fingerprint: '', privateKey: '', region: '' });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [res, cat, rt, cloud, depl] = await Promise.all([
        api.getResources(),
        api.getCatalog(),
        api.getRuntimeStatus(),
        api.getCloudStatus(),
        api.getDeployments(),
      ]);
      setInventory(res.inventory);
      setCatalog(cat.models || []);
      setRuntimeStatus(rt);
      setCloudStatus(cloud);
      setDeployments(depl.deployments || []);
      // Local recommendation only when this machine is the Brain-node.
      const rec = await api.recommend({});
      setRecommendation(rec);
    } catch (err: any) {
      setNotice({ kind: 'err', text: err?.message || 'Refresh failed' });
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Poll the authoritative server state while the page is mounted.
  useEffect(() => {
    void refresh();
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const [rt, depl] = await Promise.all([api.getRuntimeStatus(), api.getDeployments()]);
          setRuntimeStatus(rt);
          setDeployments(depl.deployments || []);
        } catch { /* offline — keep last known */ }
      })();
    }, 6000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refresh]);

  const act = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    setNotice(null);
    try {
      const result = await fn();
      if (result && result.ok === false) setNotice({ kind: 'err', text: result.error || 'Operation failed' });
      else if (result && result.error) setNotice({ kind: 'err', text: result.error });
      else setNotice({ kind: 'ok', text: 'Done' });
      await refresh();
    } catch (err: any) {
      setNotice({ kind: 'err', text: err?.message || 'Operation failed' });
    } finally {
      setBusy(null);
    }
  };

  const loadCloudDiscovery = async (compartmentId: string) => {
    if (!compartmentId) return;
    setBusy('cloud-discovery');
    try {
      const [topo, sh, qu] = await Promise.all([
        api.getCloudTopology(),
        api.getCloudShapes(compartmentId),
        api.getCloudQuota(compartmentId),
      ]);
      setTopology(topo);
      setShapes(sh.shapes || []);
      setQuota(qu.quotas || []);
      const inst = await api.getCloudInstances(compartmentId);
      setInstances(inst.instances || []);
    } catch (err: any) {
      setNotice({ kind: 'err', text: err?.message || 'Cloud discovery failed' });
    } finally {
      setBusy(null);
    }
  };

  const connectOci = async () => {
    setBusy('oci-connect');
    setNotice(null);
    try {
      const res = await api.connectOci({
        tenancy: ociForm.tenancy.trim(),
        user: ociForm.user.trim(),
        fingerprint: ociForm.fingerprint.trim(),
        privateKey: ociForm.privateKey,
        region: ociForm.region.trim(),
      });
      setNotice({ kind: 'ok', text: `Connected (${res.tenancyName || res.region || 'OCI'}).` });
      setOciForm({ tenancy: '', user: '', fingerprint: '', privateKey: '', region: '' });
      const [cs, t] = await Promise.all([api.getCloudStatus(), api.getTunnelInfo()]);
      setCloudStatus(cs);
      setTunnelInfo(t);
    } catch (err: any) {
      setNotice({ kind: 'err', text: err?.message || 'Connection failed' });
    } finally {
      setBusy(null);
    }
  };

  const deploy = async (shapeId: string, modelId: string) => {
    if (!topology || shapes.length === 0) return;
    const ad = topology.availabilityDomains?.[0]?.name || '';
    if (!ad) { setNotice({ kind: 'err', text: 'No availability domain discovered' }); return; }
    await act('deploy', () => api.deploy({
      shapeId,
      compartmentId: topology.compartments?.[0]?.id || '',
      availabilityDomain: ad,
      modelId,
      runtimeId: 'ollama',
    }));
  };

  const brain = brainStatus?.brain ?? null;
  const external = brainStatus?.mode === 'external';
  const tunnel = cloudStatus?.tunnel;
  const status = runtimeStatus?.status;
  const pulling = runtimeStatus?.pulling || [];

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: 1, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
          MODELS <span style={{ color: 'var(--accent-primary)' }}>/</span> INFRASTRUCTURE
        </div>
        <button style={btnBase} onClick={() => void refresh()} disabled={refreshing}>
          <FiRefreshCw size={12} className={refreshing ? 'spin' : ''} /> REFRESH
        </button>
      </div>

      {notice && (
        <div style={{ padding: '10px 14px', borderRadius: 'var(--radius-md)', fontSize: 12, fontFamily: 'var(--font-mono)', background: notice.kind === 'ok' ? 'rgba(0, 230, 118, 0.08)' : 'rgba(255, 51, 85, 0.1)', color: notice.kind === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)', border: `1px solid ${notice.kind === 'ok' ? 'rgba(0,230,118,0.3)' : 'rgba(255,51,85,0.3)'}` }}>
          {notice.kind === 'ok' ? <FiCheckCircle size={12} style={{ marginRight: 6 }} /> : <FiAlertTriangle size={12} style={{ marginRight: 6 }} />}
          {notice.text}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
        {/* ── CURRENT BRAIN ── */}
        <Card title="Current Brain" icon={<FiLink size={14} color="var(--accent-primary)" />}>
          {external ? (
            <Row k="Mode" v={badge('var(--accent-primary)', 'EXTERNAL BRAIN')} />
          ) : (
            <Row k="Mode" v={badge('var(--accent-primary)', 'EMBEDDED')} />
          )}
          {external && brain && (
            <>
              <Row k="State" v={badge(brain.state === 'CONNECTED' ? 'var(--accent-green)' : 'var(--accent-yellow)', brain.state || 'UNKNOWN')} />
              <Row k="Brain" v={brain.brainName || brain.brainId || '—'} mono />
              <Row k="Transport" v={brain.transport === 'wss' ? 'WSS · TLS' : `WS${brain.secure ? ' · loopback' : ' · plaintext (dev)'}`} mono />
            </>
          )}
          {!external && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 4 }}>
              Reasoning, planning and model calls run inside this desktop process. The local model below can become the Brain's provider.
            </div>
          )}
        </Card>

        {/* ── LOCAL MACHINE ── */}
        <Card title="Local Machine" icon={<FiCpu size={14} color="var(--accent-primary)" />}>
          {inventory ? (
            <>
              <Row k="OS" v={`${inventory.os.platform} · ${inventory.os.release || '?'}`} mono />
              <Row k="Arch" v={inventory.architecture} mono />
              <Row k="CPU" v={inventory.cpu.cores ? `${inventory.cpu.cores} cores` : '?'} mono />
              <Row k="RAM" v={fmtBytes(inventory.memoryBytes)} mono />
              <Row k="GPU" v={inventory.gpus.length > 0 ? inventory.gpus.map((g: any) => g.name || g.kind).join(', ') : 'none detected'} />
              <Row k="VRAM" v={inventory.gpus.length > 0 ? inventory.gpus.map((g: any) => fmtBytes(g.vramBytes)).join(', ') : '—'} mono />
              <Row k="Disk free" v={fmtBytes(inventory.storage.freeBytes)} mono />
            </>
          ) : <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Detecting…</div>}
        </Card>

        {/* ── RUNTIME STATUS ── */}
        <Card title="Model Runtime" icon={<FiServer size={14} color="var(--accent-primary)" />}>
          {status ? (
            <>
              <Row k="Engine" v={badge(
                status.state === 'running' ? 'var(--accent-green)'
                  : status.state === 'unhealthy' ? 'var(--accent-red)'
                    : status.state === 'not-installed' ? 'var(--text-muted)' : 'var(--accent-yellow)',
                (status.state || 'unknown').replace('-', ' '),
              )} />
              {status.state === 'running' && (
                <>
                  <Row k="Endpoint" v={status.endpoint || '—'} mono />
                  <Row k="Models" v={status.models?.length ? `${status.models.length} local` : 'none'} mono />
                </>
              )}
              {status.state === 'unhealthy' && status.error && (
                <Row k="Error" v={<span style={{ color: 'var(--accent-red)' }}>{status.error}</span>} />
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                {status.state === 'not-installed' && (
                  <button style={btnBase} onClick={() => void act('runtime-install', () => api.runtimeAction('install'))} disabled={busy !== null}>
                    <FiDownload size={11} /> {busy === 'runtime-install' ? 'INSTALLING…' : 'INSTALL'}
                  </button>
                )}
                {['stopped', 'unhealthy'].includes(status.state) && (
                  <button style={btnBase} onClick={() => void act('runtime-start', () => api.runtimeAction('start'))} disabled={busy !== null}>
                    <FiPower size={11} /> START
                  </button>
                )}
                {status.state === 'running' && (
                  <>
                    <button style={btnBase} onClick={() => void act('runtime-restart', () => api.runtimeAction('restart'))} disabled={busy !== null}>
                      <FiRefreshCw size={11} /> RESTART
                    </button>
                    <button style={btnBase} onClick={() => void act('runtime-stop', () => api.runtimeAction('stop'))} disabled={busy !== null}>
                      <FiSquare size={11} /> STOP
                    </button>
                  </>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <input style={{ ...inputStyle, flex: 1 }} placeholder="model id (e.g. qwen2.5:7b-instruct-q4_K_M)" value={pullTarget} onChange={(e) => setPullTarget(e.target.value)} />
                <button style={btnBase} onClick={() => { if (pullTarget.trim()) void act('runtime-pull', () => api.pullModel(pullTarget.trim())); }} disabled={busy !== null || !pullTarget.trim()}>
                  <FiDownload size={11} /> PULL
                </button>
              </div>
              {pulling.map((p: any) => (
                <div key={p.modelId} style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>▸ pulling {p.modelId} {p.percent !== null ? `${p.percent}%` : ''}</div>
                  <div style={{ height: 4, background: 'var(--bg-tertiary)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${p.percent ?? 0}%`, background: 'var(--accent-primary)', transition: 'width 0.3s' }} />
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 10 }}>
                <button style={{ ...btnBase, fontSize: 10 }} onClick={() => void act('runtime-logs', () => api.getRuntimeLogs(80).then((r) => { setRuntimeLogs(r.logs || ''); return { ok: true }; }))}>
                  <FiTerminal size={10} /> LOGS
                </button>
                {runtimeLogs && (
                  <pre style={{ marginTop: 8, maxHeight: 140, overflow: 'auto', fontSize: 10, fontFamily: 'var(--font-mono)', background: 'var(--bg-tertiary)', color: 'var(--text-muted)', padding: 8, borderRadius: 'var(--radius-sm)', whiteSpace: 'pre-wrap' }}>
                    {runtimeLogs.slice(-4000)}
                  </pre>
                )}
              </div>
            </>
          ) : <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Querying runtime…</div>}
        </Card>

        {/* ── RECOMMENDED MODEL (local) ── */}
        <Card title="Recommended Model" icon={<FiZap size={14} color="var(--accent-primary)" />}>
          {recommendation ? (
            recommendation.best ? (
              <>
                <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--accent-primary)' }}>
                  {recommendation.best.model.name}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', margin: '4px 0 10px' }}>
                  {recommendation.best.model.id} · score {recommendation.best.score}/100 · runs on <b style={{ color: recommendation.best.execution === 'gpu' ? 'var(--accent-green)' : 'var(--text-secondary)' }}>{recommendation.best.execution}</b>
                </div>
                <Row k="Params" v={`${(recommendation.best.model.parameters / 1e9).toFixed(1)}B ${recommendation.best.model.quantization || ''}`} mono />
                <Row k="RAM need" v={fmtBytes(recommendation.best.model.ramBytes)} mono />
                <Row k="VRAM need" v={fmtBytes(recommendation.best.model.vramBytes)} mono />
                <Row k="Context" v={`${(recommendation.best.model.contextTokens / 1024).toFixed(0)}k`} mono />
                {recommendation.best.warnings.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    {recommendation.best.warnings.map((w: any, i: number) => (
                      <div key={i} style={{ fontSize: 10, color: 'var(--accent-yellow)', padding: '4px 8px', background: 'rgba(255, 213, 79, 0.08)', borderRadius: 'var(--radius-sm)', marginBottom: 4 }}>
                        ⚠ {w.message}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button style={btnBase} onClick={() => { setPullTarget(recommendation.best.model.id); }} disabled={!recommendation.best.model.id}>
                    USE THIS MODEL
                  </button>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--accent-red)', lineHeight: 1.6 }}>
                No catalog model can run on this machine.
                {recommendation.notes?.map((n: string, i: number) => <div key={i} style={{ marginTop: 4, color: 'var(--text-muted)' }}>{n}</div>)}
              </div>
            )
          ) : <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Ranking…</div>}

          {recommendation && recommendation.alternatives && recommendation.alternatives.length > 1 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Alternatives</div>
              {recommendation.alternatives.slice(1, 4).map((a: any) => (
                <div key={a.model.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, padding: '4px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{a.model.id}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{a.score}/100 · {a.execution}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* ── ORACLE CLOUD ── */}
        <Card title="Oracle Cloud (OCI)" icon={<FiCloud size={14} color="var(--accent-primary)" />}>
          {cloudStatus ? (
            <>
              <Row k="Status" v={cloudStatus.credentials.configured ? badge('var(--accent-green)', 'CONNECTED') : badge('var(--text-muted)', 'NOT CONNECTED')} />
              {cloudStatus.credentials.configured && (
                <>
                  <Row k="Region" v={cloudStatus.credentials.region || '—'} mono />
                  <Row k="Tenancy" v={cloudStatus.credentials.tenancyMasked || '—'} mono />
                </>
              )}
              {!cloudStatus.credentials.configured && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.6 }}>
                  Add an OCI API key (tenancy OCID, user OCID, fingerprint, private key, region) to enable cloud model deployments. Credentials are encrypted at rest on this machine.
                </div>
              )}
              <Row k="Tunnel" v={tunnel?.ready ? `${tunnel.host}:${tunnel.port} → 127.0.0.1:${tunnel.localPort}` : (tunnel?.note || 'not configured')} mono={false} />

              {!cloudStatus.credentials.configured && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input style={inputStyle} placeholder="tenancy OCID" value={ociForm.tenancy} onChange={(e) => setOciForm({ ...ociForm, tenancy: e.target.value })} />
                  <input style={inputStyle} placeholder="user OCID" value={ociForm.user} onChange={(e) => setOciForm({ ...ociForm, user: e.target.value })} />
                  <input style={inputStyle} placeholder="API key fingerprint (aa:bb:…)" value={ociForm.fingerprint} onChange={(e) => setOciForm({ ...ociForm, fingerprint: e.target.value })} />
                  <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} placeholder="private key (PEM)" value={ociForm.privateKey} onChange={(e) => setOciForm({ ...ociForm, privateKey: e.target.value })} />
                  <input style={inputStyle} placeholder="region (e.g. us-ashburn-1)" value={ociForm.region} onChange={(e) => setOciForm({ ...ociForm, region: e.target.value })} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button style={{ ...btnBase, borderColor: 'rgba(0, 230, 118, 0.4)' }} onClick={() => void connectOci()} disabled={busy !== null || !ociForm.tenancy || !ociForm.privateKey}>
                      <FiKey size={11} /> {busy === 'oci-connect' ? 'VERIFYING…' : 'VERIFY & CONNECT'}
                    </button>
                  </div>
                </div>
              )}

              {cloudStatus.credentials.configured && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button style={btnBase} onClick={() => { const ad = topology?.compartments?.[0]?.id; if (ad) void loadCloudDiscovery(ad); else void act('cloud-discovery', () => api.getCloudTopology().then(async (t) => { setTopology(t); const shapes2 = await api.getCloudShapes(t.compartments?.[0]?.id || ''); setShapes(shapes2.shapes || []); const qu = await api.getCloudQuota(t.compartments?.[0]?.id || ''); setQuota(qu.quotas || []); return { ok: true }; })); }} disabled={busy !== null}>
                    <FiRefreshCw size={11} /> DISCOVER
                  </button>
                  <button style={btnBase} onClick={() => void act('cloud-tunnel', () => api.getTunnelInfo().then((t) => { setTunnelInfo(t); return { ok: true }; }))} disabled={busy !== null}>
                    <FiKey size={11} /> TUNNEL KEY
                  </button>
                  <button style={{ ...btnBase, color: 'var(--accent-red)' }} onClick={() => void act('cloud-disconnect', () => api.disconnectOci())} disabled={busy !== null}>
                    <FiTrash2 size={11} /> DISCONNECT
                  </button>
                </div>
              )}

              {tunnelInfo?.publicKey && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
                    {tunnelInfo.installHint || 'Add this public key to your SSH user:'}
                  </div>
                  <pre style={{ fontSize: 9, fontFamily: 'var(--font-mono)', background: 'var(--bg-tertiary)', color: 'var(--text-muted)', padding: 8, borderRadius: 'var(--radius-sm)', overflow: 'auto' }}>{tunnelInfo.publicKey}</pre>
                </div>
              )}

              {topology && (
                <div style={{ marginTop: 12 }}>
                  <Row k="Region" v={topology.region || '—'} mono />
                  <Row k="Compartments" v={(topology.compartments || []).map((c: any) => c.name).join(', ') || '—'} />
                </div>
              )}

              {shapes.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Shapes ({shapes.length})</div>
                  <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                    {shapes.map((s: any) => (
                      <div key={s.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{s.id}</div>
                          <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{s.architecture} · {s.ocpus ?? '?'} OCPU · {fmtBytes(s.memoryBytes)}{s.gpus > 0 ? ` · ${s.gpus} GPU` : ''}</div>
                        </div>
                        <button style={{ ...btnBase, padding: '4px 8px', fontSize: 10 }} onClick={() => void deploy(s.id, pullTarget || recommendation?.best?.model?.id || 'qwen2.5:7b-instruct-q4_K_M')} disabled={busy !== null}>
                          <FiZap size={10} /> DEPLOY
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {quota.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Compute quota</div>
                  {quota.slice(0, 6).map((q: any, i: number) => (
                    <Row key={i} k={`${q.name || q.service}`} v={`${q.used ?? '?'} / ${q.limit ?? '?'} used${q.available !== null ? ` · ${q.available} free` : ''}`} mono />
                  ))}
                </div>
              )}

              {instances.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Instances ({instances.length})</div>
                  {instances.map((i: any) => (
                    <Row key={i.id} k={i.name} v={badge(i.state === 'running' ? 'var(--accent-green)' : 'var(--accent-yellow)', i.state)} />
                  ))}
                </div>
              )}
              {cloudStatus.provider?.missing?.length > 0 && !cloudStatus.credentials.configured && (
                <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text-muted)' }}>Missing: {cloudStatus.provider.missing.join(', ')}</div>
              )}
            </>
          ) : <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Querying cloud…</div>}
        </Card>

        {/* ── ACTIVE DEPLOYMENT ── */}
        <Card title="Active Deployment" icon={<FiLayers size={14} color="var(--accent-primary)" />}>
          {deployments.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No deployments yet. Pick a shape and a model above to provision an inference node.</div>
          ) : (
            deployments.map((d: any) => {
              const color = DEPLOY_COLORS[d.state] || 'var(--text-muted)';
              const running = !['READY', 'FAILED', 'CANCELLED'].includes(d.state);
              return (
                <div key={d.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{d.modelId}</span>
                    {badge(color, d.state)}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', margin: '6px 0' }}>{d.detail}</div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 6 }}>
                    {d.shapeId} · {d.instanceId ? `${d.instanceId.slice(0, 30)}…` : 'no instance yet'} · {d.updatedAt ? new Date(d.updatedAt).toLocaleTimeString() : ''}
                  </div>
                  {d.state === 'READY' && d.endpoint && (
                    <div style={{ fontSize: 10, color: 'var(--accent-green)', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>
                      ✓ verified endpoint {d.endpoint} · inference test passed · wired to the Brain
                    </div>
                  )}
                  {d.error && <div style={{ fontSize: 10, color: 'var(--accent-red)', marginBottom: 6 }}>✗ {d.error}</div>}
                  {running && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ flex: 1, height: 4, background: 'var(--bg-tertiary)', borderRadius: 99, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: '100%', background: 'var(--accent-yellow)', animation: 'pulse-soft 1.2s ease-in-out infinite' }} />
                      </div>
                      <button style={{ ...btnBase, padding: '4px 10px', fontSize: 10, color: 'var(--accent-red)' }} onClick={() => void act(`cancel-${d.id}`, () => api.cancelDeployment(d.id))} disabled={busy !== null}>
                        <FiSquare size={10} /> CANCEL
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </Card>
      </div>

      {/* ── CATALOG ── */}
      <Card title="Model Catalog" icon={<FiLayers size={14} color="var(--accent-primary)" />} right={<span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{catalog.length} entries · real metadata, no invented benchmarks</span>}>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: 9, letterSpacing: 0.5 }}>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>Model</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>Params</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>Quant</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>RAM</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>VRAM</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>Ctx</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>Runtimes</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>License</th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((m: any) => (
                <tr key={m.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td style={{ padding: '5px 6px', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }} title={m.description}>{m.id}</td>
                  <td style={{ padding: '5px 6px' }}>{(m.parameters / 1e9).toFixed(1)}B</td>
                  <td style={{ padding: '5px 6px' }}>{m.quantization || '—'}</td>
                  <td style={{ padding: '5px 6px' }}>{fmtBytes(m.ramBytes)}</td>
                  <td style={{ padding: '5px 6px' }}>{fmtBytes(m.vramBytes)}</td>
                  <td style={{ padding: '5px 6px' }}>{(m.contextTokens / 1024).toFixed(0)}k</td>
                  <td style={{ padding: '5px 6px' }}>{m.runtimes.join(', ')}</td>
                  <td style={{ padding: '5px 6px', color: 'var(--text-muted)' }}>{m.license}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}