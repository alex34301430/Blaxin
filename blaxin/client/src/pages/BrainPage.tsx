import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../utils/store';
import {
  api, brainAdmin, adminBaseFromBrainUrl, registryWsUrl,
  type BrainDevice, type BrainLinkStatus,
} from '../services/api';
import {
  applyRegistryEvent, emptyRegistryView, isRegistryEventType, reconcileSnapshot,
  type RegistryBody, type RegistryEvent, type RegistryView,
} from '../utils/registry-sync';
import {
  FiCpu, FiRefreshCw, FiWifi, FiWifiOff, FiLink, FiKey, FiTrash2,
  FiAlertTriangle, FiX, FiLoader, FiServer, FiShield, FiClock,
  FiCheckCircle,
} from 'react-icons/fi';

const STATE_META: Record<string, { color: string; label: string }> = {
  CONNECTED: { color: 'var(--accent-green)', label: 'ONLINE' },
  CONNECTING: { color: 'var(--accent-yellow)', label: 'CONNECTING' },
  AUTHENTICATING: { color: 'var(--accent-yellow)', label: 'AUTHENTICATING' },
  RECONNECTING: { color: 'var(--accent-yellow)', label: 'RECONNECTING' },
  DEGRADED: { color: 'var(--accent-yellow)', label: 'DEGRADED' },
  REVOKED: { color: 'var(--accent-red)', label: 'REVOKED' },
  INCOMPATIBLE: { color: 'var(--accent-red)', label: 'INCOMPATIBLE' },
  ERROR: { color: 'var(--accent-red)', label: 'ERROR' },
  DISCONNECTED: { color: 'var(--text-muted)', label: 'OFFLINE' },
};

function stateMeta(state: string | undefined): { color: string; label: string } {
  if (!state) return { color: 'var(--text-muted)', label: 'OFFLINE' };
  return STATE_META[state] ?? { color: 'var(--text-muted)', label: state.toUpperCase() };
}

interface Notice { kind: 'ok' | 'err'; text: string }

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
  outline: 'none',
};

const btnBase: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 'var(--radius-md)', fontSize: 12,
  fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: 0.5,
  cursor: 'pointer', border: '1px solid var(--border-subtle)', background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)',
};

function fmtTime(ts?: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString();
}

function fmtDate(ts?: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

/** Honest transport wording: TLS is only claimed when the wire is actually
 * wss. A loopback ws:// link is unencrypted (fine for same-machine dev) and
 * is labelled as such rather than as "TLS". */
function transportHuman(brain: BrainLinkStatus | null): string {
  if (!brain?.transport) return '—';
  if (brain.transport === 'wss') return 'WSS · TLS';
  return brain.secure ? 'WS · loopback (unencrypted)' : 'WS · plaintext (dev) — insecure';
}

function transportBadge(brain: BrainLinkStatus | null): React.ReactNode {
  if (!brain?.transport) return null;
  if (brain.transport === 'wss') {
    return <span title="TLS-encrypted link to the Brain">WSS · TLS</span>;
  }
  return (
    <span title={brain.secure ? 'Plaintext on loopback only — safe for same-machine development' : 'Plaintext link (development only) — not secure'}>
      WS{brain.secure ? ' · loopback' : ' · plaintext'} ⚠
    </span>
  );
}

function Row({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{k}</span>
      <span style={{ fontSize: 12, color: 'var(--text-primary)', fontFamily: mono ? 'var(--font-mono)' : undefined, textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}

export function BrainPage() {
  const brainStatus = useAppStore((s) => s.brainStatus);
  const setBrainStatus = useAppStore((s) => s.setBrainStatus);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const mode = brainStatus?.mode ?? 'embedded';
  const brain: BrainLinkStatus | null = brainStatus?.brain ?? null;
  const external = mode === 'external';
  const meta = stateMeta(brain?.state);

  // Connect form (pairing UX). The one-time code lives only in this form
  // state — it is never persisted.
  const [brainUrl, setBrainUrl] = useState<string>(() => localStorage.getItem('blaxin-brain-url') || '');
  const [pairCode, setPairCode] = useState('');
  const [generatedCode, setGeneratedCode] = useState<{ code: string; expiresAt: number } | null>(null);

  // Brain admin plane (pairing code + device registry). Only reachable
  // from this browser when the Brain's origin policy allows it.
  const [adminBase, setAdminBase] = useState<string>(() => {
    const saved = localStorage.getItem('blaxin-brain-admin-base');
    return saved || 'http://127.0.0.1:3100';
  });
  // Authoritative registry mirror (Brain is the single source of truth).
  // Bodies + monotonic version, kept in sync by REST snapshots and
  // version-guarded realtime events (see utils/registry-sync.ts).
  const [view, setView] = useState<RegistryView>(() => emptyRegistryView());
  const [registryLoaded, setRegistryLoaded] = useState(false);
  const [selectedBodyId, setSelectedBodyId] = useState<string>(() =>
    localStorage.getItem('blaxin-brain-selected-body') || '',
  );
  const [adminBusy, setAdminBusy] = useState<string | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminOnline, setAdminOnline] = useState(false);
  const [revokeArmed, setRevokeArmed] = useState<string | null>(null);
  const adminWsRef = useRef<WebSocket | null>(null);
  const adminWsReconnectRef = useRef<ReturnType<typeof setTimeout>>();

  const refresh = useCallback(async () => {
    try {
      const status = await api.getBrainStatus();
      setBrainStatus(status);
    } catch (err) {
      setBrainStatus({ mode: 'embedded', bodyId: null, brain: null });
    }
  }, [setBrainStatus]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // Derive the Brain admin base from the connected Brain URL.
  useEffect(() => {
    if (brain?.url) {
      const derived = adminBaseFromBrainUrl(brain.url);
      if (derived) {
        setAdminBase((prev) => prev || derived);
        localStorage.setItem('blaxin-brain-admin-base', derived);
      }
    }
  }, [brain?.url]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(t);
  }, [notice]);

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
      await refresh();
    } catch (err: any) {
      setNotice({ kind: 'err', text: err?.message || String(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleConnect = () =>
    act('connect', async () => {
      const url = brainUrl.trim();
      if (!/^wss?:\/\//.test(url)) {
        throw new Error('Brain address must start with ws:// or wss:// (e.g. wss://brain-host:3100/ws/brain)');
      }
      await api.connectBrain(url, pairCode || undefined);
      if (url) localStorage.setItem('blaxin-brain-url', url);
      setPairCode('');
      setGeneratedCode(null);
      // Connecting is asynchronous — the status card above reflects the
      // real link state (CONNECTING → CONNECTED, or an honest error if
      // the code is wrong/expired). No premature "success" claim.
      setNotice({ kind: 'ok', text: pairCode ? '✓ Pairing request sent — the status card will flip to ONLINE once the secure link is established.' : '✓ Connect request sent.' });
    });

  /** Authoritative REST snapshot (also the reconnect/recovery path). */
  const loadDevices = useCallback(async () => {
    const base = adminBase.trim();
    if (!/^https?:\/\//.test(base)) {
      setAdminError('Enter the Brain admin address (http://host:port — same machine as the Brain).');
      return;
    }
    setAdminBusy('devices');
    setAdminError(null);
    try {
      const res = await brainAdmin.listDevices(base);
      // Snapshot replaces local state and adopts the authoritative version
      // (any realtime event older than it becomes stale and is dropped).
      setView((cur) => reconcileSnapshot(cur, { type: 'snapshot', version: res.version, bodies: res.devices }));
      setRegistryLoaded(true);
      localStorage.setItem('blaxin-brain-admin-base', base.replace(/\/+$/, ''));
    } catch (err: any) {
      setAdminError(`${err?.message || String(err)}\n\nThe Brain admin plane only answers requests its own security policy allows (loopback / desktop origin by default). For a remote Brain, run the console on the Brain machine or allow the origin in BLAXIN_ALLOWED_ORIGINS.`);
    } finally {
      setAdminBusy(null);
    }
  }, [adminBase]);

  // Realtime registry events from the Brain admin WebSocket. The UI is
  // never authoritative: on (re)connect the snapshot reconciles local
  // state first, then live events resume.
  const connectAdminWs = useCallback((base: string) => {
    if (adminWsRef.current?.readyState === WebSocket.OPEN) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(registryWsUrl(base));
    } catch {
      return;
    }
    adminWsRef.current = ws;
    ws.onopen = () => {
      setAdminOnline(true);
      // Reconcile from the authoritative snapshot right after (re)connect.
      void loadDevices();
    };
    ws.onmessage = (event) => {
      let msg: RegistryEvent;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
        return;
      }
      if (!isRegistryEventType(String(msg.type || ''))) return;
      if (msg.type === 'snapshot') {
        setView((cur) => reconcileSnapshot(cur, msg));
      } else {
        // Version guard: stale events (older than the last snapshot/event)
        // can never overwrite newer state.
        setView((cur) => applyRegistryEvent(cur, msg));
      }
    };
    ws.onclose = () => {
      setAdminOnline(false);
      if (adminWsRef.current === ws) adminWsRef.current = null;
      // Reconnect with backoff; the next open re-fetches the snapshot.
      adminWsReconnectRef.current = setTimeout(() => connectAdminWs(adminBase.trim()), 3000);
    };
    ws.onerror = () => { /* close follows and schedules the reconnect */ };
  }, [adminBase, loadDevices]);

  // Auto-load the registry + subscribe to realtime events whenever the
  // admin base is known (saved previously or derived from the Brain URL).
  useEffect(() => {
    const base = adminBase.trim();
    if (!/^https?:\/\//.test(base)) return;
    void loadDevices();
    connectAdminWs(base);
    return () => {
      clearTimeout(adminWsReconnectRef.current);
      adminWsRef.current?.close();
      adminWsRef.current = null;
    };
  }, [adminBase, loadDevices, connectAdminWs]);

  const generateCode = async () => {
    const base = adminBase.trim();
    if (!/^https?:\/\//.test(base)) {
      setAdminError('Enter the Brain admin address first (http://host:port — same machine as the Brain).');
      return;
    }
    setAdminBusy('pairing');
    setAdminError(null);
    try {
      const res = await brainAdmin.startPairing(base);
      setGeneratedCode({ code: res.code, expiresAt: Date.now() + res.expiresInSec * 1000 });
      localStorage.setItem('blaxin-brain-admin-base', base.replace(/\/+$/, ''));
    } catch (err: any) {
      setAdminError(err?.message || String(err));
    } finally {
      setAdminBusy(null);
    }
  };

  const useGeneratedCode = () => {
    if (!generatedCode) return;
    // Same machine: convert the admin base to the /ws/brain URL.
    const base = adminBase.trim().replace(/\/+$/, '');
    if (/^https?:\/\//.test(base)) {
      const wsUrl = `${base.replace(/^http/, 'ws')}/ws/brain`;
      setBrainUrl(wsUrl);
      localStorage.setItem('blaxin-brain-url', wsUrl);
    }
    setPairCode(generatedCode.code);
    setGeneratedCode(null);
    setNotice({ kind: 'ok', text: 'Pairing code copied into the form — connect below.' });
  };

  const revokeDevice = async (d: BrainDevice) => {
    setAdminBusy(`revoke:${d.bodyId}`);
    try {
      await brainAdmin.revokeDevice(adminBase, d.bodyId);
      setRevokeArmed(null);
      // The realtime event stream already carries the body-revoked event;
      // the snapshot fetch is the authoritative recovery path.
      await loadDevices();
      await refresh(); // revoking THIS body changes the link state
      setNotice({ kind: 'ok', text: `Revoked ${d.name || d.bodyId}. A revoked device cannot reconnect.` });
    } catch (err: any) {
      setAdminError(err?.message || String(err));
    } finally {
      setAdminBusy(null);
    }
  };

  const selectBody = (d: BrainDevice) => {
    setSelectedBodyId(d.bodyId);
    localStorage.setItem('blaxin-brain-selected-body', d.bodyId);
  };

  const devices = registryLoaded || view.bodies.length > 0 ? view.bodies : null;
  const selectedBody = devices?.find((d) => d.bodyId === selectedBodyId) ?? null;
  const registrySummary = {
    total: view.bodies.length,
    online: view.bodies.filter((d) => d.status === 'online').length,
    revoked: view.bodies.filter((d) => d.status === 'revoked').length,
  };

  // Stop polling while a revoke is in flight? Polling is cheap; keep it.

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-primary)' }}>
            <FiCpu size={20} color="var(--accent-primary)" />
            BLAXIN Brain
          </h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {external
              ? 'Connection to your external Brain — status is reported by this Body'
              : 'This device runs the embedded Brain (local intelligence)'}
          </p>
        </div>
        <button onClick={refresh} style={{ ...btnBase }} disabled={busy !== null}>
          <FiRefreshCw size={12} className={busy ? 'spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Notice */}
      {notice && (
        <div style={{
          marginBottom: 16, padding: '10px 14px', borderRadius: 'var(--radius-sm)',
          background: notice.kind === 'ok' ? 'rgba(0, 255, 136, 0.08)' : 'rgba(255, 51, 85, 0.1)',
          border: `1px solid ${notice.kind === 'ok' ? 'rgba(0,255,136,0.3)' : 'rgba(255,51,85,0.35)'}`,
          color: notice.kind === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)',
          fontSize: 12, lineHeight: 1.5,
        }}>
          {notice.text}
        </div>
      )}

      {/* Status card */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '16px 18px', marginBottom: 20,
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          color: meta.color, fontWeight: 700, fontFamily: 'var(--font-mono)',
          letterSpacing: 1, fontSize: 15,
        }}>
          {external && brain?.state === 'CONNECTED'
            ? <FiWifi size={18} />
            : external ? <FiWifiOff size={18} /> : <FiServer size={18} />}
          <span>{external ? meta.label : 'EMBEDDED'}</span>
        </div>
        <div style={{ width: 1, height: 30, background: 'var(--border-subtle)' }} />
        <div style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {external && brain?.brainName && <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{brain.brainName} </span>}
          {external && brain?.brainId && <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{brain.brainId}</span>}
          {external && brain?.protocol ? <span style={{ marginLeft: 8 }}>protocol v{brain.protocol}</span> : null}
          {external && brain?.transport && (
            <span style={{ marginLeft: 8 }}>{transportBadge(brain)}</span>
          )}
          {!external && <span>Local orchestrator + providers act as the Brain in this process.</span>}
        </div>
        {external && brain?.state === 'CONNECTED' && (
          <div style={{
            padding: '4px 10px', borderRadius: 'var(--radius-sm)', fontSize: 10,
            background: 'rgba(0,255,136,0.1)', color: 'var(--accent-green)',
            fontFamily: 'var(--font-mono)', letterSpacing: 0.5,
          }}>
            {brain.sessionId ? `SESSION ${brain.sessionId.slice(0, 8)}` : 'AUTHENTICATED'}
          </div>
        )}
      </div>

      {/* Last error / offline explainer */}
      {external && brain?.lastError && brain.state !== 'CONNECTED' && (
        <div style={{
          marginBottom: 20, padding: '10px 14px', borderRadius: 'var(--radius-sm)',
          background: 'rgba(255, 51, 85, 0.08)', border: '1px solid rgba(255,51,85,0.25)',
          color: 'var(--accent-red)', fontSize: 12, lineHeight: 1.5,
        }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <FiAlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} />
            <span>{brain.lastError}</span>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Left column: status details + connection */}
        <div style={{ flex: 1, minWidth: 320 }}>
          {/* Details */}
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '4px 16px 12px', marginBottom: 16 }}>
            <SectionTitle>Link status</SectionTitle>
            <Row k="Mode" v={external ? 'BODY → EXTERNAL BRAIN' : 'EMBEDDED BRAIN'} mono />
            <Row k="State" v={external ? `${meta.label}${brain?.state ? ` (${brain.state})` : ''}` : 'local'} mono />
            <Row k="Body ID" v={brainStatus?.bodyId || '—'} mono />
            {external && <>
              <Row k="Brain ID" v={brain?.brainId || '—'} mono />
              <Row k="Protocol" v={brain?.protocol ? `v${brain.protocol}` : '—'} mono />
              <Row k="Transport" v={transportHuman(brain)} mono />
              <Row k="Connected at" v={fmtTime(brain?.connectedAt)} />
            </>}
          </div>

          {/* Connection controls */}
          {external && (
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '0 16px 16px', marginBottom: 16 }}>
              <SectionTitle>Connect / pair</SectionTitle>
              <label style={labelStyle}>BRAIN ADDRESS</label>
              <input
                style={inputStyle}
                placeholder="wss://brain-host:3100/ws/brain"
                value={brainUrl}
                onChange={(e) => setBrainUrl(e.target.value)}
                spellCheck={false}
              />
              <div style={{ height: 10 }} />
              <label style={labelStyle}>ONE-TIME PAIRING CODE <span style={{ color: 'var(--text-muted)', textTransform: 'none', letterSpacing: 0 }}>(only for first contact — never stored)</span></label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  style={inputStyle}
                  placeholder="AB7K-92QX"
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value.toUpperCase())}
                  spellCheck={false}
                />
                <button
                  onClick={handleConnect}
                  disabled={busy !== null}
                  style={{ ...btnBase, background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', color: '#04121a', border: 'none', whiteSpace: 'nowrap' }}
                >
                  {busy === 'connect' ? <FiLoader size={12} className="spin" /> : <FiLink size={12} />}
                  CONNECT
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button onClick={() => act('reconnect', () => api.reconnectBrain())} disabled={busy !== null} style={btnBase}>
                  <FiRefreshCw size={11} /> Reconnect
                </button>
                <button onClick={() => act('disconnect', () => api.disconnectBrain())} disabled={busy !== null} style={btnBase}>
                  <FiX size={11} /> Disconnect
                </button>
                <button
                  onClick={() => act('unpair', async () => { await api.unpairBrain(); setNotice({ kind: 'ok', text: 'Saved Brain pairing cleared on this Body. Re-pair with a fresh code to reconnect.' }); })}
                  disabled={busy !== null}
                  style={{ ...btnBase, color: 'var(--accent-red)' }}
                  title="Forget this Brain locally (does not affect the Brain's registry)"
                >
                  <FiTrash2 size={11} /> Unpair
                </button>
              </div>
              {!external && (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 12 }}>
                  To connect this device to an external Brain, run the server with{' '}
                  <code style={monoChip}>BLAXIN_BRAIN_MODE=external</code> and a Brain URL, then return here to pair.
                </p>
              )}
            </div>
          )}

          {!external && (
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '0 16px 16px' }}>
              <SectionTitle>About</SectionTitle>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                The <b style={{ color: 'var(--text-primary)' }}>Brain</b> is the intelligence (reasoning, planning, AI providers); the{' '}
                <b style={{ color: 'var(--text-primary)' }}>Body</b> is the executor (UI, terminal, filesystem, policy). In the default{' '}
                <code style={monoChip}>embedded</code> mode both run in this process. When the server runs in{' '}
                <code style={monoChip}>external</code> mode, this panel shows the secure link to the Brain, lets you pair with a one-time code,
                and — when this browser is allowed to reach the Brain's admin plane — generate codes and revoke devices.
              </p>
            </div>
          )}
        </div>

        {/* Right column: Brain admin (pairing codes + device registry) */}
        {(external || true) && (
          <div style={{ flex: 1, minWidth: 320 }}>
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '0 16px 16px', marginBottom: 16 }}>
              <SectionTitle title="Brain admin (on the Brain machine)">
                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400, letterSpacing: 0 }}>— code generation &amp; device registry live on the Brain</span>
              </SectionTitle>
              <label style={labelStyle}>BRAIN ADMIN ADDRESS</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  style={inputStyle}
                  placeholder="http://127.0.0.1:3100"
                  value={adminBase}
                  onChange={(e) => setAdminBase(e.target.value)}
                  spellCheck={false}
                />
                <button onClick={loadDevices} disabled={adminBusy !== null} style={btnBase}>
                  {adminBusy === 'devices' ? <FiLoader size={11} className="spin" /> : <FiShield size={11} />}
                  Devices
                </button>
              </div>
              <div style={{ height: 10 }} />
              <button onClick={generateCode} disabled={adminBusy !== null} style={{ ...btnBase, background: 'rgba(255, 196, 0, 0.12)', borderColor: 'rgba(255,196,0,0.3)', color: 'var(--accent-yellow)' }}>
                {adminBusy === 'pairing' ? <FiLoader size={11} className="spin" /> : <FiKey size={11} />}
                NEW PAIRING CODE
              </button>

              {generatedCode && (
                <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,196,0,0.08)', border: '1px solid rgba(255,196,0,0.3)' }}>
                  <div style={{ fontSize: 10, color: 'var(--accent-yellow)', letterSpacing: 1, marginBottom: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <FiClock size={10} /> CODE EXPIRES {Math.max(0, Math.round((generatedCode.expiresAt - Date.now()) / 1000))}S
                  </div>
                  <div style={{ fontSize: 24, fontFamily: 'var(--font-mono)', fontWeight: 800, letterSpacing: 4, color: 'var(--text-primary)' }}>
                    {generatedCode.code}
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <button onClick={useGeneratedCode} style={{ ...btnBase, background: 'rgba(0,240,255,0.15)', borderColor: 'rgba(0,240,255,0.3)', color: 'var(--accent-primary)', padding: '5px 10px', fontSize: 11 }}>
                      <FiLink size={10} /> Use for this Body
                    </button>
                    <button onClick={() => setGeneratedCode(null)} style={{ ...btnBase, padding: '5px 10px', fontSize: 11 }}><FiX size={10} /> Dismiss</button>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    One-time, expires shortly, never reused. Type it on the device that wants to connect.
                  </div>
                </div>
              )}

              {adminError && (
                <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,51,85,0.08)', border: '1px solid rgba(255,51,85,0.25)', color: 'var(--accent-red)', fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                  <FiAlertTriangle size={12} style={{ marginRight: 6 }} />
                  {adminError}
                </div>
              )}
            </div>

            {/* Device registry — authoritative mirror of the Brain's body
                registry (REST snapshot + version-guarded realtime events) */}
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '0 16px 12px' }}>
              <SectionTitle title={`Devices — ${registrySummary.total} registered · ${registrySummary.online} online · ${registrySummary.revoked} revoked`}>
                <span style={{ fontSize: 10, color: adminOnline ? 'var(--accent-green)' : 'var(--text-muted)', fontWeight: 400, letterSpacing: 0, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: adminOnline ? 'var(--accent-green)' : 'var(--text-muted)', display: 'inline-block' }} />
                  {adminOnline ? `live · v${view.version}` : 'realtime offline — snapshot only'}
                </span>
              </SectionTitle>
              {devices === null ? (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Load the device registry from the Brain admin plane above. You can revoke a Body here — a revoked device can never reconnect with its old identity.
                </p>
              ) : devices.length === 0 ? (
                <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>No devices registered on this Brain yet.</p>
              ) : (
                devices.map((d) => {
                  const online = d.status === 'online';
                  const revoked = d.status === 'revoked';
                  const isSelf = d.bodyId === brainStatus?.bodyId;
                  const isSelected = d.bodyId === selectedBodyId;
                  return (
                    <div
                      key={d.bodyId}
                      onClick={() => selectBody(d)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectBody(d); } }}
                      title="Select this Body to inspect it"
                      style={{
                        padding: '10px 10px', margin: '0 -10px', borderRadius: 'var(--radius-sm)',
                        borderBottom: '1px solid var(--border-subtle)', opacity: revoked ? 0.55 : 1,
                        cursor: 'pointer', outline: 'none',
                        background: isSelected ? 'rgba(0,240,255,0.06)' : 'transparent',
                        border: isSelected ? '1px solid rgba(0,240,255,0.25)' : '1px solid transparent',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: revoked ? 'var(--accent-red)' : online ? 'var(--accent-green)' : 'var(--text-muted)', boxShadow: online ? '0 0 6px var(--accent-green)' : 'none', flexShrink: 0 }} />
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{d.name}</span>
                        {isSelf && <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 'var(--radius-sm)', background: 'rgba(0,240,255,0.12)', color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)' }}>THIS BODY</span>}
                        {revoked && <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,51,85,0.15)', color: 'var(--accent-red)', fontFamily: 'var(--font-mono)' }}>REVOKED</span>}
                        {isSelected && <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 'var(--radius-sm)', background: 'rgba(0,255,136,0.12)', color: 'var(--accent-green)', fontFamily: 'var(--font-mono)' }}><FiCheckCircle size={9} style={{ verticalAlign: -1, marginRight: 3 }} />SELECTED</span>}
                        <div style={{ flex: 1 }} />
                        {!revoked && (
                          revokeArmed === d.bodyId ? (
                            <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                              <button onClick={() => revokeDevice(d)} disabled={adminBusy !== null} style={{ ...btnBase, background: 'rgba(255,51,85,0.2)', borderColor: 'var(--accent-red)', color: 'var(--accent-red)', padding: '4px 9px', fontSize: 11 }}>
                                Confirm revoke
                              </button>
                              <button onClick={() => setRevokeArmed(null)} style={{ ...btnBase, padding: '4px 9px', fontSize: 11 }}>Cancel</button>
                            </div>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); setRevokeArmed(d.bodyId); }}
                              disabled={adminBusy !== null}
                              style={{ ...btnBase, color: 'var(--accent-red)', padding: '4px 9px', fontSize: 11 }}
                              title={isSelf ? 'Revoking this Body disconnects it and requires a fresh pairing' : 'Revoke this device'}
                            >
                              <FiTrash2 size={10} /> Revoke
                            </button>
                          )
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{d.bodyId}</span>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>· {online ? 'online' : revoked ? 'revoked' : 'offline'}</span>
                        {d.lastSeen && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>· last seen {fmtTime(d.lastSeen)}</span>}
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>·</span>
                        {(d.capabilities || []).slice(0, 6).map((c) => (
                          <span key={c} style={{ fontSize: 9, padding: '1px 6px', borderRadius: 'var(--radius-sm)', background: 'rgba(0,240,255,0.08)', color: 'var(--accent-secondary)', fontFamily: 'var(--font-mono)' }}>{c}</span>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}

              {/* Selected Body details (safe public metadata only) */}
              {selectedBody && (
                <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
                  <div style={{ fontSize: 10, letterSpacing: 1, color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>SELECTED BODY</div>
                  <Row k="Name" v={selectedBody.name || '—'} />
                  <Row k="Body ID" v={selectedBody.bodyId} mono />
                  <Row k="Status" v={String(selectedBody.status || '—').toUpperCase()} mono />
                  <Row k="Protocol" v={selectedBody.protocol ? `v${selectedBody.protocol.min}–${selectedBody.protocol.max}` : '—'} mono />
                  <Row k="Paired at" v={fmtDate(selectedBody.pairedAt)} />
                  <Row k="Last seen" v={fmtTime(selectedBody.lastSeen)} />
                  {selectedBody.revokedAt ? <Row k="Revoked at" v={fmtDate(selectedBody.revokedAt)} /> : null}
                  <Row
                    k="Capabilities"
                    v={(selectedBody.capabilities || []).length > 0
                      ? (selectedBody.capabilities as string[]).join(', ')
                      : '—'}
                    mono
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)',
  margin: '12px 0 6px', textTransform: 'uppercase', fontFamily: 'var(--font-mono)',
};

const monoChip: React.CSSProperties = {
  background: 'var(--bg-tertiary)', padding: '1px 5px', borderRadius: 4,
  fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--accent-primary)',
};

function SectionTitle({ children, title }: { children?: React.ReactNode; title?: string }) {
  return (
    <div style={{ padding: '12px 0 4px', display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)' }}>
        {title ?? children}
      </span>
      {title && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{children}</span>}
    </div>
  );
}
