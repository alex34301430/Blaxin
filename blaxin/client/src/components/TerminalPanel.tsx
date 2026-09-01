import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { FiTerminal, FiPower, FiMaximize2, FiMinimize2 } from 'react-icons/fi';

const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/terminal`;

export function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create terminal instance
    const terminal = new Terminal({
      theme: {
        background: '#0a0a0f',
        foreground: '#e0e0e8',
        cursor: '#00f0ff',
        cursorAccent: '#0a0a0f',
        selectionBackground: 'rgba(0, 240, 255, 0.2)',
        selectionForeground: '#ffffff',
        black: '#0a0a0f',
        red: '#ff3355',
        green: '#00ff88',
        yellow: '#ffaa00',
        blue: '#00f0ff',
        magenta: '#7b2dff',
        cyan: '#00f0ff',
        white: '#e0e0e8',
        brightBlack: '#555577',
        brightRed: '#ff5577',
        brightGreen: '#22ffaa',
        brightYellow: '#ffcc44',
        brightBlue: '#44ffff',
        brightMagenta: '#9b5dff',
        brightCyan: '#44ffff',
        brightWhite: '#ffffff',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Welcome message
    terminal.writeln('\x1b[1;36m⚡ BLAXIN Terminal\x1b[0m');
    terminal.writeln('\x1b[2m   Connecting to shell...\x1b[0m');
    terminal.writeln('');

    // Connect to WebSocket
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      terminal.writeln('\x1b[1;32m✓ Connected to terminal session\x1b[0m');
      terminal.writeln('');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case 'session-start':
            setSessionId(msg.data.sessionId);
            terminal.writeln(`\x1b[2mSession: ${msg.data.sessionId} | PID: ${msg.data.pid} | Shell: ${msg.data.shell}\x1b[0m`);
            terminal.writeln('');
            terminal.write('\x1b[1;33m$ \x1b[0m');
            break;

          case 'output':
            terminal.write(msg.data.content);
            break;

          case 'session-end':
            terminal.writeln('');
            terminal.writeln(`\x1b[1;31m[Process exited with code ${msg.data.code}]\x1b[0m`);
            terminal.write('\x1b[1;33m$ \x1b[0m');
            break;

          case 'error':
            terminal.writeln(`\x1b[1;31mError: ${msg.data.message}\x1b[0m`);
            break;
        }
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      terminal.writeln('');
      terminal.writeln('\x1b[1;31m✗ Disconnected from terminal session\x1b[0m');
    };

    ws.onerror = () => {
      setConnected(false);
    };

    // Handle terminal input
    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'input',
          data: { content: data },
        }));
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    // Handle window resize
    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      terminal.dispose();
      ws.close();
      terminalRef.current = null;
    };
  }, []);

  const reconnect = useCallback(() => {
    if (terminalRef.current && wsRef.current) {
      wsRef.current.close();
      
      terminalRef.current.writeln('');
      terminalRef.current.writeln('\x1b[1;36m⚡ Reconnecting...\x1b[0m');

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'session-start') {
            setSessionId(msg.data.sessionId);
            terminalRef.current?.writeln(`\x1b[1;32m✓ Reconnected (Session: ${msg.data.sessionId})\x1b[0m`);
          } else if (msg.type === 'output') {
            terminalRef.current?.write(msg.data.content);
          }
        } catch {}
      };

      ws.onclose = () => setConnected(false);
    }
  }, []);

  const clearTerminal = useCallback(() => {
    terminalRef.current?.clear();
  }, []);

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-primary)',
      position: 'relative',
    }}>
      {/* Terminal toolbar */}
      <div style={{
        height: 36,
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: 10,
      }}>
        <FiTerminal size={14} color="var(--accent-primary)" />
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono)',
        }}>
          Terminal
        </span>

        {sessionId && (
          <span style={{
            fontSize: 10,
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
          }}>
            {sessionId}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Status indicator */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          color: connected ? 'var(--accent-green)' : 'var(--accent-red)',
        }}>
          <div style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: connected ? 'var(--accent-green)' : 'var(--accent-red)',
            boxShadow: connected ? '0 0 6px var(--accent-green)' : '0 0 6px var(--accent-red)',
          }} />
          {connected ? 'LIVE' : 'OFF'}
        </div>

        {/* Actions */}
        <button
          onClick={reconnect}
          style={{
            padding: '4px 8px',
            background: 'var(--bg-tertiary)',
            color: 'var(--text-secondary)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 11,
            border: '1px solid var(--border-subtle)',
          }}
          title="Reconnect"
        >
          Reconnect
        </button>

        <button
          onClick={clearTerminal}
          style={{
            padding: '4px 8px',
            background: 'var(--bg-tertiary)',
            color: 'var(--text-secondary)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 11,
            border: '1px solid var(--border-subtle)',
          }}
          title="Clear terminal"
        >
          Clear
        </button>
      </div>

      {/* Terminal container */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          padding: '8px 4px',
          overflow: 'hidden',
        }}
      />
    </div>
  );
}
