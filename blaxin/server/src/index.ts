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
import { APP_VERSION, GITHUB_REPO, GITHUB_RELEASES_URL } from './utils/version.js';
import { ProviderId, AppConfig } from './types.js';

const PORT = parseInt(process.env.PORT || '3001');
const app = express();

app.use(cors());
app.use(express.json());

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
    const latestVersion = release.tag_name?.replace(/^v/, '') || '';
    const updateAvailable = latestVersion && latestVersion !== APP_VERSION;
    
    // Compare versions semantically
    let majorUpdate = false;
    if (updateAvailable && latestVersion && APP_VERSION) {
      const curr = APP_VERSION.split('.').map(Number);
      const latest = latestVersion.split('.').map(Number);
      if (latest[0] > curr[0]) majorUpdate = true;
    }
    
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
    res.json({ valid: false, error: error.message });
  }
});

app.post('/api/providers/:id/save-key', async (req, res) => {
  const { id } = req.params;
  const { apiKey } = req.body;
  try {
    const result = await providers.saveKey(id as ProviderId, apiKey);
    res.json(result);
  } catch (error: any) {
    res.json({ valid: false, error: error.message });
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

// Create HTTP server
const server = createServer(app);

// WebSocket server (agent)
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false, maxPayload: 10 * 1024 * 1024 });

// WebSocket server (terminal)
const terminalWss = new WebSocketServer({ server, path: '/ws/terminal', perMessageDeflate: false, maxPayload: 5 * 1024 * 1024 });

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
    },
  }));
});

// Handle terminal WebSocket connections
terminalWss.on('connection', (ws) => {
  logger.info('terminal-ws', 'Terminal client connected');
  handleTerminalWebSocket(ws);
});

// Start server
server.listen(PORT, '0.0.0.0', async () => {
  logger.info('server', `BLAXIN server running on http://localhost:${PORT}`);
  
  // Initialize providers
  await providers.initializeAll();
  
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
