import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { providers } from './providers/index.js';
import { toolRegistry } from './tools/index.js';
import { orchestrator } from './orchestrator/index.js';
import { handleTerminalWebSocket } from './tools/terminal-stream.js';
import { logger } from './utils/logger.js';
import { loadConfig, saveConfig } from './utils/config.js';
import { credentialStore } from './utils/credentials.js';
import { runDiagnostics } from './utils/diagnostics.js';
import { sessionState } from './utils/session-state.js';
import { memoryStore } from './utils/memory.js';
import {
  corsOriginValidator,
  getAllowedOriginsFromEnv,
  isOriginAllowed,
  isStateChangingRequestAllowed,
} from './utils/security.js';
import { isVersionNewer, isMajorVersionUpgrade } from './utils/semver.js';
import { APP_VERSION, GITHUB_REPO, GITHUB_RELEASES_URL } from './utils/version.js';
import { ProviderId, AppConfig } from './types.js';

const PORT = parseInt(process.env.PORT || '3001');
const HOST = process.env.BLAXIN_HOST || '0.0.0.0';
const EXTRA_ALLOWED_ORIGINS = getAllowedOriginsFromEnv();

const app = express();

// CORS: allow only trusted origins (see utils/security.ts). Browsers from
// other origins cannot send state-changing requests or read responses.
app.use(cors({ origin: corsOriginValidator(EXTRA_ALLOWED_ORIGINS) }));
app.use(express.json({ limit: '5mb' }));

// Belt-and-braces origin check for state-changing requests (the CORS layer
// stops browsers from reading responses, this stops the request itself).
// See isStateChangingRequestAllowed in utils/security.ts for the policy.
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (isStateChangingRequestAllowed(req.method, origin, EXTRA_ALLOWED_ORIGINS)) {
    return next();
  }
  logger.warn('security', `Blocked ${req.method} ${req.path} from origin ${origin || '(none)'}`);
  res.status(403).json({ error: 'Origin not allowed' });
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: APP_VERSION, uptime: process.uptime() });
});

// Version & Update check
app.get('/api/version', (_req, res) => {
  res.json({ version: APP_VERSION, repo: GITHUB_REPO });
});

app.get('/api/update/check', async (_req, res) => {
  try {
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: { 'User-Agent': `BLAXIN/${APP_VERSION}` },
    });
    
    if (!response.ok) {
      return res.json({ updateAvailable: false, error: 'Failed to check for updates' });
    }
    
    const release = await response.json() as any;
    const latestVersion = (release.tag_name || '').replace(/^v/, '');

    // Semantic comparison: an update is only offered when the remote
    // release is strictly newer than the running version (a local build
    // that is ahead of the last tag must not be told to "downgrade").
    const updateAvailable = !!latestVersion && isVersionNewer(latestVersion, APP_VERSION);
    const majorUpdate = updateAvailable && isMajorVersionUpgrade(latestVersion, APP_VERSION);
    
    // Find Linux assets (AppImage, .deb, .sig)
    const allAssets = release.assets || [];
    const linuxAssets = allAssets.filter((a: any) => 
      a.name?.endsWith('.AppImage') || a.name?.endsWith('.deb') || 
      a.name?.endsWith('.AppImage.tar.gz') || a.name?.endsWith('.sig')
    );
    
    // Find the primary download (AppImage preferred, then .deb)
    const appimage = linuxAssets.find((a: any) => a.name?.endsWith('.AppImage'));
    const deb = linuxAssets.find((a: any) => a.name?.endsWith('.deb'));
    const primaryDownload = appimage || deb;
    
    res.json({
      updateAvailable,
      currentVersion: APP_VERSION,
      latestVersion,
      majorUpdate,
      releaseName: release.name || `v${latestVersion}`,
      releaseNotes: release.body || '',
      releaseDate: release.published_at || '',
      releaseUrl: release.html_url || '',
      downloadUrl: primaryDownload?.browser_download_url || release.html_url || '',
      assets: linuxAssets.map((a: any) => ({
        name: a.name,
        size: a.size,
        downloadUrl: a.browser_download_url,
        contentType: a.content_type,
      })),
    });
  } catch (error: any) {
    logger.error('update', 'Failed to check for updates', error);
    res.json({ updateAvailable: false, error: error.message });
  }
});

// Diagnostics
app.get('/api/diagnostics', async (_req, res) => {
  try {
    const result = await runDiagnostics();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Provider endpoints
app.get('/api/providers', (_req, res) => {
  const status = providers.getStatus();
  res.json(status);
});

app.post('/api/providers/:id/validate', async (req, res) => {
  const { id } = req.params;
  const { apiKey } = req.body;
  try {
    const result = await providers.validateKey(id as ProviderId, apiKey);
    res.json(result);
  } catch (error: any) {
    res.json({ valid: false, error: error.message, code: 'UNKNOWN' });
  }
});

app.post('/api/providers/:id/save-key', async (req, res) => {
  const { id } = req.params;
  const { apiKey, skipValidation } = req.body || {};
  try {
    const result = await providers.saveKey(id as ProviderId, apiKey, {
      skipValidation: skipValidation === true,
    });
    res.json(result);
  } catch (error: any) {
    res.json({ valid: false, error: error.message, code: 'UNKNOWN' });
  }
});

app.delete('/api/providers/:id/key', (req, res) => {
  const { id } = req.params;
  providers.removeKey(id as ProviderId);
  res.json({ success: true });
});

app.get('/api/providers/:id/models', async (req, res) => {
  const { id } = req.params;
  try {
    const models = await providers.fetchModels(id as ProviderId);
    res.json(models);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/models', async (_req, res) => {
  try {
    const models = await providers.fetchAllAvailableModels();
    res.json(models);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/models/active', (req, res) => {
  const { providerId, modelId } = req.body;
  if (providerId) providers.setActiveProvider(providerId);
  if (modelId) providers.setActiveModel(modelId);
  res.json({ 
    success: true, 
    activeProvider: providers.getActiveProvider(),
    activeModel: providers.getActiveModel(),
  });
});

// Tool endpoints
app.get('/api/tools', (_req, res) => {
  const tools = toolRegistry.getAllTools().map(t => ({
    name: t.name,
    description: t.description,
  }));
  res.json(tools);
});

app.get('/api/tools/status', (_req, res) => {
  res.json(toolRegistry.getEnabledStatus());
});

app.post('/api/tools/:name/toggle', (req, res) => {
  const { name } = req.params;
  const { enabled } = req.body;
  toolRegistry.setEnabled(name, enabled);
  res.json({ success: true, enabled });
});

// Config endpoints
app.get('/api/config', (_req, res) => {
  res.json(loadConfig());
});

app.put('/api/config', (req, res) => {
  const config = req.body as AppConfig;
  saveConfig(config);
  res.json({ success: true });
});

// Agent endpoints
app.post('/api/agent/message', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }
  
  // Start processing in background, WebSocket will deliver updates
  orchestrator.processMessage(message).catch(err => {
    logger.error('api', 'Agent processing failed', err);
  });
  
  res.json({ success: true, taskId: orchestrator.getCurrentTask()?.id });
});

app.post('/api/agent/stop', (_req, res) => {
  orchestrator.stop();
  res.json({ success: true });
});

app.post('/api/agent/clear', (_req, res) => {
  orchestrator.clearHistory();
  res.json({ success: true });
});

app.get('/api/agent/history', (_req, res) => {
  res.json(orchestrator.getConversationHistory());
});

// Memory endpoints
app.get('/api/memory', (req, res) => {
  const query = (req.query.q as string) || undefined;
  const type = (req.query.type as string) || undefined;
  const entries = memoryStore.search(query, (type as any) || undefined);
  res.json(entries);
});

app.delete('/api/memory/:id', (req, res) => {
  const removed = memoryStore.remove(req.params.id);
  res.json({ success: removed });
});

app.delete('/api/memory', (_req, res) => {
  memoryStore.clear();
  res.json({ success: true });
});

// JSON body / route error handling — always respond in JSON, never leak stacks.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed JSON body', code: 'BAD_JSON' });
  }
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    return res.status(413).json({ error: 'Request body too large', code: 'BODY_TOO_LARGE' });
  }
  const status = err?.status || err?.statusCode;
  if (status && status >= 400 && status < 500) {
    return res.status(status).json({ error: err.message || 'Bad request', code: 'BAD_REQUEST' });
  }
  logger.error('api', 'Unhandled request error', err);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
});

// 404 handler — unknown API paths return JSON, not HTML.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
});

// Create HTTP server
const server = createServer(app);

// WebSocket servers are upgrade-routed so we can validate the Origin of
// every connection BEFORE the 101 Switching Protocols handshake completes.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 10 * 1024 * 1024 });
const terminalWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 5 * 1024 * 1024 });

function handleUpgrade(
  target: WebSocketServer,
  request: import('http').IncomingMessage,
  socket: import('stream').Duplex,
  head: Buffer,
  label: string,
): void {
  const origin = (request.headers.origin as string | undefined) || undefined;
  if (!isOriginAllowed(origin, EXTRA_ALLOWED_ORIGINS)) {
    logger.warn('security', `Blocked ${label} WebSocket upgrade from origin ${origin || '(none)'}`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  target.handleUpgrade(request, socket, head, (ws) => {
    target.emit('connection', ws, request);
  });
}

server.on('upgrade', (request, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(request.url || '/', 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname === '/ws') {
    handleUpgrade(wss, request, socket, head, 'agent');
  } else if (pathname === '/ws/terminal') {
    handleUpgrade(terminalWss, request, socket, head, 'terminal');
  } else {
    socket.destroy();
  }
});

// Broadcast orchestrator events to ALL connected clients
orchestrator.setEventCallback((event, data) => {
  const message = JSON.stringify({ event, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
});

wss.on('connection', (ws) => {
  logger.info('websocket', 'Client connected');

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      switch (msg.type) {
        case 'user-message':
          await orchestrator.processMessage(msg.data.content);
          break;
        case 'stop':
          orchestrator.stop();
          break;
        case 'clear':
          orchestrator.clearHistory();
          break;
        case 'ping':
          ws.send(JSON.stringify({ event: 'pong', data: { timestamp: Date.now() } }));
          break;
        case 'confirmation-response':
          orchestrator.respondToConfirmation(msg.data?.stepId, msg.data?.approved === true);
          break;
      }
    } catch (error: any) {
      logger.error('websocket', 'Message handling error', error);
      ws.send(JSON.stringify({ 
        event: 'error', 
        data: { message: 'Invalid message format' } 
      }));
    }
  });

  ws.on('close', () => {
    logger.info('websocket', 'Client disconnected');
  });

  // Send initial state
  ws.send(JSON.stringify({
    event: 'connected',
    data: {
      state: orchestrator.getState(),
      activeProvider: providers.getActiveProvider(),
      activeModel: providers.getActiveModel(),
      description: orchestrator.getCurrentDescription(),
    },
  }));
});

// Handle terminal WebSocket connections
terminalWss.on('connection', (ws) => {
  logger.info('terminal-ws', 'Terminal client connected');
  handleTerminalWebSocket(ws);
});

// Fail loudly and exit when the port is already in use or binding fails,
// instead of lingering as a zombie process.
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.error('server', `Port ${PORT} is already in use. Is another BLAXIN instance running?`);
  } else {
    logger.error('server', `Failed to start server: ${error.message}`);
  }
  process.exit(1);
});

// Start server
server.listen(PORT, HOST, async () => {
  logger.info('server', `BLAXIN server running on http://${HOST}:${PORT}`);
  
  // Initialize providers
  await providers.initializeAll();
  
  // Start session state auto-save
  sessionState.startAutoSave();
  
  // Send ready event to any connected clients
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event: 'ready', data: {} }));
    }
  });
});

// Graceful shutdown
const shutdown = () => {
  logger.info('server', 'Shutting down...');
  sessionState.stopAutoSave();
  wss.clients.forEach(client => {
    try { client.close(1001, 'Server shutting down'); } catch {}
  });
  terminalWss.clients.forEach(client => {
    try { client.close(1001, 'Server shutting down'); } catch {}
  });
  wss.close();
  terminalWss.close();
  server.close(() => {
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// Prevent crashes from unhandled errors
process.on('uncaughtException', (error) => {
  logger.error('server', 'Uncaught exception', error);
});
process.on('unhandledRejection', (reason) => {
  logger.error('server', 'Unhandled rejection', reason);
});
