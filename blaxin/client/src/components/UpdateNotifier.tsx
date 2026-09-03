import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';
import { useAppStore } from '../utils/store';
import { FiDownload, FiExternalLink, FiX, FiLoader, FiAlertTriangle, FiCheckCircle, FiShield } from 'react-icons/fi';

// ── Types ──────────────────────────────────────────────────────────────

interface ArtifactInfo {
  url: string;
  hasSignature: boolean;
  sha256?: string;
}

interface FullUpdateInfo {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string;
  pubDate: string;
  isDebInstall: boolean;
  deb?: ArtifactInfo;
  appimage?: ArtifactInfo;
  error?: string;
}

interface UpdateProgress {
  stage: string; // checking | downloading | verifying | installing | restarting | error
  percent: number;
  message: string;
}

type UiStage =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'restarting'
  | 'error';

const AUTO_UPDATE_KEY = 'blaxin-auto-update';

/** True while an agent task is running (auto-install must wait). */
function isAgentBusy(): boolean {
  try {
    const state = useAppStore.getState().agentState;
    return ['thinking', 'planning', 'executing', 'observing', 'waiting', 'requires-confirmation'].includes(state);
  } catch {
    return false;
  }
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = (window as any).__TAURI__.core;
  return invoke(cmd, args);
}

function tauriListen(event: string, handler: (e: any) => void): Promise<() => void> {
  const { listen } = (window as any).__TAURI__.event;
  return listen(event, handler);
}

// ── Component ──────────────────────────────────────────────────────────

export function UpdateNotifier() {
  const [updateInfo, setUpdateInfo] = useState<FullUpdateInfo | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [stage, setStage] = useState<UiStage>('idle');
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // Automatic install is OPT-IN. An update must never yank the app out
  // from under the user (it restarts BLAXIN and kills any in-flight agent
  // task), so the default is a notification banner with a manual
  // "Update Now" button.
  const [autoUpdate, setAutoUpdate] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_UPDATE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [isServerMode, setIsServerMode] = useState(false);
  const [rollbackInfo, setRollbackInfo] = useState<{ canRollback: boolean; previousVersion?: string; pendingVersion?: string }>({ canRollback: false });
  const autoStartRef = useRef<boolean | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_UPDATE_KEY, autoUpdate ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [autoUpdate]);

  // A freshly installed update that never confirmed a successful startup
  // leaves a pending marker — offer to restore the previous version so a
  // broken release can never strand the user.
  useEffect(() => {
    if (!isTauri()) return;
    tauriInvoke('rollback_status')
      .then((s: any) => setRollbackInfo(s || { canRollback: false }))
      .catch(() => undefined);
  }, []);

  const startRollback = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setErrorMsg(null);
    setRollbackInfo({ canRollback: false });
    setShowBanner(true);
    setStage('downloading');
    try {
      await tauriInvoke('rollback_update');
      setStage('restarting');
    } catch (err) {
      console.error('[BLAXIN] rollback failed:', err);
      setStage('error');
      setErrorMsg(String(err || 'Restoring the previous version failed.'));
    } finally {
      busyRef.current = false;
    }
  }, []);

  // Progress events streamed from the native updater.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    tauriListen('blaxin-update-progress', (e: any) => {
      const p = e?.payload as UpdateProgress;
      if (!p) return;
      setProgress(p);
      if (p.stage === 'downloading') setStage('downloading');
      else if (p.stage === 'verifying') setStage('verifying');
      else if (p.stage === 'installing') setStage('installing');
      else if (p.stage === 'restarting') setStage('restarting');
      else if (p.stage === 'error') {
        setStage('error');
        setErrorMsg(p.message);
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, []);

  const startInstall = useCallback(
    async (info: FullUpdateInfo) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setErrorMsg(null);
      setShowBanner(true);
      try {
        if (info.isDebInstall && info.deb) {
          // Signed .deb flow (system install via pkexec).
          await tauriInvoke('install_update_full', { kind: 'deb' });
          // On success the native side restarts the app; keep showing the
          // restarting state until the process exits.
          setStage('restarting');
        } else if (info.appimage) {
          // AppImage flow — Tauri's built-in updater (signed, same key).
          setStage('downloading');
          const result = await tauriInvoke('install_update');
          if (result?.success) {
            setStage('restarting');
            try {
              await tauriInvoke('relaunch_app');
            } catch {
              /* native side already handles restart; ignore */
            }
          } else {
            setStage('error');
            setErrorMsg(result?.message || 'Update failed. Please try again.');
          }
        } else {
          setStage('error');
          setErrorMsg('No signed Linux update artifact is available for this install.');
        }
      } catch (err) {
        console.error('[BLAXIN] update install failed:', err);
        setStage('error');
        setErrorMsg(String(err || 'Update failed.'));
      } finally {
        busyRef.current = false;
      }
    },
    []
  );

  const runCheck = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = !!opts?.silent;
      if (!silent) setStage('checking');
      try {
        if (isTauri()) {
          const info = (await tauriInvoke('check_for_update_full')) as FullUpdateInfo;
          setUpdateInfo(info);
          if (info.error) {
            console.warn('[BLAXIN] update check reported an issue:', info.error);
          }
          if (info.updateAvailable && info.latestVersion !== dismissed) {
            // A brand-new version — re-enable auto-install even if the user
            // dismissed an older one.
            autoStartRef.current = null;
            setShowBanner(true);
            setStage('idle');
            // Opt-in automatic install of trusted, signed updates — but
            // never while the agent is busy (an install restarts BLAXIN
            // and would kill the running task). Re-check at fire time too,
            // because the agent may have started a task in the meantime.
            if (autoUpdate && !isAgentBusy()) {
              setTimeout(() => {
                if (!isAgentBusy()) {
                  startInstall(info);
                }
                // If the agent became busy, the banner remains visible and
                // the user can install when it goes idle.
              }, 2500);
            }
          }
          return;
        }
        // Browser/server mode: informational check only.
        setIsServerMode(true);
        const data = await api.updateCheck();
        if (data.updateAvailable && data.latestVersion !== dismissed) {
          setUpdateInfo({
            updateAvailable: true,
            currentVersion: data.currentVersion || '',
            latestVersion: data.latestVersion || '',
            releaseNotes: data.releaseNotes || '',
            pubDate: data.releaseDate || '',
            isDebInstall: false,
            appimage: data.downloadUrl ? { url: data.downloadUrl, hasSignature: false } : undefined,
          });
          setShowBanner(true);
        }
      } catch (err) {
        console.error('[BLAXIN] Update check failed:', err);
      } finally {
        if (!silent) setStage('idle');
      }
    },
    [dismissed, autoUpdate, startInstall]
  );

  // Keep a ref to the latest runCheck so the mount/interval effect stays
  // stable (a changing callback would reset the interval on every render).
  const runCheckRef = useRef(runCheck);
  runCheckRef.current = runCheck;

  // Check on mount and periodically (every 4 hours — polite to the network).
  useEffect(() => {
    runCheckRef.current();
    const interval = setInterval(() => runCheckRef.current({ silent: true }), 4 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const handleDismiss = () => {
    autoStartRef.current = false;
    setDismissed(updateInfo?.latestVersion || null);
    setShowBanner(false);
    setStage('idle');
    setProgress(null);
    setErrorMsg(null);
  };

  const handleUpdateNow = () => {
    if (updateInfo) startInstall(updateInfo);
  };

  // Rollback banner takes precedence over the update banner: a failed
  // update that never started is more urgent than a new available update.
  const isBusy =
    stage === 'downloading' ||
    stage === 'verifying' ||
    stage === 'installing' ||
    stage === 'restarting';

  if (!showBanner && !rollbackInfo.canRollback) return null;

  if (rollbackInfo.canRollback && !showBanner) {
    return (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 150,
        display: 'flex', justifyContent: 'center', padding: '12px 24px',
      }}>
        <div style={{
          maxWidth: 680, width: '100%',
          background: 'var(--bg-secondary)', border: '1px solid rgba(255, 170, 0, 0.5)',
          borderRadius: 'var(--radius-lg)', padding: '16px 20px',
          boxShadow: '0 0 40px rgba(255, 170, 0, 0.15)',
          animation: 'slideDown 0.3s ease',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 'var(--radius-md)',
              background: 'rgba(255, 170, 0, 0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <FiAlertTriangle size={16} color="var(--accent-yellow)" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                The last BLAXIN update did not start correctly
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
                {rollbackInfo.pendingVersion ? `v${rollbackInfo.pendingVersion}` : 'The new version'} could not start. Your previous version is still
                available and your settings are untouched.{rollbackInfo.previousVersion ? ` You can restore v${rollbackInfo.previousVersion}.` : ''}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={startRollback}
                  disabled={isBusy}
                  style={{
                    padding: '6px 14px',
                    background: 'linear-gradient(135deg, #ffaa00, #ff6600)',
                    color: '#000', borderRadius: 'var(--radius-md)', fontSize: 12, fontWeight: 600,
                    display: 'flex', alignItems: 'center', gap: 6,
                    opacity: isBusy ? 0.6 : 1,
                  }}
                >
                  {isBusy ? <FiLoader size={12} className="spin" /> : <FiDownload size={12} />}
                  {isBusy ? 'Restoring…' : 'Restore previous version'}
                </button>
                <button
                  onClick={() => setRollbackInfo({ canRollback: false })}
                  style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-muted)', borderRadius: 'var(--radius-md)', fontSize: 12 }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const stageMessage = (): string => {
    if (progress?.message && stage !== 'error') return progress.message;
    switch (stage) {
      case 'checking':
        return 'Checking for updates…';
      case 'downloading':
        return 'Downloading update…';
      case 'verifying':
        return 'Verifying signature and checksum…';
      case 'installing':
        return 'Installing update…';
      case 'restarting':
        return 'Restarting BLAXIN…';
      default:
        return '';
    }
  };

  const percent =
    stage === 'downloading' && progress ? Math.min(100, Math.max(0, progress.percent || 0)) : null;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 150,
      display: 'flex', justifyContent: 'center', padding: '12px 24px',
    }}>
      <div style={{
        maxWidth: 680, width: '100%',
        background: 'var(--bg-secondary)', border: '1px solid var(--accent-primary)',
        borderRadius: 'var(--radius-lg)', padding: '16px 20px',
        boxShadow: '0 0 40px rgba(0, 240, 255, 0.15)',
        animation: 'slideDown 0.3s ease',
      }}>
        <style>{`
          @keyframes slideDown {
            from { transform: translateY(-20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
        `}</style>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 'var(--radius-md)',
            background:
              stage === 'error' ? 'rgba(255, 51, 85, 0.1)'
              : isBusy ? 'rgba(0, 255, 136, 0.1)'
              : 'rgba(0, 240, 255, 0.1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            {stage === 'error' ? (
              <FiAlertTriangle size={16} color="var(--accent-red)" />
            ) : isBusy ? (
              <FiLoader size={16} color="var(--accent-green)" className="spin" />
            ) : (
              <FiDownload size={16} color="var(--accent-primary)" />
            )}
          </div>

          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                A new BLAXIN update is available
              </span>
              <span style={{
                padding: '1px 6px', borderRadius: 'var(--radius-sm)', fontSize: 9,
                background: 'rgba(0, 240, 255, 0.15)', color: 'var(--accent-primary)',
                fontFamily: 'var(--font-mono)', fontWeight: 700,
              }}>v{updateInfo?.latestVersion}</span>
              {(updateInfo?.deb?.hasSignature || updateInfo?.appimage?.hasSignature) && !isServerMode && (
                <span title="Verified with the BLAXIN update public key" style={{
                  padding: '1px 6px', borderRadius: 'var(--radius-sm)', fontSize: 8,
                  background: 'rgba(0, 255, 136, 0.12)', color: 'var(--accent-green)',
                  fontFamily: 'var(--font-mono)', fontWeight: 700,
                  display: 'flex', alignItems: 'center', gap: 3,
                }}>
                  <FiShield size={8} /> SIGNED
                </span>
              )}
            </div>

            {!isServerMode && updateInfo?.currentVersion && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                Current: v{updateInfo.currentVersion} → New: v{updateInfo.latestVersion}
                {stage === 'downloading' && percent !== null && ` • ${percent}%`}
              </div>
            )}

            {/* Release notes preview */}
            {updateInfo?.releaseNotes && stage === 'idle' && (
              <div style={{
                maxHeight: 80, overflow: 'hidden', marginBottom: 10,
                fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5,
                padding: '8px 10px', background: 'var(--bg-primary)',
                borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)',
              }}>
                {updateInfo.releaseNotes.slice(0, 300)}
                {updateInfo.releaseNotes.length > 300 && '...'}
              </div>
            )}

            {/* Progress / state message */}
            {(isBusy || stage === 'error' || progress?.message) && (
              <div style={{
                padding: '8px 10px', marginBottom: 10,
                background: stage === 'error' ? 'rgba(255, 51, 85, 0.05)'
                  : 'rgba(0, 255, 136, 0.05)',
                border: `1px solid ${stage === 'error' ? 'rgba(255, 51, 85, 0.2)' : 'rgba(0, 255, 136, 0.2)'}`,
                borderRadius: 'var(--radius-sm)',
                fontSize: 12, color: stage === 'error' ? 'var(--accent-red)' : 'var(--accent-green)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                {stage === 'error' ? <FiAlertTriangle size={12} /> : <FiLoader size={12} className="spin" />}
                <span style={{ flex: 1 }}>{stage === 'error' ? errorMsg : stageMessage()}</span>
                {stage === 'downloading' && percent !== null && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{percent}%</span>
                )}
              </div>
            )}

            {stage === 'error' && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
                Your current BLAXIN version is untouched and keeps working. The update was aborted
                before anything was installed. You can retry, or update manually from the release page.
              </div>
            )}

            {stage === 'downloading' && percent !== null && (
              <div style={{
                height: 4, borderRadius: 2, marginBottom: 10, overflow: 'hidden',
                background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)',
              }}>
                <div style={{
                  height: '100%', width: `${percent}%`, transition: 'width 0.2s ease',
                  background: 'linear-gradient(90deg, var(--accent-primary), var(--accent-secondary))',
                }} />
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {isBusy ? (
                <button disabled style={{
                  padding: '6px 14px',
                  background: 'rgba(0, 255, 136, 0.1)', color: 'var(--accent-green)',
                  borderRadius: 'var(--radius-md)', fontSize: 12, fontWeight: 500,
                  display: 'flex', alignItems: 'center', gap: 6,
                  border: '1px solid rgba(0, 255, 136, 0.3)', opacity: 0.7,
                }}>
                  <FiLoader size={12} className="spin" />
                  {stage === 'restarting' ? 'Restarting…' : 'Updating…'}
                </button>
              ) : stage === 'error' ? (
                <button onClick={handleUpdateNow} style={{
                  padding: '6px 14px',
                  background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                  color: '#fff', borderRadius: 'var(--radius-md)', fontSize: 12, fontWeight: 500,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <FiDownload size={12} /> Retry Update
                </button>
              ) : isServerMode || !updateInfo ? (
                updateInfo?.appimage?.url ? (
                  <a
                    href={updateInfo.appimage.url}
                    target="_blank" rel="noopener noreferrer"
                    style={{
                      padding: '6px 14px',
                      background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                      color: '#fff', borderRadius: 'var(--radius-md)', fontSize: 12, fontWeight: 500,
                      display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none',
                    }}
                  >
                    <FiExternalLink size={12} /> View Release
                  </a>
                ) : null
              ) : (
                <button onClick={handleUpdateNow} style={{
                  padding: '6px 14px',
                  background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                  color: '#fff', borderRadius: 'var(--radius-md)', fontSize: 12, fontWeight: 500,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <FiDownload size={12} /> Update Now
                </button>
              )}

              {!isBusy && !isServerMode && updateInfo && (
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 5, fontSize: 11,
                  color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none',
                }}>
                  <input
                    type="checkbox"
                    checked={autoUpdate}
                    onChange={(e) => setAutoUpdate(e.target.checked)}
                    style={{ accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                  />
                  Install signed updates automatically
                </label>
              )}

              {!isBusy && (
                <button onClick={handleDismiss} style={{
                  padding: '6px 12px', background: 'transparent', color: 'var(--text-muted)',
                  borderRadius: 'var(--radius-md)', fontSize: 12,
                }}>
                  {stage === 'error' ? 'Close' : 'Later'}
                </button>
              )}
            </div>
          </div>

          {!isBusy && (
            <button onClick={handleDismiss} style={{
              color: 'var(--text-muted)', background: 'none', flexShrink: 0,
            }}>
              <FiX size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}