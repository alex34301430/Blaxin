// BLAXIN infrastructure API
// =============================================================
// REST surface for the local-model + cloud system: resource
// inventory, model catalog, recommendations, runtime lifecycle and
// OCI discovery/provisioning. All state reported here is REAL — no
// fabricated READY states, no invented quotas, no echo of secrets.
//
// Security rules:
//   - credentials are accepted → validated → stored encrypted and are
//     never returned by any endpoint (only masked summaries)
//   - error messages are redacted before they reach the client
//   - the model endpoint override only accepts loopback addresses
// =============================================================

import { Router } from 'express';
import { detectResourceInventory } from '../models/resource-inventory.js';
import { MODEL_CATALOG, getCatalogModel } from '../models/model-catalog.js';
import { recommendModels, TaskRequirements } from '../models/recommendation.js';
import { OllamaRuntime } from '../models/ollama-runtime.js';
import { CloudProvider } from '../cloud/cloud-provider.js';
import { DeploymentEngine, getOrCreateTunnelKey } from '../cloud/deployment.js';
import { OciCredentials, credentialsWellFormed } from '../cloud/oci/signer.js';
import { saveOciCredentials, clearOciCredentials, ociCredentialSummary } from '../cloud/oci/secret-store.js';
import { logger } from '../utils/logger.js';

// ── Dependency surface (the composition root injects real singletons;
//    tests inject fakes) ────────────────────────────────────────

export interface InfrastructureDeps {
  runtime: OllamaRuntime;
  cloud: CloudProvider;
  deployments: DeploymentEngine;
  /** Reverse-tunnel configuration for cloud instances. */
  tunnel: { host: string; port: number; localPort: number };
  /** Point the Ollama provider at a loopback endpoint (deployments). */
  setOllamaEndpoint: (endpoint: string) => boolean;
  /** Make this the active provider/model (the Brain's default). */
  activateOllamaModel: (modelId?: string) => void;
  /** OCI credentials save path (separated so tests can spy on it). */
  saveCredentials?: (cred: OciCredentials) => void;
  clearCredentials?: () => void;
  credentialSummary?: () => { configured: boolean; region: string | null; tenancyMasked: string | null };
}

// ── Error shaping (no secrets, no stack traces, bounded size) ──

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/-----[A-Z ]*PRIVATE KEY-----[\s\S]*?-----[A-Z ]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/ssh-ed25519\s+\S+/g, '[redacted]')
    .replace(/(-----BEGIN [A-Z ]+ KEY-----)[\s\S]*?(-----END [A-Z ]+ KEY-----)/g, '[redacted]')
    .slice(0, 500);
}

export function createInfrastructureRouter(deps: InfrastructureDeps): Router {
  const router = Router();
  const { runtime, cloud, deployments, tunnel } = deps;

  /** In-flight model pulls (per runtime instance), for truthful progress. */
  const pullProgress = new Map<string, { total: number | null; done: number | null; percent: number | null }>();

  // ── Local resource inventory ─────────────────────────────────

  router.get('/resources', async (_req, res) => {
    try {
      const inventory = await detectResourceInventory();
      res.json({ inventory });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  // ── Model catalog ────────────────────────────────────────────

  router.get('/catalog', (_req, res) => {
    res.json({ models: MODEL_CATALOG, count: MODEL_CATALOG.length });
  });

  // ── Recommendation ───────────────────────────────────────────

  router.post('/recommend', async (req, res) => {
    try {
      const body = (req.body || {}) as {
        capabilities?: string[];
        preferLargest?: boolean;
        scope?: 'local' | 'cloud';
        compartmentId?: string;
        shapeId?: string;
      };
      const requirements: TaskRequirements = {
        capabilities: Array.isArray(body.capabilities) ? body.capabilities as TaskRequirements['capabilities'] : undefined,
        preferLargest: body.preferLargest === true,
      };

      if (body.scope === 'cloud') {
        if (!body.compartmentId || !body.shapeId) {
          return res.status(400).json({ error: 'cloud recommendations need both compartmentId and shapeId' });
        }
        const shapes = await cloud.discoverShapes(body.compartmentId);
        const shape = shapes.find((s) => s.id === body.shapeId);
        if (!shape) {
          return res.status(404).json({ error: `Shape ${body.shapeId} is not available in this compartment` });
        }
        const inventory = cloud.inventoryForShape(shape, body.compartmentId);
        const result = recommendModels(inventory, requirements);
        return res.json({ inventory, ...result });
      }

      const inventory = await detectResourceInventory();
      const result = recommendModels(inventory, requirements);
      res.json({ inventory, ...result });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  // ── Runtime lifecycle ────────────────────────────────────────

  router.get('/runtime/status', async (_req, res) => {
    try {
      const status = await runtime.status();
      const pulling = Array.from(pullProgress.entries()).map(([modelId, p]) => ({ modelId, ...p }));
      res.json({ status, pulling });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  router.get('/runtime/logs', async (req, res) => {
    const lines = Math.min(500, Math.max(1, Number(req.query.lines) || 100));
    const logs = await runtime.logs(lines);
    res.json({ logs });
  });

  router.post('/runtime/install', async (_req, res) => {
    res.json(await runtime.install());
  });

  router.post('/runtime/start', async (_req, res) => {
    res.json(await runtime.start());
  });

  router.post('/runtime/stop', async (_req, res) => {
    res.json(await runtime.stop());
  });

  router.post('/runtime/restart', async (_req, res) => {
    res.json(await runtime.restart());
  });

  router.post('/runtime/pull', async (req, res) => {
    const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
    if (!modelId) return res.status(400).json({ ok: false, error: 'modelId is required' });
    if (pullProgress.has(modelId)) {
      return res.status(409).json({ ok: false, error: `Model ${modelId} is already being pulled` });
    }
    void runtime.pullModel(modelId, (p) => {
      pullProgress.set(modelId, p);
    }).finally(() => pullProgress.delete(modelId));
    res.json({ ok: true, pulling: true, modelId });
  });

  // ── Ollama provider endpoint override (used by deployments) ──

  router.post('/providers/ollama/endpoint', (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
    if (!endpoint) return res.status(400).json({ ok: false, error: 'endpoint is required' });
    // Only loopback endpoints are accepted (the provider enforces it too).
    if (!deps.setOllamaEndpoint(endpoint)) {
      return res.status(400).json({ ok: false, error: 'Only loopback endpoints are accepted (127.0.0.1 / localhost)' });
    }
    deps.activateOllamaModel(model);
    res.json({ ok: true, activeProvider: 'ollama', activeModel: model ?? null });
  });

  // ── OCI connection ───────────────────────────────────────────

  router.get('/cloud/status', (_req, res) => {
    const summary = (deps.credentialSummary ?? ociCredentialSummary)();
    const tunnelReady = Boolean(tunnel.host) && /^[a-z0-9.-]+$/i.test(tunnel.host);
    res.json({
      provider: { id: cloud.id, name: cloud.name, configured: summary.configured, missing: cloud.credentialsStatus().missing },
      credentials: summary,
      tunnel: {
        host: tunnel.host || null,
        port: tunnel.port,
        localPort: tunnel.localPort,
        ready: tunnelReady,
        note: tunnelReady
          ? `Instances dial back to ${tunnel.host}:${tunnel.port} and appear on 127.0.0.1:${tunnel.localPort}.`
          : 'Set BLAXIN_TUNNEL_HOST to this machine\'s reachable SSH address to enable cloud model deployments.',
      },
    });
  });

  /** Connect: validate the credential shape, store encrypted, then
   * prove it against the live API. Nothing credential-bearing is ever
   * returned. */
  router.post('/cloud/oci/connect', async (req, res) => {
    const body = req.body || {};
    const cred: OciCredentials = {
      tenancy: typeof body.tenancy === 'string' ? body.tenancy.trim() : '',
      user: typeof body.user === 'string' ? body.user.trim() : '',
      fingerprint: typeof body.fingerprint === 'string' ? body.fingerprint.trim() : '',
      privateKey: typeof body.privateKey === 'string' ? body.privateKey.trim() : '',
      region: typeof body.region === 'string' ? body.region.trim() : '',
      tenancyName: typeof body.tenancyName === 'string' ? body.tenancyName.trim() : undefined,
    };
    const check = credentialsWellFormed(cred);
    if (!check.ok) {
      return res.status(400).json({ ok: false, error: `Incomplete credentials: missing ${check.missing.join(', ')}` });
    }
    try {
      (deps.saveCredentials ?? saveOciCredentials)(cred);
      // Live proof: a real API call with the stored credentials.
      const info = await cloud.validateCredentials();
      logger.info('cloud', 'OCI credentials validated successfully');
      res.json({
        ok: true,
        tenancyName: info.tenancyName,
        region: info.region,
        summary: (deps.credentialSummary ?? ociCredentialSummary)(),
      });
    } catch (error) {
      // Never keep credentials that failed live validation.
      (deps.clearCredentials ?? clearOciCredentials)();
      res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  router.delete('/cloud/oci', async (_req, res) => {
    await cloud.clearCredentials();
    res.json({ ok: true });
  });

  // ── OCI discovery ────────────────────────────────────────────

  router.get('/cloud/topology', async (_req, res) => {
    try {
      res.json(await cloud.discoverTopology());
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.get('/cloud/shapes', async (req, res) => {
    const compartmentId = typeof req.query.compartmentId === 'string' ? req.query.compartmentId : '';
    if (!compartmentId) return res.status(400).json({ error: 'compartmentId is required' });
    try {
      res.json({ shapes: await cloud.discoverShapes(compartmentId) });
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.get('/cloud/instances', async (req, res) => {
    const compartmentId = typeof req.query.compartmentId === 'string' ? req.query.compartmentId : '';
    if (!compartmentId) return res.status(400).json({ error: 'compartmentId is required' });
    try {
      res.json({ instances: await cloud.listInstances(compartmentId) });
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.get('/cloud/quota', async (req, res) => {
    const compartmentId = typeof req.query.compartmentId === 'string' ? req.query.compartmentId : '';
    if (!compartmentId) return res.status(400).json({ error: 'compartmentId is required' });
    try {
      res.json({ quotas: await cloud.discoverQuota(compartmentId) });
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  // ── Tunnel key (public part only — never the private key) ────

  router.get('/cloud/tunnel', (_req, res) => {
    try {
      const key = getOrCreateTunnelKey();
      res.json({
        publicKey: key.publicKey,
        host: tunnel.host || null,
        port: tunnel.port,
        localPort: tunnel.localPort,
        ready: Boolean(tunnel.host),
        installHint: tunnel.host
          ? `Add this public key to the ~/.ssh/authorized_keys of the "${tunnel.host}" SSH user on this machine.`
          : 'Set BLAXIN_TUNNEL_HOST to this machine\'s reachable SSH address to enable cloud model deployments.',
      });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  // ── Deployments ──────────────────────────────────────────────

  router.get('/cloud/deployments', (_req, res) => {
    res.json({ deployments: deployments.list() });
  });

  router.get('/cloud/deployments/:id', (req, res) => {
    const rec = deployments.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Unknown deployment' });
    res.json({ deployment: rec });
  });

  router.post('/cloud/deploy', async (req, res) => {
    const body = req.body || {};
    const required = ['shapeId', 'compartmentId', 'availabilityDomain', 'modelId', 'runtimeId'];
    for (const field of required) {
      if (typeof body[field] !== 'string' || !body[field].trim()) {
        return res.status(400).json({ ok: false, error: `${field} is required` });
      }
    }
    if (!getCatalogModel(body.modelId)) {
      return res.status(400).json({ ok: false, error: `Unknown catalog model: ${body.modelId}` });
    }
    try {
      const rec = deployments.start({
        shapeId: body.shapeId.trim(),
        compartmentId: body.compartmentId.trim(),
        availabilityDomain: body.availabilityDomain.trim(),
        modelId: body.modelId.trim(),
        runtimeId: body.runtimeId.trim(),
        ocpus: typeof body.ocpus === 'number' ? body.ocpus : null,
        memoryInGbs: typeof body.memoryInGbs === 'number' ? body.memoryInGbs : null,
      });
      res.json({ ok: true, deployment: rec });
    } catch (error) {
      res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  router.post('/cloud/deployments/:id/cancel', (req, res) => {
    const result = deployments.cancel(req.params.id);
    if (!result.ok) return res.status(409).json(result);
    res.json({ ok: true });
  });

  return router;
}