import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAppStore, ChatMessage } from '../utils/store';
import { useVoice } from '../hooks/useVoice';
import ReactMarkdown from 'react-markdown';
import { FiSend, FiSquare, FiMic, FiMicOff, FiVolume2, FiVolumeX } from 'react-icons/fi';

interface ChatPanelProps {
  sendMessage: (msg: string) => void;
  stopAgent: () => void;
  clearHistory: () => void;
}

export function ChatPanel({ sendMessage, stopAgent, clearHistory }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { messages, agentState, agentDescription, lastError, setLastError, ttsEnabled, setTtsEnabled, voiceEnabled, setVoiceEnabled } = useAppStore();

  // Convert errors to visible messages in chat
  useEffect(() => {
    if (lastError) {
      const errorId = `error_${Date.now()}`;
      // Only add if not already present
      const exists = useAppStore.getState().messages.some(m => m.id === errorId);
      if (!exists) {
        useAppStore.getState().addMessage({
          id: errorId,
          role: 'system',
          content: `⚠️ ${lastError}`,
          timestamp: Date.now(),
        });
      }
      setLastError(null);
    }
  }, [lastError]);

  const { startListening, stopListening, speak, stopSpeaking, isSupported, isListening, isSpeaking } = useVoice({
    onFinalTranscript: useCallback((transcript: string) => {
      setInput(prev => prev ? prev + ' ' + transcript : transcript);
    }, []),
  });

  // Auto-speak assistant messages when TTS is enabled
  useEffect(() => {
    if (ttsEnabled && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'assistant' && lastMsg.content) {
        // Strip markdown-like formatting for speech
        const cleanText = lastMsg.content
          .replace(/```[\s\S]*?```/g, 'code block omitted')
          .replace(/`[^`]+`/g, (match) => match.slice(1, -1))
          .replace(/[#*_~\[\]()]/g, '')
          .trim();
        if (cleanText.length > 0 && cleanText.length < 2000) {
          speak(cleanText);
        }
      }
    }
  }, [messages, ttsEnabled]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    if (agentState !== 'idle' && agentState !== 'completed' && agentState !== 'error') return;
    sendMessage(input.trim());
    setInput('');
    // Stop any ongoing speech/speech recognition when sending
    if (isListening) stopListening();
    stopSpeaking();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleVoice = () => {
    if (isListening) {
      stopListening();
    } else {
      // Using the mic implies consent: enable voice input if it was
      // switched off in Settings, then start listening.
      if (!voiceEnabled) setVoiceEnabled(true);
      startListening();
    }
  };

  const isActive = agentState !== 'idle' && agentState !== 'completed' && agentState !== 'error';

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-primary)',
      position: 'relative',
    }}>
      {/* Messages */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '16px 24px',
      }}>
        {messages.length === 0 && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            opacity: 0.5,
          }}>
            <div style={{
              fontSize: 48,
              fontFamily: 'var(--font-mono)',
              fontWeight: 800,
              letterSpacing: 6,
              background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              marginBottom: 12,
            }}>
              BLAXIN
            </div>
            <div style={{
              fontSize: 14,
              color: 'var(--text-muted)',
              textAlign: 'center',
              maxWidth: 400,
              lineHeight: 1.6,
            }}>
              AI Desktop Agent ready. Tell me what you'd like to do.
              <br />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                I can control your desktop, run commands, manage files, browse the web, and more.
              </span>
              {isSupported && (
                <div style={{ marginTop: 12, fontSize: 11, color: 'var(--accent-primary)' }}>
                  🎙 Voice input available — click the mic icon below
                </div>
              )}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Voice transcript preview */}
        {isListening && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            background: 'rgba(255, 51, 85, 0.08)',
            border: '1px solid rgba(255, 51, 85, 0.2)',
            borderRadius: 'var(--radius-md)',
            marginBottom: 8,
            animation: 'pulse-glow 1.5s ease-in-out infinite',
          }}>
            <div style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--accent-red)',
              animation: 'pulse-glow 1s ease-in-out infinite',
            }} />
            <span style={{ fontSize: 12, color: 'var(--accent-red)', fontFamily: 'var(--font-mono)' }}>
              Listening...
            </span>
          </div>
        )}

        {isActive && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 0',
            color: 'var(--accent-primary)',
            fontSize: 13,
          }}>
            <div style={{
              display: 'flex',
              gap: 3,
            }}>
              {[0, 1, 2].map(i => (
                <div
                  key={i}
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: '50%',
                    background: 'var(--accent-primary)',
                    animation: `pulse-glow 1.4s ease-in-out ${i * 0.2}s infinite`,
                  }}
                />
              ))}
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>
              {agentDescription || (
                <>
                  {agentState === 'thinking' && 'Processing...'}
                  {agentState === 'executing' && 'Executing action...'}
                  {agentState === 'planning' && 'Planning steps...'}
                  {agentState === 'observing' && 'Observing result...'}
                  {agentState === 'waiting' && 'Waiting...'}
                  {agentState === 'requires-confirmation' && 'Awaiting approval...'}
                </>
              )}
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div style={{
        padding: '12px 24px 16px',
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-secondary)',
      }}>
        <div style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
        }}>
          {/* Voice controls */}
          {isSupported && (
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                onClick={toggleVoice}
                disabled={isActive}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 'var(--radius-md)',
                  background: isListening 
                    ? 'rgba(255, 51, 85, 0.2)' 
                    : voiceEnabled 
                      ? 'rgba(0, 240, 255, 0.1)' 
                      : 'var(--bg-tertiary)',
                  color: isListening 
                    ? 'var(--accent-red)' 
                    : voiceEnabled 
                      ? 'var(--accent-primary)' 
                      : 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: `1px solid ${isListening ? 'rgba(255, 51, 85, 0.3)' : 'var(--border-subtle)'}`,
                  boxShadow: isListening ? '0 0 12px rgba(255, 51, 85, 0.3)' : 'none',
                  transition: 'all 0.2s',
                }}
                title={isListening ? 'Stop listening' : 'Start voice input'}
              >
                {isListening ? <FiMicOff size={14} /> : <FiMic size={14} />}
              </button>

              <button
                onClick={() => {
                  setTtsEnabled(!ttsEnabled);
                  if (ttsEnabled) stopSpeaking();
                }}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 'var(--radius-md)',
                  background: isSpeaking ? 'rgba(0, 255, 136, 0.15)' : ttsEnabled ? 'rgba(0, 240, 255, 0.1)' : 'var(--bg-tertiary)',
                  color: isSpeaking ? 'var(--accent-green)' : ttsEnabled ? 'var(--accent-primary)' : 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: `1px solid ${isSpeaking ? 'rgba(0, 255, 136, 0.4)' : 'var(--border-subtle)'}`,
                  boxShadow: isSpeaking ? '0 0 12px rgba(0, 255, 136, 0.25)' : 'none',
                  transition: 'all 0.2s',
                }}
                title={isSpeaking ? 'BLAXIN is speaking' : ttsEnabled ? 'Disable voice output' : 'Enable voice output'}
              >
                {isSpeaking ? <FiVolume2 size={14} className="pulse-soft" /> : ttsEnabled ? <FiVolume2 size={14} /> : <FiVolumeX size={14} />}
              </button>
            </div>
          )}

          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isListening ? "Listening... speak now" : "Tell BLAXIN what to do..."}
            disabled={isActive}
            rows={1}
            style={{
              flex: 1,
              background: 'var(--bg-primary)',
              border: `1px solid ${isListening ? 'rgba(255, 51, 85, 0.4)' : 'var(--border-subtle)'}`,
              borderRadius: 'var(--radius-md)',
              padding: '10px 14px',
              color: 'var(--text-primary)',
              fontSize: 14,
              fontFamily: 'var(--font-sans)',
              resize: 'none',
              minHeight: 40,
              maxHeight: 120,
              outline: 'none',
              transition: 'border-color 0.2s',
              lineHeight: 1.4,
              boxShadow: isListening ? '0 0 12px rgba(255, 51, 85, 0.15)' : 'none',
            }}
            onFocus={e => { if (!isListening) e.currentTarget.style.borderColor = 'var(--accent-primary)'; }}
            onBlur={e => { if (!isListening) e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
          />

          {isActive ? (
            <button
              onClick={stopAgent}
              style={{
                width: 40,
                height: 40,
                borderRadius: 'var(--radius-md)',
                background: 'rgba(255, 51, 85, 0.2)',
                color: 'var(--accent-red)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid rgba(255, 51, 85, 0.3)',
              }}
              title="Stop agent"
            >
              <FiSquare size={16} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              style={{
                width: 40,
                height: 40,
                borderRadius: 'var(--radius-md)',
                background: input.trim() 
                  ? 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))'
                  : 'var(--bg-tertiary)',
                color: input.trim() ? '#fff' : 'var(--text-muted)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: input.trim() ? 'var(--glow-primary)' : 'none',
                opacity: input.trim() ? 1 : 0.5,
              }}
              title="Send message"
            >
              <FiSend size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const isError = message.role === 'system' && message.content.startsWith('⚠️');

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 12,
    }}>
      <div style={{
        maxWidth: '80%',
        padding: '10px 14px',
        borderRadius: isUser ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
        background: isUser 
          ? 'linear-gradient(135deg, rgba(0, 240, 255, 0.15), rgba(123, 45, 255, 0.15))'
          : isError
            ? 'rgba(255, 51, 85, 0.08)'
            : 'var(--bg-tertiary)',
        border: isUser 
          ? '1px solid rgba(0, 240, 255, 0.2)'
          : isError
            ? '1px solid rgba(255, 51, 85, 0.3)'
            : '1px solid var(--border-subtle)',
        fontSize: 14,
        lineHeight: 1.6,
        color: isError ? 'var(--accent-red)' : 'var(--text-primary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        <div style={{
          fontSize: 10,
          color: isUser ? 'var(--accent-primary)' : 'var(--text-muted)',
          marginBottom: 4,
          fontFamily: 'var(--font-mono)',
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}>
          {isUser ? 'You' : isError ? 'Error' : 'BLAXIN'}
        </div>
        <div className="chat-markdown"><ReactMarkdown>{message.content}</ReactMarkdown></div>
        <div style={{
          fontSize: 9,
          color: 'var(--text-muted)',
          marginTop: 4,
          fontFamily: 'var(--font-mono)',
        }}>
          {new Date(message.timestamp).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
