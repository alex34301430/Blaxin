import React, { useState, useEffect, useCallback } from 'react';
import { useAppStore, ModelInfo } from '../utils/store';
import { api } from '../services/api';
import {
  FiCheck, FiX, FiAlertTriangle, FiLoader, FiRefreshCw,
  FiKey, FiCpu, FiMonitor, FiShield, FiZap, FiServer,
  FiTerminal, FiFile, FiGlobe, FiWifi, FiWifiOff,
  FiArrowRight, FiArrowLeft, FiSettings, FiMousePointer
} from 'react-icons/fi';

interface SetupStep {
  id: string;
  title: string;
  icon: React.ReactNode;
}

const STEPS: SetupStep[] = [
  { id: 'welcome', title: 'Welcome', icon: <FiZap size={16} /> },
  { id: 'compatibility', title: 'System Check', icon: <FiMonitor size={16} /> },
  { id: 'permissions', title: 'Permissions', icon: <FiShield size={16} /> },
  { id: 'provider', title: 'AI Provider', icon: <FiKey size={16} /> },
  { id: 'apikey', title: 'API Key', icon: <FiKey size={16} /> },
  { id: 'models', title: 'Model Selection', icon: <FiCpu size={16} /> },
  { id: 'ready', title: 'Ready', icon: <FiCheck size={16} /> },
];

interface DiagnosticItem {
  name: string;
  status: 'ok' | 'warning' | 'error' | 'pending';
  message: string;
  suggestion?: string;
}

export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [currentStep, setCurrentStep] = useState(0);
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState<'idle' | 'validating' | 'valid' | 'invalid'>('idle');
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [apiKeyErrorCode, setApiKeyErrorCode] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [freeModels, setFreeModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const { setSettingsOpen } = useAppStore();

  const step = STEPS[currentStep];

  const nextStep = () => setCurrentStep(Math.min(currentStep + 1, STEPS.length - 1));
  const prevStep = () => setCurrentStep(Math.max(currentStep - 1, 0));

  // ── STEP: Compatibility Check ─────────────────────────────
  const runCompatibilityCheck = useCallback(async () => {
    setLoading(true);
    setDiagnostics([]);
    try {
      const result = await api.diagnostics();
      const items: DiagnosticItem[] = [];

      // Backend
      const backendGroup = result.groups?.find((g: any) => g.name === 'Backend Server');
      if (backendGroup) {
        for (const check of backendGroup.checks) {
          items.push({ name: check.name, status: check.status, message: check.message, suggestion: check.suggestion });
        }
      }

      // Desktop Control
      const desktopGroup = result.groups?.find((g: any) => g.name === 'Desktop Control');
      if (desktopGroup) {
        for (const check of desktopGroup.checks) {
          items.push({ name: check.name, status: check.status, message: check.message, suggestion: check.suggestion });
        }
      }

      // Browser
      const browserGroup = result.groups?.find((g: any) => g.name === 'Browser');
      if (browserGroup) {
        for (const check of browserGroup.checks) {
          items.push({ name: check.name, status: check.status, message: check.message, suggestion: check.suggestion });
        }
      }

      // File System
      const fsGroup = result.groups?.find((g: any) => g.name === 'File System');
      if (fsGroup) {
        for (const check of fsGroup.checks) {
          items.push({ name: check.name, status: check.status, message: check.message, suggestion: check.suggestion });
        }
      }

      setDiagnostics(items);
    } catch (err: any) {
      setDiagnostics([{ name: 'Backend', status: 'error', message: 'Failed to run diagnostics', suggestion: err.message }]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step.id === 'compatibility') runCompatibilityCheck();
  }, [step.id]);

  // ── STEP: Validate API Key ────────────────────────────────
  const validateAndSaveKey = async () => {
    if (!selectedProvider || !apiKey.trim()) return;
    setApiKeyStatus('validating');
    setApiKeyError(null);
    setApiKeyErrorCode(null);

    try {
      const result = await api.saveKey(selectedProvider, apiKey);
      if (result.valid) {
        setApiKeyStatus('valid');
        // Fetch models after successful key save
        const allModels = await api.getAllModels();
        setModels(allModels);
        const free = allModels.filter((m: ModelInfo) => m.isFree);
        setFreeModels(free);

        if (free.length > 0) {
          // Auto-select best free model
          const bestFree = free.find((m: ModelInfo) =>
            m.capabilities.includes('function-calling') && (m.contextWindow || 0) >= 8000
          ) || free[0];
          setSelectedModel(bestFree);
        }
      } else {
        setApiKeyStatus('invalid');
        setApiKeyError(result.error || 'Validation failed');
        setApiKeyErrorCode(result.code || null);
      }
    } catch (err: any) {
      setApiKeyStatus('invalid');
      setApiKeyError(err.message);
      setApiKeyErrorCode(err.code || null);
    }
  };

  // Some failures mean "we could not reach the provider" rather than
  // "this key is wrong". In that case the key is structurally valid and
  // may still be saved — it will be verified live on first use.
  const isNetworkTypeFailure = (code: string | null) =>
    !!code && (code.includes('NETWORK') || code.includes('TIMEOUT') || code.includes('SERVER'));

  const saveKeyWithoutValidation = async () => {
    if (!selectedProvider || !apiKey.trim()) return;
    setApiKeyStatus('validating');
    setApiKeyError(null);
    setApiKeyErrorCode(null);
    try {
      const result = await api.saveKey(selectedProvider, apiKey, { skipValidation: true });
      if (result.valid) {
        setApiKeyStatus('valid');
        const allModels = await api.getAllModels();
        setModels(allModels);
        setFreeModels(allModels.filter((m: ModelInfo) => m.isFree));
      } else {
        setApiKeyStatus('invalid');
        setApiKeyError(result.error || 'Validation failed');
        setApiKeyErrorCode(result.code || null);
      }
    } catch (err: any) {
      setApiKeyStatus('invalid');
      setApiKeyError(err.message);
      setApiKeyErrorCode(err.code || null);
    }
  };

  // ── STEP: Select Model ────────────────────────────────────
  const selectModel = async (model: ModelInfo) => {
    try {
      await api.setActiveModel(model.provider, model.id);
      setSelectedModel(model);
    } catch (err: any) {
      console.error('Failed to select model:', err);
    }
  };

  // ── RENDER: Welcome ───────────────────────────────────────
  const renderWelcome = () => (
    <div style={{ textAlign: 'center', padding: '20px 0' }}>
      <div style={{
        width: 80, height: 80, borderRadius: 'var(--radius-xl)',
        background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 24px', boxShadow: 'var(--glow-intense)',
      }}>
        <FiZap size={40} color="#fff" />
      </div>
      <h1 style={{
        fontSize: 32, fontWeight: 800, fontFamily: 'var(--font-mono)',
        letterSpacing: 4, marginBottom: 8,
        background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
      }}>BLAXIN</h1>
      <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>
        Personal AI Desktop Agent
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 400, margin: '0 auto', lineHeight: 1.7 }}>
        BLAXIN can control your desktop, run commands, manage files, browse the web, and complete complex tasks using AI.
        Let's get you set up in a few simple steps.
      </div>
    </div>
  );

  // ── RENDER: Compatibility ──────────────────────────────────
  const renderCompatibility = () => (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, color: 'var(--text-primary)' }}>
        System Compatibility Check
      </h3>

      {loading && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--accent-primary)' }}>
          <FiLoader size={24} className="spin" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 13 }}>Checking system compatibility...</div>
        </div>
      )}

      {!loading && diagnostics.length === 0 && (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ color: 'var(--accent-red)', marginBottom: 12 }}>No diagnostic data available</div>
          <button onClick={runCompatibilityCheck} style={{
            padding: '8px 16px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
            borderRadius: 'var(--radius-md)', fontSize: 12, border: '1px solid var(--border-subtle)',
          }}>Retry</button>
        </div>
      )}

      {!loading && diagnostics.length > 0 && (
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          {diagnostics.map((d, i) => {
            const colors: Record<string, string> = {
              ok: 'var(--accent-green)', warning: 'var(--accent-yellow)', error: 'var(--accent-red)', pending: 'var(--text-muted)'
            };
            const color = colors[d.status];
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                borderBottom: '1px solid var(--border-subtle)',
              }}>
                <div style={{
                  width: 20, height: 20, borderRadius: 'var(--radius-sm)',
                  background: `${color}15`, color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  {d.status === 'ok' ? <FiCheck size={10} /> : d.status === 'error' ? <FiX size={10} /> : <FiAlertTriangle size={10} />}
                </div>
                <div style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)' }}>{d.message}</div>
                <div style={{
                  padding: '2px 6px', borderRadius: 'var(--radius-sm)', fontSize: 9,
                  fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: 0.5,
                  background: `${color}15`, color,
                }}>{d.status.toUpperCase()}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  // ── RENDER: Permissions ────────────────────────────────────
  const renderPermissions = () => (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, color: 'var(--text-primary)' }}>
        Desktop Control Permissions
      </h3>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.7 }}>
        BLAXIN needs certain permissions to control your desktop. These are checked automatically.
      </div>
      {[
        { name: 'Mouse & Keyboard Control', desc: 'xdotool (X11) or ydotool (Wayland)', icon: <FiMousePointer size={14} /> },
        { name: 'Screenshot Capture', desc: 'scrot, grim, or gnome-screenshot', icon: <FiMonitor size={14} /> },
        { name: 'Clipboard Access', desc: 'xclip, xsel, or wl-clipboard', icon: <FiFile size={14} /> },
        { name: 'Terminal Execution', desc: 'bash/sh shell access', icon: <FiTerminal size={14} /> },
        { name: 'Browser Control', desc: 'firefox, chromium, or google-chrome', icon: <FiGlobe size={14} /> },
      ].map((item, i) => {
        const diag = diagnostics.find(d => d.name.toLowerCase().includes(item.name.split(' ')[0].toLowerCase()));
        const status = diag?.status || 'pending';
        const colors: Record<string, string> = {
          ok: 'var(--accent-green)', warning: 'var(--accent-yellow)', error: 'var(--accent-red)', pending: 'var(--text-muted)'
        };
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '12px',
            background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)', marginBottom: 8,
          }}>
            <div style={{ color: colors[status] }}>{item.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{item.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.desc}</div>
            </div>
            <div style={{
              padding: '2px 8px', borderRadius: 'var(--radius-sm)', fontSize: 9,
              fontFamily: 'var(--font-mono)', fontWeight: 700, background: `${colors[status]}15`, color: colors[status],
            }}>{status.toUpperCase()}</div>
          </div>
        );
      })}
    </div>
  );

  // ── RENDER: Provider Selection ─────────────────────────────
  const renderProviderSelection = () => {
    const providers = [
      { id: 'openrouter', name: 'OpenRouter', desc: '200+ models, free options available', recommended: true },
      { id: 'openai', name: 'OpenAI', desc: 'GPT-4o and other OpenAI models' },
      { id: 'anthropic', name: 'Anthropic', desc: 'Claude models with advanced reasoning' },
      { id: 'google', name: 'Google AI', desc: 'Gemini models with multimodal capabilities' },
      { id: 'groq', name: 'Groq', desc: 'Ultra-fast inference for open-source models' },
      { id: 'together', name: 'Together AI', desc: 'Open-source model hosting' },
      { id: 'ollama', name: 'Ollama (Local)', desc: 'Run AI models locally on your machine' },
    ];

    return (
      <div>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>
          Select AI Provider
        </h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Choose which AI service to use. OpenRouter is recommended for free model access.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {providers.map(p => (
            <button
              key={p.id}
              onClick={() => {
                setSelectedProvider(p.id);
                // Reset key state when switching providers to avoid
                // confusing cross-provider validation state
                setApiKey('');
                setApiKeyStatus('idle');
                setApiKeyError(null);
                setApiKeyErrorCode(null);
                setModels([]);
                setFreeModels([]);
                setSelectedModel(null);
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
                background: selectedProvider === p.id ? 'var(--bg-active)' : 'var(--bg-primary)',
                border: `1px solid ${selectedProvider === p.id ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                borderRadius: 'var(--radius-md)', textAlign: 'left',
                transition: 'all 0.2s',
              }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: 'var(--radius-sm)',
                background: selectedProvider === p.id ? 'rgba(0, 240, 255, 0.15)' : 'var(--bg-tertiary)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: selectedProvider === p.id ? 'var(--accent-primary)' : 'var(--text-muted)',
                fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
              }}>
                {p.name.slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {p.name}
                  {p.recommended && (
                    <span style={{
                      padding: '1px 6px', borderRadius: 'var(--radius-sm)', fontSize: 8,
                      background: 'rgba(0, 255, 136, 0.15)', color: 'var(--accent-green)',
                      fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: 0.5,
                    }}>RECOMMENDED</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.desc}</div>
              </div>
              {selectedProvider === p.id && <FiCheck size={14} color="var(--accent-primary)" />}
            </button>
          ))}
        </div>
      </div>
    );
  };

  // ── RENDER: API Key ───────────────────────────────────────
  const renderApiKey = () => (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>
        Configure API Key
      </h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
        Enter your API key for {selectedProvider ? selectedProvider.charAt(0).toUpperCase() + selectedProvider.slice(1) : 'the selected provider'}.
      </p>

      {selectedProvider === 'ollama' ? (
        <div style={{
          padding: '16px', background: 'rgba(0, 255, 136, 0.05)', border: '1px solid rgba(0, 255, 136, 0.2)',
          borderRadius: 'var(--radius-md)', fontSize: 13, color: 'var(--accent-green)',
        }}>
          Ollama runs locally — no API key needed. Just make sure Ollama is running.
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
            API Key
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="password"
              value={apiKey}
              onChange={e => { setApiKey(e.target.value); setApiKeyStatus('idle'); setApiKeyError(null); setApiKeyErrorCode(null); }}
              placeholder={`Enter your ${selectedProvider || 'provider'} API key`}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              style={{ flex: 1 }}
              onKeyDown={e => e.key === 'Enter' && validateAndSaveKey()}
            />
            <button
              onClick={validateAndSaveKey}
              disabled={apiKeyStatus === 'validating' || !apiKey.trim()}
              style={{
                padding: '8px 16px',
                background: apiKeyStatus === 'valid' ? 'rgba(0, 255, 136, 0.2)' : 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                color: apiKeyStatus === 'valid' ? 'var(--accent-green)' : '#fff',
                borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 500,
                display: 'flex', alignItems: 'center', gap: 6,
                opacity: (!apiKey.trim() || apiKeyStatus === 'validating') ? 0.5 : 1,
              }}
            >
              {apiKeyStatus === 'validating' ? <FiLoader size={12} className="spin" /> :
               apiKeyStatus === 'valid' ? <FiCheck size={12} /> : <FiKey size={12} />}
              {apiKeyStatus === 'validating' ? 'Validating...' : apiKeyStatus === 'valid' ? 'Valid' : 'Validate & Save'}
            </button>
          </div>

          {apiKeyError && (
            <div style={{
              marginTop: 10, padding: '10px 14px', background: 'rgba(255, 51, 85, 0.08)',
              border: '1px solid rgba(255, 51, 85, 0.3)', borderRadius: 'var(--radius-md)',
              fontSize: 12, color: 'var(--accent-red)',
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>What happened:</div>
              {apiKeyError}
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                What to do: {isNetworkTypeFailure(apiKeyErrorCode)
                  ? 'BLAXIN could not reach the provider to verify the key. This usually means a network problem — not a bad key. You can retry, or save the key and it will be verified the first time it is used.'
                  : 'Check that your key is correct and active at the provider\'s website. Keys are validated against the provider server, not by format alone.'}
              </div>
              {isNetworkTypeFailure(apiKeyErrorCode) && (
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button
                    onClick={saveKeyWithoutValidation}
                    disabled={apiKeyStatus === 'validating'}
                    style={{
                      padding: '6px 12px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                      borderRadius: 'var(--radius-sm)', fontSize: 12, border: '1px solid var(--border-subtle)',
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    <FiKey size={11} /> Save key without validation
                  </button>
                  <button
                    onClick={validateAndSaveKey}
                    disabled={apiKeyStatus === 'validating'}
                    style={{
                      padding: '6px 12px', background: 'rgba(0, 240, 255, 0.1)', color: 'var(--accent-primary)',
                      borderRadius: 'var(--radius-sm)', fontSize: 12, border: '1px solid rgba(0, 240, 255, 0.3)',
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    <FiRefreshCw size={11} /> Retry
                  </button>
                </div>
              )}
            </div>
          )}

          {apiKeyStatus === 'valid' && (
            <div style={{
              marginTop: 10, padding: '10px 14px', background: 'rgba(0, 255, 136, 0.08)',
              border: '1px solid rgba(0, 255, 136, 0.3)', borderRadius: 'var(--radius-md)',
              fontSize: 12, color: 'var(--accent-green)',
            }}>
              ✓ API key validated and saved securely. {models.length} models discovered ({freeModels.length} free).
            </div>
          )}
        </div>
      )}
    </div>
  );

  // ── RENDER: Model Selection ────────────────────────────────
  const renderModelSelection = () => (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>
        Select Model
      </h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
        {freeModels.length > 0
          ? `Found ${freeModels.length} free models. Recommended models are highlighted below.`
          : `${models.length} models available. Select one to use with BLAXIN.`
        }
      </p>

      {/* Free model recommendations */}
      {freeModels.length > 0 && (
        <div style={{
          padding: '12px 16px', background: 'rgba(0, 255, 136, 0.03)',
          border: '1px solid rgba(0, 255, 136, 0.15)', borderRadius: 'var(--radius-md)',
          marginBottom: 16,
        }}>
          <div style={{
            fontSize: 10, color: 'var(--accent-green)', textTransform: 'uppercase',
            letterSpacing: 1, fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <FiShield size={12} /> Free Models Detected
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              {
                label: '★ BEST FREE',
                model: freeModels.find(m => m.capabilities.includes('function-calling') && (m.contextWindow || 0) >= 8000) || freeModels[0],
                color: 'var(--accent-green)',
              },
              {
                label: '⚡ FASTEST',
                model: freeModels.find(m => m.id.includes('flash') || m.id.includes('mini') || m.id.includes('haiku')) || freeModels[0],
                color: 'var(--accent-primary)',
              },
              {
                label: '💡 LIGHTWEIGHT',
                model: freeModels.find(m => (m.contextWindow || 0) <= 8000 || m.id.includes('7b') || m.id.includes('8b')) || freeModels[freeModels.length - 1],
                color: 'var(--accent-secondary)',
              },
            ].filter(r => r.model).map((rec, i) => (
              <button
                key={i}
                onClick={() => rec.model && selectModel(rec.model)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  background: selectedModel?.id === rec.model?.id ? `${rec.color}15` : 'var(--bg-primary)',
                  border: `1px solid ${selectedModel?.id === rec.model?.id ? rec.color : 'var(--border-subtle)'}`,
                  borderRadius: 'var(--radius-sm)', textAlign: 'left', transition: 'all 0.15s',
                }}
              >
                <div style={{
                  padding: '2px 6px', borderRadius: 'var(--radius-sm)', fontSize: 8,
                  fontWeight: 700, letterSpacing: 0.5, color: rec.color, fontFamily: 'var(--font-mono)',
                  minWidth: 80,
                }}>{rec.label}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{rec.model!.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{rec.model!.id}</div>
                </div>
                {rec.model!.contextWindow && (
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {(rec.model!.contextWindow / 1000).toFixed(0)}K ctx
                  </div>
                )}
                {selectedModel?.id === rec.model?.id && <FiCheck size={12} color={rec.color} />}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* All models list */}
      <div style={{ maxHeight: 200, overflow: 'auto' }}>
        {(freeModels.length > 0 ? freeModels : models.slice(0, 30)).map(model => (
          <button
            key={model.id}
            onClick={() => selectModel(model)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '8px 12px', background: selectedModel?.id === model.id ? 'var(--bg-active)' : 'transparent',
              borderLeft: selectedModel?.id === model.id ? '2px solid var(--accent-primary)' : '2px solid transparent',
              fontSize: 12, color: 'var(--text-primary)', textAlign: 'left',
            }}
          >
            {selectedModel?.id === model.id && <FiCheck size={10} color="var(--accent-primary)" />}
            <div style={{ flex: 1 }}>
              <div>{model.name}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{model.id}</div>
            </div>
            {model.isFree && (
              <span style={{
                padding: '1px 5px', borderRadius: 3, fontSize: 8, fontWeight: 700,
                background: 'rgba(0, 255, 136, 0.1)', color: 'var(--accent-green)', fontFamily: 'var(--font-mono)',
              }}>FREE</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );

  // ── RENDER: Ready ─────────────────────────────────────────
  const renderReady = () => (
    <div style={{ textAlign: 'center', padding: '20px 0' }}>
      <div style={{
        width: 80, height: 80, borderRadius: '50%',
        background: 'rgba(0, 255, 136, 0.1)', border: '2px solid var(--accent-green)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 20px', boxShadow: '0 0 30px rgba(0, 255, 136, 0.2)',
      }}>
        <FiCheck size={36} color="var(--accent-green)" />
      </div>
      <h2 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
        BLAXIN is Ready
      </h2>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 360, margin: '0 auto', lineHeight: 1.7 }}>
        You're all set. BLAXIN is configured and ready to help you control your computer.
      </div>
      {selectedModel && (
        <div style={{
          marginTop: 16, padding: '8px 16px', background: 'var(--bg-tertiary)',
          border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
          display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12,
        }}>
          <FiCpu size={12} color="var(--accent-primary)" />
          <span style={{ color: 'var(--text-secondary)' }}>Active:</span>
          <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{selectedModel.name}</span>
        </div>
      )}
    </div>
  );

  // ── STEP CONTENT ──────────────────────────────────────────
  const renderStep = () => {
    switch (step.id) {
      case 'welcome': return renderWelcome();
      case 'compatibility': return renderCompatibility();
      case 'permissions': return renderPermissions();
      case 'provider': return renderProviderSelection();
      case 'apikey': return renderApiKey();
      case 'models': return renderModelSelection();
      case 'ready': return renderReady();
      default: return null;
    }
  };

  const canProceed = () => {
    switch (step.id) {
      case 'welcome': return true;
      case 'compatibility': return !loading && diagnostics.length > 0;
      case 'permissions': return true;
      case 'provider': return selectedProvider !== null;
      case 'apikey': return selectedProvider === 'ollama' || apiKeyStatus === 'valid';
      case 'models': return selectedModel !== null;
      case 'ready': return false;
      default: return true;
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.85)',
      backdropFilter: 'blur(12px)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', zIndex: 200,
    }}>
      <div style={{
        width: 680, maxWidth: '90vw', maxHeight: '85vh',
        background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-xl)', display: 'flex', flexDirection: 'column',
        overflow: 'hidden', boxShadow: '0 0 80px rgba(0, 240, 255, 0.1)',
      }}>
        {/* Progress bar */}
        <div style={{ height: 3, background: 'var(--bg-primary)' }}>
          <div style={{
            height: '100%', width: `${((currentStep + 1) / STEPS.length) * 100}%`,
            background: 'linear-gradient(90deg, var(--accent-primary), var(--accent-secondary))',
            transition: 'width 0.3s ease',
          }} />
        </div>

        {/* Step indicators */}
        <div style={{
          display: 'flex', padding: '16px 24px 0', gap: 0, borderBottom: '1px solid var(--border-subtle)',
        }}>
          {STEPS.map((s, i) => (
            <div key={s.id} style={{
              flex: 1, textAlign: 'center', paddingBottom: 12,
              borderBottom: i === currentStep ? '2px solid var(--accent-primary)' : '2px solid transparent',
              opacity: i <= currentStep ? 1 : 0.4,
              transition: 'all 0.2s',
            }}>
              <div style={{
                fontSize: 10, color: i === currentStep ? 'var(--accent-primary)' : 'var(--text-muted)',
                fontFamily: 'var(--font-mono)', letterSpacing: 0.5, textTransform: 'uppercase',
              }}>{s.title}</div>
            </div>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          {renderStep()}
        </div>

        {/* Navigation */}
        <div style={{
          padding: '16px 24px', borderTop: '1px solid var(--border-subtle)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            {currentStep > 0 && (
              <button onClick={prevStep} style={{
                padding: '8px 16px', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
                borderRadius: 'var(--radius-md)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
                border: '1px solid var(--border-subtle)',
              }}>
                <FiArrowLeft size={12} /> Back
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', alignSelf: 'center' }}>
              Step {currentStep + 1} / {STEPS.length}
            </div>

            {step.id === 'ready' ? (
              <button onClick={onComplete} style={{
                padding: '8px 20px',
                background: 'linear-gradient(135deg, var(--accent-green), #00cc66)',
                color: '#fff', borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: 6,
                boxShadow: '0 0 20px rgba(0, 255, 136, 0.3)',
              }}>
                Start Using BLAXIN <FiArrowRight size={12} />
              </button>
            ) : (
              <button onClick={nextStep} disabled={!canProceed()} style={{
                padding: '8px 20px',
                background: canProceed()
                  ? 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))'
                  : 'var(--bg-tertiary)',
                color: canProceed() ? '#fff' : 'var(--text-muted)',
                borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 500,
                display: 'flex', alignItems: 'center', gap: 6,
                opacity: canProceed() ? 1 : 0.5,
              }}>
                Continue <FiArrowRight size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
