import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { FiDownload, FiExternalLink, FiX, FiCheck, FiLoader, FiAlertTriangle, FiRefreshCw } from 'react-icons/fi';

interface UpdateInfo {
  updateAvailable: boolean;
  currentVersion?: string;
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseDate?: string;
  downloadUrl?: string;
  assets?: Array<{
    name: string;
    size: number;
    downloadUrl: string;
    contentType: string;
  }>;
  error?: string;
}

// Check if Tauri is available
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

// Tauri updater commands
async function checkTauriUpdate(): Promise<any> {
  try {
    const { invoke } = (window as any).__TAURI__.core;
    return await invoke('check_for_updates');
  } catch (err) {
    console.error('[BLAXIN] Tauri update check failed:', err);
    return null;
  }
}

async function installTauriUpdate(): Promise<any> {
  try {
    const { invoke } = (window as any).__TAURI__.core;
    return await invoke('install_update');
  } catch (err) {
    console.error('[BLAXIN] Tauri update install failed:', err);
    return { success: false, message: String(err) };
  }
}

export function UpdateNotifier() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [useTauriUpdater, setUseTauriUpdater] = useState(false);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    setInstallError(null);
    
    try {
      // Try Tauri updater first
      if (isTauri()) {
        const tauriResult = await checkTauriUpdate();
        if (tauriResult && tauriResult.updateAvailable) {
          setUseTauriUpdater(true);
          setUpdateInfo({
            updateAvailable: true,
            currentVersion: tauriResult.currentVersion,
            latestVersion: tauriResult.latestVersion,
            releaseNotes: tauriResult.releaseNotes,
            releaseDate: tauriResult.releaseDate,
            downloadUrl: tauriResult.downloadUrl,
          });
          if (tauriResult.latestVersion !== dismissed) {
            setShowBanner(true);
          }
          return;
        }
      }

      // Fallback to API check
      const result = await fetch('/api/update/check');
      const data = await result.json();
      setUpdateInfo(data);
      
      if (data.updateAvailable && data.latestVersion !== dismissed) {
        setShowBanner(true);
      }
    } catch (err) {
      console.error('[BLAXIN] Update check failed:', err);
    } finally {
      setChecking(false);
    }
  }, [dismissed]);

  // Check on mount and periodically
  useEffect(() => {
    checkForUpdates();
    const interval = setInterval(checkForUpdates, 30 * 60 * 1000); // Every 30 minutes
    return () => clearInterval(interval);
  }, []);

  const handleUpdateNow = async () => {
    if (useTauriUpdater) {
      // Use Tauri auto-updater for real automatic update
      setInstalling(true);
      setInstallProgress('Checking for updates...');
      
      try {
        const result = await installTauriUpdate();
        if (result?.success) {
          setInstallProgress('Update installed! BLAXIN will restart...');
          // Tauri will handle the restart
        } else {
          setInstallError(result?.message || 'Update failed. Please try again or download manually.');
          setInstalling(false);
        }
      } catch (err) {
        setInstallError('Update failed: ' + String(err));
        setInstalling(false);
      }
    } else {
      // Fallback: open the release page in browser for manual download
      if (updateInfo?.downloadUrl) {
        window.open(updateInfo.downloadUrl, '_blank');
      }
    }
  };

  const handleDismiss = () => {
    setDismissed(updateInfo?.latestVersion || null);
    setShowBanner(false);
    setInstalling(false);
    setInstallProgress(null);
    setInstallError(null);
  };

  if (!showBanner || !updateInfo?.updateAvailable) return null;

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return dateStr;
    }
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 150,
      display: 'flex', justifyContent: 'center', padding: '12px 24px',
    }}>
      <div style={{
        maxWidth: 650, width: '100%',
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
            background: installing ? 'rgba(0, 255, 136, 0.1)' : 'rgba(0, 240, 255, 0.1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            {installing ? (
              <FiLoader size={16} color="var(--accent-green)" className="spin" />
            ) : (
              <FiDownload size={16} color="var(--accent-primary)" />
            )}
          </div>

          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                BLAXIN Update Available
              </span>
              <span style={{
                padding: '1px 6px', borderRadius: 'var(--radius-sm)', fontSize: 9,
                background: 'rgba(0, 240, 255, 0.15)', color: 'var(--accent-primary)',
                fontFamily: 'var(--font-mono)', fontWeight: 700,
              }}>{updateInfo.latestVersion}</span>
              {useTauriUpdater && (
                <span style={{
                  padding: '1px 6px', borderRadius: 'var(--radius-sm)', fontSize: 8,
                  background: 'rgba(0, 255, 136, 0.15)', color: 'var(--accent-green)',
                  fontFamily: 'var(--font-mono)', fontWeight: 700,
                }}>AUTO-UPDATE</span>
              )}
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
              Current: v{updateInfo.currentVersion} → New: v{updateInfo.latestVersion}
              {updateInfo.releaseDate && ` • ${formatDate(updateInfo.releaseDate)}`}
            </div>

            {/* Release notes preview */}
            {updateInfo.releaseNotes && (
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

            {/* Install progress */}
            {installing && installProgress && (
              <div style={{
                padding: '8px 10px', marginBottom: 10,
                background: 'rgba(0, 255, 136, 0.05)',
                border: '1px solid rgba(0, 255, 136, 0.2)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12, color: 'var(--accent-green)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <FiLoader size={12} className="spin" />
                {installProgress}
              </div>
            )}

            {/* Install error */}
            {installError && (
              <div style={{
                padding: '8px 10px', marginBottom: 10,
                background: 'rgba(255, 51, 85, 0.05)',
                border: '1px solid rgba(255, 51, 85, 0.2)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12, color: 'var(--accent-red)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <FiAlertTriangle size={12} />
                {installError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {installing ? (
                <button disabled style={{
                  padding: '6px 14px',
                  background: 'rgba(0, 255, 136, 0.1)',
                  color: 'var(--accent-green)',
                  borderRadius: 'var(--radius-md)', fontSize: 12, fontWeight: 500,
                  display: 'flex', alignItems: 'center', gap: 6,
                  border: '1px solid rgba(0, 255, 136, 0.3)',
                  opacity: 0.7,
                }}>
                  <FiLoader size={12} className="spin" />
                  Updating...
                </button>
              ) : useTauriUpdater ? (
                <button onClick={handleUpdateNow} style={{
                  padding: '6px 14px',
                  background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                  color: '#fff', borderRadius: 'var(--radius-md)', fontSize: 12, fontWeight: 500,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <FiDownload size={12} />
                  Update Now
                </button>
              ) : updateInfo.downloadUrl ? (
                <a
                  href={updateInfo.downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    padding: '6px 14px',
                    background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                    color: '#fff', borderRadius: 'var(--radius-md)', fontSize: 12, fontWeight: 500,
                    display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none',
                  }}
                >
                  <FiExternalLink size={12} /> View Release
                </a>
              ) : (
                <button disabled style={{
                  padding: '6px 14px', background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
                  borderRadius: 'var(--radius-md)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <FiLoader size={12} /> Checking...
                </button>
              )}

              <button onClick={handleDismiss} style={{
                padding: '6px 12px', background: 'transparent', color: 'var(--text-muted)',
                borderRadius: 'var(--radius-md)', fontSize: 12,
              }}>
                Later
              </button>
            </div>
          </div>

          <button onClick={handleDismiss} style={{
            color: 'var(--text-muted)', background: 'none', flexShrink: 0,
          }}>
            <FiX size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
