# BLAXIN on Oracle Cloud (OCI)

BLAXIN can provision an inference node on Oracle Cloud and wire it to
the Brain as a local model provider. OCI is the **first** cloud
provider, not the architecture: everything is built on a
provider-neutral `CloudProvider` contract
(`server/src/cloud/cloud-provider.ts`). Future clouds (AWS, Azure,
GCP) implement the same interface without touching provisioning,
recommendation or the Brain.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ CloudProvider contract (provider-neutral)                   │
│   credentialsStatus / validateCredentials / discoverTopology│
│   discoverShapes / listInstances / launchInstance (idempotent)
│   terminateInstance / discoverQuota / inventoryForShape     │
└──────────────▲──────────────────────────────▲───────────────┘
               │                              │
┌──────────────┴──────────────┐  ┌────────────┴───────────────┐
│ OciCloudProvider            │  │ DeploymentEngine           │
│  signer.ts   (RSA-SHA256)   │  │  resumable state machine   │
│  client.ts   (REST /20160918)│ │  cloud-init bootstrap      │
│  secret-store.ts (encrypted)│  │  tunnel health/inference   │
└─────────────────────────────┘  └────────────────────────────┘
```

The recommendation engine consumes cloud shapes through
`inventoryForShape()` — the same neutral inventory shape used for the
local machine — so "what model fits this shape" is answered by the
same deterministic code path.

## Security model

- **Credentials at rest**: OCI credentials (tenancy OCID, user OCID,
  fingerprint, private key, region) are stored AES-256 encrypted in
  `~/.blaxin-oci-credentials` (BLAXIN data dir) with `0600`
  permissions, namespace-separated from LLM keys so OCI can be
  disconnected independently. The same `BLAXIN_SECRET` envelope used
  for LLM credentials protects them.
- **Never leaked**: credentials are never logged, never included in
  error messages (error shaping redacts PEM blocks and key material),
  never returned by any REST endpoint (only masked summaries), never
  sent to model providers, and never enter the Brain ↔ Body protocol.
- **Removal is real**: `DELETE /api/cloud/oci` deletes the store file.
- **Connect = validate-then-keep**: `POST /api/cloud/oci/connect`
  validates the credential shape, stores it, then proves it with a
  real API call; if that call fails the stored credentials are wiped
  immediately.
- **Least privilege**: BLAXIN performs only the calls it needs
  (availability domains, compartments, shapes, instances, limits,
  images). Scope your OCI user accordingly.

## Authentication — real request signing

`signer.ts` implements OCI "signature version 1": an RSA-SHA256
signature over the canonical request (`(request-target) host date
x-content-sha256 content-type content-length`) carried in the
`Authorization` header with `keyId="<tenancy>/<user>/<fingerprint>"`.
PEM and base64-DER keys (the `~/.oci/config` style) are both accepted.
Credential structure is validated offline (`credentialsWellFormed`)
before any network call.

## Discovery — real responses only

All discovery is performed against the live OCI Core Services API
(`/20160918`), following `opc-next-page` pagination:

- **Availability domains** — also used as the credential proof during
  connect/validate.
- **Compartments** — root tenancy plus active sub-compartments.
- **Shapes** — mapped to neutral resources: architecture
  (Ampere/A1 → `aarch64`, Intel/AMD → `x86_64`), OCPUs, RAM bytes,
  GPU count and VRAM per GPU **only when OCI reports them** for the
  shape. Quota fields start as "unknown" and are filled from the
  limits API when available.
- **Service limits** — `GET /limits?serviceName=compute` per
  compartment, with `limit`, `used` and computed `available`. Values
  OCI does not report stay `null`.
- **Platform images** — the newest Canonical Ubuntu image for the
  target architecture, resolved from the real images API (never a
  guessed OCID).

> **Honesty about capacity**: GPU availability, Always Free eligibility
> and actual compute capacity depend entirely on **your** account,
> region, service limits and Oracle's real-time capacity. BLAXIN does
> not claim GPU availability, free-tier capacity or any specific shape
> unless your account's discovery actually proves it. "Out of host
> capacity" responses are surfaced verbatim as actionable errors.

## Provisioning — the state machine

`DeploymentEngine` drives a persisted, resumable state machine:

```
DISCOVERING → VALIDATING → PREPARING → INSTALLING_RUNTIME
  → DOWNLOADING_MODEL → VERIFYING_MODEL → STARTING_SERVER
  → HEALTH_CHECK → CONNECTING_BRAIN → INFERENCE_TEST → READY
```

plus terminal `FAILED` and `CANCELLED`.

- **Durable**: every transition is persisted; a crash or restart
  resumes from the last durable step (`resumeAll()` runs at server
  boot). Completed deployments are never re-run.
- **Idempotent launch**: `launchInstance` uses a deterministic,
  uniquified instance name derived from the deployment token —
  relaunching the same deployment finds its previous instance instead
  of creating a duplicate.
- **Real bootstrap**: the instance is configured by cloud-init that
  installs Ollama, pulls the chosen model and opens the reverse
  tunnel. There is no simulated progress: the INSTALLING_RUNTIME /
  DOWNLOADING_MODEL / STARTING_SERVER labels track one real probe —
  the tunneled health endpoint — until it answers.
- **Truthful READY**: READY requires, in order, a real health check
  through the tunnel, a real inference round trip
  (`/api/generate` must return a completion), and a successful
  registration of the endpoint with the Brain's provider registry.
  Any failure records the verbatim (redacted) error in `FAILED`.
- **Cancellable**: `cancel()` sets a flag checked between steps; the
  machine unwinds at the next boundary, terminates the instance it
  created and records `CANCELLED`. Cancelling a terminal deployment is
  a clean refusal.

## Secure model endpoint (no public exposure)

The instance never gets a public model port. Instead it dials **back**
to this machine over SSH and forwards its loopback Ollama port:

```
cloud instance ──ssh -R 127.0.0.1:<localPort>:127.0.0.1:11434──► your machine
Brain ──► http://127.0.0.1:<localPort>   (loopback only)
```

- BLAXIN generates a dedicated ed25519 tunnel key locally
  (`getOrCreateTunnelKey`); the **private key never leaves this
  machine** and only the public key ships via cloud-init/SSH
  metadata. The public key is shown by `GET /api/cloud/tunnel` for you
  to install in this machine's `~/.ssh/authorized_keys`.
- `BLAXIN_TUNNEL_HOST` (and `BLAXIN_PORT` for the SSH port,
  `BLAXIN_TUNNEL_LOCAL_PORT` for the local end) must point at an
  address reachable from the cloud instance. Without it, deployments
  **fail fast and honestly** before launching anything.
- The Brain talks to the model over loopback only — the endpoint is
  never made public and the provider override rejects non-loopback
  values.

## REST API (implemented)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/cloud/status` | Credential status (masked), tunnel readiness |
| POST | `/api/cloud/oci/connect` | Validate + store (encrypted) credentials |
| DELETE | `/api/cloud/oci` | Disconnect (deletes stored credentials) |
| GET | `/api/cloud/topology` | Region, compartments, availability domains |
| GET | `/api/cloud/shapes?compartmentId=` | Shapes with real resource data |
| GET | `/api/cloud/instances?compartmentId=` | Existing instances |
| GET | `/api/cloud/quota?compartmentId=` | Compute service limits |
| GET | `/api/cloud/tunnel` | Public tunnel key + install hint |
| GET | `/api/cloud/deployments` \| `/api/cloud/deployments/:id` | Deployment records |
| POST | `/api/cloud/deploy` | Start a deployment (shape + model) |
| POST | `/api/cloud/deployments/:id/cancel` | Cancel at the next step boundary |
| POST | `/api/recommend` | `{"scope":"cloud", …}` ranks models for a shape |

## Setup checklist

1. Create an OCI API key for your user (tenancy OCID, user OCID,
   fingerprint, private key, region).
2. In BLAXIN → **Models** → Oracle Cloud → *Verify & Connect*.
3. Set `BLAXIN_TUNNEL_HOST` to this machine's reachable SSH address
   (and `BLAXIN_TUNNEL_PORT` if not 22), install the shown public key
   in this machine's `~/.ssh/authorized_keys`, and restart the server.
4. *Discover* → pick a shape → *Deploy* with a catalog model.
5. Watch the state machine reach READY (health ✓ inference ✓ Brain ✓).

## Troubleshooting

| Symptom | Meaning |
|---------|---------|
| `OCI authentication failed … (401)` | tenancy/user OCID, fingerprint, key or region mismatch |
| `OCI authorization failed … (403)` | the user lacks IAM permissions for the call |
| `Out of host capacity` | real Oracle capacity shortage — try another AD/shape or retry later |
| `BLAXIN_TUNNEL_HOST is not set` | deployment refused before launch; configure the tunnel first |
| Deployment stuck in PREPARING | instance booting or the reverse tunnel cannot dial back — check SSH reachability of `BLAXIN_TUNNEL_HOST` |
| `Model … did not appear on the instance` | the cloud-init pull failed (check the instance's ollama log) |

## Tests

`server/src/__tests__/cloud/` covers the signer (signature verified
against the public key), the encrypted secret store (no plaintext at
rest, 0600, real removal), the OCI client against a stubbed API
(pagination, mapping, idempotent launch, capacity/auth errors),
the deployment state machine against a mock provider plus a real
in-process tunnel endpoint (READY gating, resume without duplicate
launch, cancellation with instance teardown, honest failures), and a
provider-contract test proving a second cloud can plug in unchanged.
