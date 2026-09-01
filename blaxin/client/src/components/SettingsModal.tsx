import React, { useState, useEffect } from 'react';
import { useAppStore, ProviderStatus, ModelInfo } from '../utils/store';
import { api } from '../services/api';
import { 
  FiX, FiKey, FiCpu, FiTool, FiShield, FiMonitor, 
  FiCheck, FiAlertTriangle, FiLoader, FiRefreshCw,
  FiSearch, FiStar, FiZap, FiMic, FiVolume2,
  FiServer, FiGlobe, FiTerminal, FiFile, FiWifi, FiWifiOff
} from 'react-icons/fi';

type SettingsTab = 'providers' | 'models' | 'agent' | 'tools' | 'voice' | 'appearance' | 'diagnostics';

const providerInfo: Record<string, { name: string; description: string; url: string }> = {
  openrouter: { name: 'OpenRouter', description: 'Access 200+ AI models through one API. Free models available.', url: 'https://openrouter.ai' },
  openai: { name: 'OpenAI', description: 'GPT-4o, GPT-4, and other OpenAI models.', url: 'https://platform.openai.com' },
  anthropic: { name: 'Anthropic', description: 'Claude models with advanced reasoning.', url: 'https://console.anthropic.com' },
  google: { name: 'Google AI', description: 'Gemini models with multimodal capabilities.', url: 'https://aistudio.google.com' },
  groq: { name: 'Groq', description: 'Ultra-fast inference for open-source models.', url: 'https://console.groq.com' },
  together: { name: 'Together AI', description: 'Open-source model hosting and inference.', url: 'https://api.together.xyz' },
  ollama: { name: 'Ollama (Local)', description: 'Run AI models locally on your machine.', url: 'https://ollama.ai' },
};

export function SettingsModal() {
  const { setSettingsOpen, providers, setProviders, models, setModels, activeProvider, setActiveProvider, activeModel, setActiveModel } = useAppStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>('providers');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    try {
      const p = await api.getProviders();
      setProviders(p);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'providers', label: 'AI Providers', icon: <FiKey size={14} /> },
    { id: 'models', label: 'Models', icon: <FiCpu size={14} /> },
    { id: 'tools', label: 'Tools', icon: <FiTool size={14} /> },
    { id: 'voice', label: 'Voice', icon: <FiMic size={14} /> },
    { id: 'diagnostics', label: 'Diagnostics', icon: <FiMonitor size={14} /> },
  ];

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0, 0, 0, 0.7)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 100,
    }}>
      <div style={{
        width: 900,
        maxWidth: '90vw',
        height: '80vh',
        maxHeight: '80vh',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-xl)',
        display: 'flex',
        overflow: 'hidden',
        boxShadow: '0 0 60px rgba(0, 240, 255, 0.1)',
      }}>
        {/* Sidebar tabs */}
        <div style={{
          width: 200,
          background: 'var(--bg-tertiary)',
          borderRight: '1px solid var(--border-subtle)',
          padding: '16px 0',
        }}>
          <div style={{
            padding: '0 16px 16px',
            borderBottom: '1px solid var(--border-subtle)',
            marginBottom: 8,
          }}>
            <div style={{
              fontSize: 16,
              fontWeight: 700,
              fontFamily: 'var(--font-mono)',
              letterSpacing: 1,
              color: 'var(--accent-primary)',
            }}>
              Settings
            </div>
          </div>

          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 16px',
                background: activeTab === tab.id ? 'var(--bg-active)' : 'transparent',
                color: activeTab === tab.id ? 'var(--accent-primary)' : 'var(--text-secondary)',
                borderLeft: activeTab === tab.id ? '2px solid var(--accent-primary)' : '2px solid transparent',
                fontSize: 13,
              }}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}

          <div style={{ flex: 1 }} />

          <button
            onClick={() => setSettingsOpen(false)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '10px 16px',
              color: 'var(--text-muted)',
              fontSize: 13,
            }}
          >
            <FiX size={14} />
            Close
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          {error && (
            <div style={{
              padding: '10px 14px',
              background: 'rgba(255, 51, 85, 0.1)',
              border: '1px solid rgba(255, 51, 85, 0.3)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--accent-red)',
              fontSize: 13,
              marginBottom: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <FiAlertTriangle size={14} />
              {error}
              <button onClick={() => setError(null)} style={{ marginLeft: 'auto', color: 'inherit', background: 'none' }}>
                <FiX size={14} />
              </button>
            </div>
          )}

          {success && (
            <div style={{
              padding: '10px 14px',
              background: 'rgba(0, 255, 136, 0.1)',
              border: '1px solid rgba(0, 255, 136, 0.3)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--accent-green)',
              fontSize: 13,
              marginBottom: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <FiCheck size={14} />
              {success}
            </div>
          )}

          {activeTab === 'providers' && (
            <ProvidersTab
              providers={providers}
              onProvidersUpdate={loadProviders}
              setError={setError}
              setSuccess={setSuccess}
              setLoading={setLoading}
              loading={loading}
            />
          )}

          {activeTab === 'models' && (
            <ModelsTab
              models={models}
              setModels={setModels}
              activeProvider={activeProvider}
              activeModel={activeModel}
              setActiveModel={setActiveModel}
              setError={setError}
              setSuccess={setSuccess}
            />
          )}

          {activeTab === 'tools' && <ToolsTab />}
          {activeTab === 'voice' && <VoiceTab />}
          {activeTab === 'diagnostics' && <DiagnosticsTab />}
        </div>
      </div>
    </div>
  );
}

// === PROVIDERS TAB ===
function ProvidersTab({ 
  providers, onProvidersUpdate, setError, setSuccess, setLoading, loading 
}: {
  providers: ProviderStatus[];
  onProvidersUpdate: () => void;
  setError: (e: string | null) => void;
  setSuccess: (s: string | null) => void;
  setLoading: (l: boolean) => void;
  loading: boolean;
}) {
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');

  const handleSaveKey = async (providerId: string) => {
    if (!apiKey.trim()) {
      setError('API key is required');
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await api.saveKey(providerId, apiKey);
      if (result.valid) {
        setSuccess(`API key saved and validated for ${providerInfo[providerId]?.name || providerId}`);
        setEditingProvider(null);
        setApiKey('');
        onProvidersUpdate();
      } else {
        setError(result.error || 'API key validation failed');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveKey = async (providerId: string) => {
    try {
      await api.removeKey(providerId);
      setSuccess(`API key removed for ${providerInfo[providerId]?.name || providerId}`);
      onProvidersUpdate();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>
        AI Providers
      </h2>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
        Configure API keys for AI providers. Your keys are encrypted and stored locally.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {Object.entries(providerInfo).map(([id, info]) => {
          const status = providers.find(p => p.id === id);
          const isEditing = editingProvider === id;

          return (
            <div
              key={id}
              style={{
                padding: '16px',
                background: 'var(--bg-primary)',
                border: `1px solid ${status?.hasKey ? 'rgba(0, 255, 136, 0.2)' : 'var(--border-subtle)'}`,
                borderRadius: 'var(--radius-md)',
                transition: 'border-color 0.2s',
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}>
                <div style={{
                  width: 36,
                  height: 36,
                  borderRadius: 'var(--radius-md)',
                  background: status?.hasKey 
                    ? 'rgba(0, 255, 136, 0.1)' 
                    : 'var(--bg-tertiary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: status?.hasKey ? 'var(--accent-green)' : 'var(--text-muted)',
                }}>
                  <FiKey size={16} />
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {info.name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {info.description}
                  </div>
                </div>

                <div style={{
                  padding: '3px 8px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  background: status?.hasKey ? 'rgba(0, 255, 136, 0.1)' : 'rgba(255, 255, 255, 0.05)',
                  color: status?.hasKey ? 'var(--accent-green)' : 'var(--text-muted)',
                }}>
                  {status?.hasKey ? `Connected • ${status.maskedKey}` : 'Not configured'}
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => {
                      setEditingProvider(isEditing ? null : id);
                      setApiKey('');
                      setError(null);
                    }}
                    style={{
                      padding: '6px 12px',
                      background: isEditing ? 'rgba(255, 51, 85, 0.1)' : 'var(--bg-tertiary)',
                      color: isEditing ? 'var(--accent-red)' : 'var(--text-secondary)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 12,
                      border: `1px solid ${isEditing ? 'rgba(255, 51, 85, 0.3)' : 'var(--border-subtle)'}`,
                    }}
                  >
                    {isEditing ? 'Cancel' : status?.hasKey ? 'Update' : 'Configure'}
                  </button>
                  {status?.hasKey && (
                    <button
                      onClick={() => handleRemoveKey(id)}
                      style={{
                        padding: '6px 12px',
                        background: 'rgba(255, 51, 85, 0.1)',
                        color: 'var(--accent-red)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 12,
                        border: '1px solid rgba(255, 51, 85, 0.3)',
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {isEditing && (
                <div style={{
                  marginTop: 12,
                  padding: '12px',
                  background: 'var(--bg-secondary)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-primary)',
                }}>
                  <label style={{
                    display: 'block',
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    marginBottom: 6,
                  }}>
                    {id === 'ollama' ? 'Base URL (optional)' : 'API Key'}
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type={id === 'ollama' ? 'text' : 'password'}
                      value={apiKey}
                      onChange={e => setApiKey(e.target.value)}
                      placeholder={id === 'ollama' ? 'http://localhost:11434' : `Enter ${info.name} API key`}
                      style={{ flex: 1 }}
                      onKeyDown={e => e.key === 'Enter' && handleSaveKey(id)}
                    />
                    <button
                      onClick={() => handleSaveKey(id)}
                      disabled={loading}
                      style={{
                        padding: '8px 16px',
                        background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                        color: '#fff',
                        borderRadius: 'var(--radius-md)',
                        fontSize: 13,
                        fontWeight: 500,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        opacity: loading ? 0.5 : 1,
                      }}
                    >
                      {loading ? <FiLoader size={12} className="spin" /> : <FiCheck size={12} />}
                      {id === 'ollama' ? 'Connect' : 'Validate & Save'}
                    </button>
                  </div>
                  {id !== 'ollama' && (
                    <div style={{
                      marginTop: 8,
                      fontSize: 11,
                      color: 'var(--text-muted)',
                    }}>
                      Get your API key at{' '}
                      <a href={info.url} target="_blank" rel="noopener" style={{ color: 'var(--accent-primary)' }}>
                        {info.url}
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// === MODELS TAB ===
interface Recommendation {
  label: string;
  reason: string;
  model: ModelInfo | undefined;
  color: string;
}

function ModelsTab({ 
  models, setModels, activeProvider, activeModel, setActiveModel, setError, setSuccess 
}: {
  models: ModelInfo[];
  setModels: (m: ModelInfo[]) => void;
  activeProvider: string | null;
  activeModel: string | null;
  setActiveModel: (m: string | null) => void;
  setError: (e: string | null) => void;
  setSuccess: (s: string | null) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'free' | 'paid'>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null);

  const refreshModels = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const allModels = await api.getAllModels();
      setModels(allModels);
      setSuccess(`Loaded ${allModels.length} models (${allModels.filter(m => m.isFree).length} free)`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRefreshing(false);
    }
  };

  const selectModel = async (model: ModelInfo) => {
    try {
      await api.setActiveModel(model.provider, model.id);
      setActiveModel(model.id);
      useAppStore.getState().setActiveProvider(model.provider);
      setSuccess(`Selected ${model.name} (${model.provider})`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const filteredModels = models.filter(m => {
    const matchesSearch = m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.id.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === 'all' || (filter === 'free' ? m.isFree : !m.isFree);
    return matchesSearch && matchesFilter;
  });

  const freeModels = models.filter(m => m.isFree);
  const paidModels = models.filter(m => !m.isFree);

  // Smart recommendations based on model capabilities and known models
  const recommendations: Recommendation[] = [
    {
      label: '★ BEST FREE',
      reason: 'Top free model with best overall capability',
      model: freeModels.find(m => 
        m.capabilities.includes('function-calling') && 
        (m.contextWindow || 0) >= 8000
      ) || freeModels[0],
      color: 'var(--accent-green)',
    },
    {
      label: '⚡ BEST FOR CODING',
      reason: 'Optimized for code generation and debugging',
      model: freeModels.find(m => 
        m.id.includes('code') || m.id.includes('coder') || 
        m.id.includes('deepseek') || m.capabilities.includes('code-generation')
      ) || freeModels.find(m => m.capabilities.includes('function-calling')),
      color: 'var(--accent-primary)',
    },
    {
      label: '🤖 BEST FOR AGENT',
      reason: 'Best at tool calling and multi-step tasks',
      model: freeModels.find(m => 
        m.capabilities.includes('function-calling') && 
        m.capabilities.includes('reasoning')
      ) || freeModels.find(m => m.capabilities.includes('function-calling')),
      color: 'var(--accent-secondary)',
    },
    {
      label: '🚀 FASTEST FREE',
      reason: 'Lowest latency for quick responses',
      model: freeModels.find(m => 
        m.id.includes('flash') || m.id.includes('mini') || 
        m.id.includes('haiku') || m.id.includes('groq')
      ) || freeModels[0],
      color: 'var(--accent-yellow)',
    },
    {
      label: '💡 LIGHTWEIGHT',
      reason: 'Smallest model, fastest response, good for simple tasks',
      model: freeModels.find(m => 
        (m.contextWindow || 0) <= 8000 || 
        m.id.includes('7b') || m.id.includes('8b') || m.id.includes('small')
      ) || freeModels[freeModels.length - 1],
      color: 'var(--accent-red)',
    },
  ].filter(r => r.model !== undefined);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Models</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {models.length} models ({freeModels.length} free). Active: {activeModel || 'none'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Filter pills */}
          {(['all', 'free', 'paid'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: '4px 10px',
                borderRadius: 'var(--radius-sm)',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                background: filter === f ? 'var(--accent-primary)' : 'transparent',
                color: filter === f ? '#fff' : 'var(--text-muted)',
                border: `1px solid ${filter === f ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
              }}
            >
              {f === 'all' ? `All (${models.length})` : f === 'free' ? `Free (${freeModels.length})` : `Paid (${paidModels.length})`}
            </button>
          ))}
          <button
            onClick={refreshModels}
            disabled={refreshing}
            style={{
              padding: '6px 12px',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              borderRadius: 'var(--radius-md)',
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              border: '1px solid var(--border-subtle)',
            }}
          >
            <FiRefreshCw size={12} className={refreshing ? 'spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 16 }}>
        <FiSearch size={14} style={{
          position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
          color: 'var(--text-muted)',
        }} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search models by name or ID..."
          style={{ width: '100%', paddingLeft: 36 }}
        />
      </div>

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div style={{
          padding: '12px 16px',
          background: 'rgba(0, 255, 136, 0.03)',
          border: '1px solid rgba(0, 255, 136, 0.15)',
          borderRadius: 'var(--radius-md)',
          marginBottom: 16,
        }}>
          <div style={{
            fontSize: 11, color: 'var(--accent-green)', textTransform: 'uppercase',
            letterSpacing: 1, fontWeight: 600, marginBottom: 10,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <FiStar size={12} /> Recommended for BLAXIN
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {recommendations.map((rec, i) => (
              <RecommendationChip
                key={i}
                label={rec.label}
                reason={rec.reason}
                model={rec.model!}
                isActive={activeModel === rec.model?.id}
                onClick={() => selectModel(rec.model!)}
                color={rec.color}
              />
            ))}
          </div>
        </div>
      )}

      {freeModels.length === 0 && !search && (
        <div style={{
          padding: '16px',
          background: 'rgba(255, 170, 0, 0.05)',
          border: '1px solid rgba(255, 170, 0, 0.2)',
          borderRadius: 'var(--radius-md)',
          marginBottom: 16,
          fontSize: 13, color: 'var(--accent-yellow)',
        }}>
          ⚠️ No free models found. Configure an API key in Settings → AI Providers to discover available models.
        </div>
      )}

      {/* Model list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {filteredModels.map(model => (
          <ModelRow
            key={model.id}
            model={model}
            isActive={activeModel === model.id}
            isRecommended={recommendations.some(r => r.model?.id === model.id)}
            onSelect={() => selectModel(model)}
            onInfo={() => setSelectedModel(model)}
          />
        ))}
      </div>

      {filteredModels.length === 0 && (
        <div style={{
          padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13,
        }}>
          No models match your search.
        </div>
      )}

      {/* Model detail modal */}
      {selectedModel && (
        <ModelDetailModal model={selectedModel} onClose={() => setSelectedModel(null)} onSelect={selectModel} isActive={activeModel === selectedModel.id} />
      )}
    </div>
  );
}

function RecommendationChip({ label, reason, model, isActive, onClick, color }: {
  label: string; reason: string; model: ModelInfo; isActive: boolean; onClick: () => void; color: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '10px 14px',
        background: isActive ? `${color}20` : `${color}08`,
        border: `1px solid ${isActive ? color : `${color}30`}`,
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer', textAlign: 'left',
        minWidth: 160,
      }}
    >
      <div style={{ fontSize: 9, color, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 500, marginBottom: 2 }}>
        {model.name}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
        {reason}
      </div>
      {model.contextWindow && (
        <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
          {(model.contextWindow / 1000).toFixed(0)}K ctx
        </div>
      )}
    </button>
  );
}

function ModelRow({ model, isActive, isRecommended, onSelect, onInfo }: {
  model: ModelInfo; isActive: boolean; isRecommended: boolean; onSelect: () => void; onInfo: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 12px',
        background: isActive ? 'var(--bg-active)' : 'var(--bg-primary)',
        border: `1px solid ${isActive ? 'var(--accent-primary)' : isRecommended ? 'rgba(0, 255, 136, 0.15)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--radius-sm)',
        transition: 'all 0.15s',
      }}
    >
      <button onClick={onSelect} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        {isActive && <FiCheck size={12} color="var(--accent-primary)" />}
        {isRecommended && !isActive && <FiStar size={10} color="var(--accent-green)" />}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{model.name}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {model.provider} • {model.id}
          </div>
        </div>
      </button>

      {/* Capability badges */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {model.capabilities.includes('function-calling') && (
          <span style={{ padding: '1px 5px', borderRadius: 3, fontSize: 8, background: 'rgba(0, 240, 255, 0.1)', color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)' }}>
            TOOLS
          </span>
        )}
        {model.capabilities.includes('vision') && (
          <span style={{ padding: '1px 5px', borderRadius: 3, fontSize: 8, background: 'rgba(123, 45, 255, 0.1)', color: 'var(--accent-secondary)', fontFamily: 'var(--font-mono)' }}>
            VISION
          </span>
        )}
        {model.capabilities.includes('code-generation') && (
            <span style={{ padding: '1px 5px', borderRadius: 3, fontSize: 8, background: 'rgba(0, 255, 136, 0.1)', color: 'var(--accent-green)', fontFamily: 'var(--font-mono)' }}>
              CODE
            </span>
        )}
      </div>

      {/* Context window */}
      {model.contextWindow && (
        <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', minWidth: 50, textAlign: 'right' }}>
          {(model.contextWindow / 1000).toFixed(0)}K
        </div>
      )}

      {/* Price badge */}
      <div style={{
        padding: '2px 6px', borderRadius: 'var(--radius-sm)', fontSize: 9,
        fontFamily: 'var(--font-mono)', fontWeight: 600,
        background: model.isFree ? 'rgba(0, 255, 136, 0.1)' : 'rgba(255, 170, 0, 0.1)',
        color: model.isFree ? 'var(--accent-green)' : 'var(--accent-yellow)',
      }}>
        {model.isFree ? 'FREE' : model.pricing ? `$${(model.pricing.prompt * 1000000).toFixed(2)}/M` : 'PAID'}
      </div>

      {/* Info button */}
      <button
        onClick={onInfo}
        style={{
          width: 24, height: 24, borderRadius: 'var(--radius-sm)',
          background: 'transparent', color: 'var(--text-muted)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, cursor: 'pointer', border: 'none',
        }}
        title="Model details"
      >
        ℹ
      </button>
    </div>
  );
}

function ModelDetailModal({ model, onClose, onSelect, isActive }: {
  model: ModelInfo; onClose: () => void; onSelect: (m: ModelInfo) => void; isActive: boolean;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
    }} onClick={onClose}>
      <div style={{
        width: 500, maxWidth: '90vw', background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-xl)',
        padding: 24, boxShadow: '0 0 40px rgba(0,240,255,0.1)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{model.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{model.id}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><FiX size={18} /></button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          <InfoItem label="Provider" value={model.provider} />
          <InfoItem label="Status" value={model.isFree ? 'Free' : 'Paid'} color={model.isFree ? 'var(--accent-green)' : 'var(--accent-yellow)'} />
          {model.contextWindow && <InfoItem label="Context Window" value={`${(model.contextWindow / 1000).toFixed(0)}K tokens`} />}
          {model.maxOutput && <InfoItem label="Max Output" value={`${(model.maxOutput / 1000).toFixed(0)}K tokens`} />}
          {model.pricing && <InfoItem label="Input Cost" value={`$${(model.pricing.prompt * 1000000).toFixed(2)}/1M tokens`} />}
          {model.pricing && <InfoItem label="Output Cost" value={`$${(model.pricing.completion * 1000000).toFixed(2)}/1M tokens`} />}
        </div>

        {model.capabilities.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Capabilities</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {model.capabilities.map(c => (
                <span key={c} style={{
                  padding: '3px 8px', borderRadius: 'var(--radius-sm)', fontSize: 11,
                  background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
                  border: '1px solid var(--border-subtle)',
                }}>{c}</span>
              ))}
            </div>
          </div>
        )}

        {model.description && (
          <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            {model.description}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{
            padding: '8px 16px', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
            borderRadius: 'var(--radius-md)', fontSize: 13, border: '1px solid var(--border-subtle)',
          }}>Close</button>
          {!isActive && (
            <button onClick={() => { onSelect(model); onClose(); }} style={{
              padding: '8px 16px', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
              color: '#fff', borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 500,
            }}>Select Model</button>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoItem({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, color: color || 'var(--text-primary)', fontWeight: 500 }}>{value}</div>
    </div>
  );
}

// === TOOLS TAB ===
function ToolsTab() {
  const [toolStatus, setToolStatus] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.getToolStatus().then(setToolStatus).catch(() => {});
  }, []);

  const toggle = async (name: string) => {
    const enabled = !toolStatus[name];
    await api.toggleTool(name, enabled);
    setToolStatus(prev => ({ ...prev, [name]: enabled }));
  };

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Tools</h2>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
        Enable or disable agent tools.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Object.entries(toolStatus).map(([name, enabled]) => (
          <div
            key={name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 14px',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <div style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>
              {name}
            </div>
            <button
              onClick={() => toggle(name)}
              style={{
                width: 36,
                height: 20,
                borderRadius: 10,
                background: enabled ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                position: 'relative',
                transition: 'background 0.2s',
                border: `1px solid ${enabled ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
              }}
            >
              <div style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                background: '#fff',
                position: 'absolute',
                top: 2,
                left: enabled ? 18 : 2,
                transition: 'left 0.2s',
              }} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// === VOICE TAB ===
function VoiceTab() {
  const { voiceEnabled, setVoiceEnabled, ttsEnabled, setTtsEnabled } = useAppStore();
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    const supported = typeof window !== 'undefined' && 
      ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
    setVoiceSupported(supported);

    const loadVoices = () => {
      if (window.speechSynthesis) {
        setVoices(window.speechSynthesis.getVoices());
      }
    };
    loadVoices();
    window.speechSynthesis?.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', loadVoices);
  }, []);

  const toggleSwitch = (enabled: boolean, onToggle: (v: boolean) => void) => (
    <button
      onClick={() => onToggle(!enabled)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        background: enabled ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
        position: 'relative',
        transition: 'background 0.2s',
        border: `1px solid ${enabled ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
        flexShrink: 0,
      }}
    >
      <div style={{
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: '#fff',
        position: 'absolute',
        top: 2,
        left: enabled ? 20 : 2,
        transition: 'left 0.2s',
      }} />
    </button>
  );

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
        <FiMic size={18} /> Voice
      </h2>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
        Configure voice input and text-to-speech output.
      </p>

      {!voiceSupported && (
        <div style={{
          padding: '10px 14px',
          background: 'rgba(255, 170, 0, 0.1)',
          border: '1px solid rgba(255, 170, 0, 0.3)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--accent-yellow)',
          fontSize: 13,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <FiAlertTriangle size={14} />
          Speech recognition is not supported in this browser. Use Chrome or Edge for full voice support.
        </div>
      )}

      {/* Speech Recognition */}
      <div style={{
        padding: '16px',
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 2 }}>
              Speech Recognition (Input)
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Click the mic icon in chat to speak your message
            </div>
          </div>
          {toggleSwitch(voiceEnabled, setVoiceEnabled)}
        </div>
      </div>

      {/* Text-to-Speech */}
      <div style={{
        padding: '16px',
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
              <FiVolume2 size={14} color="var(--accent-primary)" />
              Text-to-Speech (Output)
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              BLAXIN will speak its responses aloud
            </div>
          </div>
          {toggleSwitch(ttsEnabled, setTtsEnabled)}
        </div>
      </div>

      {/* Voice list */}
      {voices.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: 1,
            marginBottom: 8,
          }}>
            Available Voices ({voices.length})
          </h3>
          <div style={{
            maxHeight: 200,
            overflow: 'auto',
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
          }}>
            {voices.filter(v => v.lang.startsWith('en')).map((voice, i) => (
              <div
                key={i}
                style={{
                  padding: '8px 12px',
                  borderBottom: '1px solid var(--border-subtle)',
                  fontSize: 12,
                  color: 'var(--text-primary)',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}>
                <span>{voice.name}</span>
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {voice.lang} {voice.localService ? '(local)' : '(remote)'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// === DIAGNOSTICS TAB ===
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

function DiagnosticsTab() {
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
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiMonitor size={18} /> Diagnostics
          </h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            System health and component status
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {lastRun && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
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
          padding: '12px 16px',
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
            <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: 1, fontSize: 13 }}>
              SYSTEM {overallConfig.label.toUpperCase()}
            </span>
          </div>
          <div style={{ flex: 1 }} />
          {result && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {result.groups.reduce((sum, g) => sum + g.checks.filter(c => c.status === 'error').length, 0)} errors,{' '}
              {result.groups.reduce((sum, g) => sum + g.checks.filter(c => c.status === 'warning').length, 0)} warnings
            </span>
          )}
        </div>
      )}

      {/* Loading state */}
      {loading && !result && (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          color: 'var(--accent-primary)',
        }}>
          <FiLoader size={24} className="spin" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 13 }}>Running diagnostics...</div>
        </div>
      )}

      {/* Diagnostic groups */}
      {result && result.groups.map((group, gi) => (
        <div
          key={gi}
          style={{
            marginBottom: 16,
            background: 'var(--bg-primary)',
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
            background: 'var(--bg-secondary)',
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
            {/* Group status dots */}
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
                  {/* Status icon */}
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

                  {/* Content */}
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

                  {/* Status label */}
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
