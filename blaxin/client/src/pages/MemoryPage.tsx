import React, { useEffect, useMemo, useState } from 'react';
import { api, MemoryEntry, MemoryType } from '../services/api';
import {
  FiDatabase, FiSearch, FiTrash2, FiX, FiPlus, FiAlertTriangle,
  FiCheckCircle, FiInfo,
} from 'react-icons/fi';

const TYPE_COLORS: Record<MemoryType, string> = {
  preference: 'var(--accent-secondary)',
  fact: 'var(--accent-primary)',
  project: 'var(--accent-green)',
  'action-result': 'var(--accent-yellow)',
};

const TYPE_LABEL: Record<MemoryType, string> = {
  preference: 'PREFERENCE',
  fact: 'FACT',
  project: 'PROJECT',
  'action-result': 'LESSON',
};

function fmtDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function MemoryPage() {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Add-note form
  const [addType, setAddType] = useState<MemoryType>('preference');
  const [addContent, setAddContent] = useState('');
  const [addScope, setAddScope] = useState('');
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    try {
      const list = await api.getMemory();
      setEntries(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const visible = useMemo(() => {
    if (!entries) return [];
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      e.content.toLowerCase().includes(q) ||
      (e.scope || '').toLowerCase().includes(q) ||
      e.type.toLowerCase().includes(q),
    );
  }, [entries, query]);

  const counts = useMemo(() => {
    if (!entries) return { total: 0, durables: 0, lessons: 0 };
    const durables = entries.filter((e) => e.type !== 'action-result').length;
    return { total: entries.length, durables, lessons: entries.length - durables };
  }, [entries]);

  const removeEntry = async (id: string) => {
    try {
      await api.deleteMemory(id);
      setEntries((prev) => (prev ? prev.filter((e) => e.id !== id) : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const clearAll = async () => {
    if (!window.confirm('Delete ALL remembered notes? This cannot be undone.')) return;
    try {
      await api.clearMemory();
      setEntries([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const addNote = async () => {
    const content = addContent.trim();
    if (!content) {
      setFormMsg({ ok: false, text: 'Write what you want BLAXIN to remember first.' });
      return;
    }
    try {
      const res = await api.addMemory({ type: addType, content, scope: addScope.trim() || undefined });
      if (!res.success || !res.entry) {
        setFormMsg({ ok: false, text: 'The note was not stored.' });
        return;
      }
      setAddContent('');
      setAddScope('');
      setFormMsg({ ok: true, text: 'Saved.' });
      setEntries((prev) => (prev ? [...prev, res.entry!] : prev));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFormMsg({ ok: false, text: msg });
      // Secret-like content is refused server-side; refresh to stay honest.
      if (/secret|not stored/i.test(msg)) load();
    }
  };

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{
          fontSize: 16, fontWeight: 700, color: 'var(--text-primary)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <FiDatabase size={18} color="var(--accent-primary)" />
          MEMORY
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
          DURABLE NOTES · READ BACK INTO EVERY TASK AS BACKGROUND DATA · SECRETS NEVER STORED
        </div>
      </div>

      {error && (
        <div style={{
          marginBottom: 12, padding: '8px 12px', fontSize: 11,
          background: 'rgba(255, 51, 85, 0.08)', border: '1px solid rgba(255, 51, 85, 0.3)',
          borderRadius: 'var(--radius-sm)', color: 'var(--accent-red)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <FiAlertTriangle size={12} /> {error}
        </div>
      )}

      {/* Add note */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)', padding: 16, marginBottom: 16,
      }}>
        <div style={{
          fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1,
          color: 'var(--text-secondary)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <FiPlus size={13} color="var(--accent-primary)" /> Remember something durable
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {(['preference', 'fact', 'project'] as MemoryType[]).map((t) => (
            <button
              key={t}
              onClick={() => setAddType(t)}
              style={{
                padding: '4px 10px', borderRadius: 'var(--radius-sm)', fontSize: 10,
                fontFamily: 'var(--font-mono)', letterSpacing: 0.5, cursor: 'pointer',
                background: addType === t ? TYPE_COLORS[t] : 'var(--bg-tertiary)',
                color: addType === t ? '#0b0b12' : 'var(--text-secondary)',
                border: '1px solid transparent',
              }}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        <textarea
          data-testid="memory-note-input"
          value={addContent}
          onChange={(e) => setAddContent(e.target.value)}
          placeholder={addType === 'preference'
            ? 'e.g. Prefer concise answers with code examples'
            : addType === 'project'
              ? 'e.g. The app lives at ~/projects/blaxin and runs with pnpm dev'
              : 'e.g. The local Ollama server binds to 127.0.0.1:11434'}
          rows={2}
          style={{
            width: '100%', resize: 'vertical', padding: '8px 10px', fontSize: 12,
            background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
            fontFamily: 'var(--font-mono)', boxSizing: 'border-box', marginBottom: 8,
          }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={addScope}
            onChange={(e) => setAddScope(e.target.value)}
            placeholder="scope (optional) — e.g. chat, project"
            style={{
              flex: 1, minWidth: 180, padding: '6px 10px', fontSize: 11,
              background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
              border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
              fontFamily: 'var(--font-mono)',
            }}
          />
          <button
            onClick={addNote}
            style={{
              padding: '6px 14px', borderRadius: 'var(--radius-md)', fontSize: 11,
              fontWeight: 600, cursor: 'pointer',
              background: 'var(--accent-primary)', color: '#0b0b12', border: 'none',
            }}
          >
            Save note
          </button>
        </div>
        {formMsg && (
          <div style={{
            marginTop: 8, fontSize: 11, display: 'flex', alignItems: 'center', gap: 6,
            color: formMsg.ok ? 'var(--accent-green)' : 'var(--accent-red)',
          }}>
            {formMsg.ok ? <FiCheckCircle size={12} /> : <FiAlertTriangle size={12} />}
            {formMsg.text}
          </div>
        )}
      </div>

      {/* List */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)', overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <span style={{ color: 'var(--accent-primary)' }}><FiDatabase size={14} /></span>
          <span style={{
            fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1,
            color: 'var(--text-secondary)',
          }}>
            {entries === null ? 'Notes' : `Notes · ${counts.total} total (${counts.durables} durable / ${counts.lessons} lessons)`}
          </span>
          <div style={{ flex: 1 }} />
          <div style={{ position: 'relative' }}>
            <FiSearch size={12} style={{
              position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--text-muted)',
            }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter notes…"
              aria-label="Filter memory notes"
              style={{
                padding: '5px 8px 5px 24px', fontSize: 11, width: 160,
                background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
                fontFamily: 'var(--font-mono)',
              }}
            />
          </div>
          {entries && entries.length > 0 && (
            <button
              onClick={clearAll}
              style={{
                padding: '5px 10px', borderRadius: 'var(--radius-md)', fontSize: 10,
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
                background: 'rgba(255, 51, 85, 0.08)', color: 'var(--accent-red)',
                border: '1px solid rgba(255, 51, 85, 0.3)',
              }}
            >
              <FiX size={11} /> Clear all
            </button>
          )}
        </div>

        <div style={{ padding: '8px 16px' }}>
          {error && <div style={{ fontSize: 12, color: 'var(--accent-red)' }}>{error}</div>}
          {entries === null && !error && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>Loading…</div>
          )}
          {entries !== null && entries.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>
              No notes yet. Durable preferences, facts and project context you save here are read back
              into every agent task as background data; failure lessons are added automatically.
            </div>
          )}
          {visible.length === 0 && entries !== null && entries.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>
              Nothing matches “{query}”.
            </div>
          )}
          {visible.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
              {visible.map((e) => (
                <div key={e.id} data-testid="memory-entry" style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)',
                }}>
                  <span style={{
                    padding: '2px 6px', borderRadius: 'var(--radius-sm)', fontSize: 9,
                    fontFamily: 'var(--font-mono)', letterSpacing: 0.5, marginTop: 2, flexShrink: 0,
                    background: TYPE_COLORS[e.type], color: '#0b0b12', fontWeight: 700,
                  }}>
                    {TYPE_LABEL[e.type]}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {e.content}
                    </div>
                    <div style={{
                      marginTop: 3, fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
                    }}>
                      {e.source.toUpperCase()}
                      {e.scope ? ` · ${e.scope}` : ''}
                      {' · saved '}{fmtDate(e.createdAt)}
                      {e.lastUsedAt !== e.createdAt ? ` · used ${fmtDate(e.lastUsedAt)}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => removeEntry(e.id)}
                    title="Delete this note"
                    aria-label="Delete this note"
                    style={{
                      padding: 4, cursor: 'pointer', background: 'transparent', border: 'none',
                      color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)', flexShrink: 0,
                      display: 'flex',
                    }}
                  >
                    <FiTrash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{
        marginTop: 12, padding: '8px 12px', borderRadius: 'var(--radius-md)', fontSize: 10,
        color: 'var(--text-muted)', background: 'var(--bg-secondary)',
        border: '1px solid var(--border-subtle)', display: 'flex', gap: 8, alignItems: 'flex-start',
      }}>
        <FiInfo size={12} style={{ marginTop: 1, flexShrink: 0, color: 'var(--accent-primary)' }} />
        <span>
          Notes are injected into the system prompt of each task framed as BACKGROUND DATA — your current
          instruction always outranks them. Content that looks like an API key, token or private key is
          refused and never stored. Memory lives on this device under the BLAXIN data directory.
        </span>
      </div>
    </div>
  );
}
