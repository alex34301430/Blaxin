import { WebSocket } from 'ws';
import { spawn } from 'child_process';
import { logger } from '../utils/logger.js';
const sessions = new Map();
export function handleTerminalWebSocket(ws) {
    const sessionId = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    logger.info('terminal-ws', `New terminal session: ${sessionId}`);
    // Start a shell process
    const shell = process.env.SHELL || '/bin/bash';
    const cwd = process.env.HOME || '/tmp';
    const child = spawn(shell, [], {
        cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session = {
        id: sessionId,
        process: child,
        ws,
        cwd,
        startTime: Date.now(),
    };
    sessions.set(sessionId, session);
    // Send session info
    ws.send(JSON.stringify({
        type: 'session-start',
        data: { sessionId, pid: child.pid, cwd, shell },
    }));
    // Pipe stdout to WebSocket
    child.stdout?.on('data', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'output',
                data: { stream: 'stdout', content: data.toString('utf-8') },
            }));
        }
    });
    // Pipe stderr to WebSocket
    child.stderr?.on('data', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'output',
                data: { stream: 'stderr', content: data.toString('utf-8') },
            }));
        }
    });
    // Handle process exit
    child.on('exit', (code, signal) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'session-end',
                data: { sessionId, code, signal },
            }));
        }
        sessions.delete(sessionId);
        logger.info('terminal-ws', `Session ${sessionId} ended (code: ${code})`);
    });
    child.on('error', (err) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: err.message },
            }));
        }
    });
    // Handle messages from client
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            switch (msg.type) {
                case 'input':
                    // Send input to the shell process
                    if (child.stdin && !child.stdin.destroyed) {
                        child.stdin.write(msg.data.content);
                    }
                    break;
                case 'resize':
                    // Terminal resize (we store it but actual TTY resize needs pty)
                    break;
                case 'signal':
                    // Send signal to process (e.g., Ctrl+C)
                    if (child.pid) {
                        try {
                            process.kill(child.pid, msg.data.signal || 'SIGINT');
                        }
                        catch { }
                    }
                    break;
            }
        }
        catch (err) {
            logger.error('terminal-ws', `Message parse error: ${err}`);
        }
    });
    // Handle disconnect
    ws.on('close', () => {
        logger.info('terminal-ws', `Client disconnected from session ${sessionId}`);
        try {
            child.kill('SIGHUP');
        }
        catch { }
        sessions.delete(sessionId);
    });
    ws.on('error', (err) => {
        logger.error('terminal-ws', `WebSocket error: ${err.message}`);
        try {
            child.kill('SIGHUP');
        }
        catch { }
        sessions.delete(sessionId);
    });
}
//# sourceMappingURL=terminal-stream.js.map