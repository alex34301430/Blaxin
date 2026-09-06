# BLAXIN Local Models

BLAXIN (v1.2.0) can run its Brain model **locally** — on this machine,
or, when local hardware is too small, on a cloud shape provisioned for
you (see [`docs/oci.md`](./oci.md)).

Everything in this subsystem reports **real state only**. BLAXIN never
invents hardware, never fabricates benchmark numbers, and never shows a
READY state that has not been earned by a real health check plus a real
inference round trip.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Models / Infrastructure UI (client/src/pages/ModelsPage)   │
└──────────────▲─────────────────────────────▲───────────────┘
               │ REST (/api/resources, /api/catalog, …)
┌──────────────┴─────────────────────────────┴───────────────┐
│ Infrastructure router (server/src/api/infrastructure.ts)   │
└──────▲───────────────▲──────────────────────▲──────────────┘
       │               │                      │
┌──────┴───────┐ ┌─────┴────────────┐ ┌───────┴──────────────┐
│ Resource     │ │ Recommendation   │ │ ModelRuntime         │
│ Inventory    │ │ Engine           │ │ (OllamaRuntime first)│
│ (measured)   │ │ (deterministic)  │ │ (lifecycle, health)  │
└──────┬───────┘ └─────▲────────────┘ └───────┬──────────────┘
       │               │                      │
       └──────► ModelCatalog ◄────────────────┘
                (data-driven metadata)
                        │
                        ▼
                Brain (model providers)
```

| Component | File | Purpose |
|-----------|------|---------|
| `ResourceInventory` | `server/src/models/resource-inventory.ts` | Detects the REAL hardware of this machine |
| `ModelCatalog` | `server/src/models/model-catalog.ts` | Data-driven catalog with honest metadata |
| `RecommendationEngine` | `server/src/models/recommendation.ts` | Deterministic ranking of what can actually run |
| `ModelRuntime` | `server/src/models/runtime.ts` | Provider-neutral runtime lifecycle contract |
| `OllamaRuntime` | `server/src/models/ollama-runtime.ts` | First runtime implementation (local Ollama API) |

Adding a runtime (llama.cpp server, vLLM, any OpenAI-compatible
engine) means implementing the `ModelRuntime` interface — nothing in
the Brain, recommendation engine or UI is hard-coded around Ollama.

## ResourceInventory — measured, never invented

`detectResourceInventory()` collects:

- **CPU**: logical cores, model string, base clock (when the OS
  reports it), and instruction-set flags (AVX2/AVX-512/NEON from
  `/proc/cpuinfo` on Linux; Apple silicon is always NEON-class).
- **RAM**: installed total (`os.totalmem()`).
- **GPU/VRAM**: `nvidia-smi` (name + total VRAM), then the ROCm/amdgpu
  path, then any PCI display controller (Intel iGPU and others). VRAM
  is reported **only when the OS actually exposes it** — Apple unified
  memory and most iGPUs report `null` (unknown), never a guess.
- **Disk**: free/total bytes on the BLAXIN data volume (`statfs`).
- **Architecture/OS**: normalized to `x86_64 | aarch64 | armv7 |
  riscv64 | other` and `linux | macos | windows | other`.

Rules enforced in code:

- Every number is measured at call time (results cached for 30 s).
- A value that cannot be detected is `null` — the recommendation
  engine treats unknown as conservative, never as best-case.
- Detection failures degrade to "unknown", never to a fake value.

## ModelCatalog — maintainable metadata

Catalog entries carry real, sourced metadata:

- model id, human name, provider source (`ollama`/`huggingface`/`remote`)
- family, parameter count, quantization label
- download size (`diskBytes`, from the published artifact)
- RAM requirement (`ramBytes` — file size plus a KV-cache/overhead
  allowance for the listed context; an engineering **upper bound**
  used as a "will it fit" bound, never presented as a measurement)
- VRAM requirement (`vramBytes` or `null` when unknown)
- context length, runtime compatibility, architectures
- capabilities (`chat`, `code`, `tools`, `reasoning`,
  `long-context`, `vision`), license, download URL, checksum
  (when the source publishes one), and use-case description

**No invented benchmarks.** The `performance` field exists for claims
that cite an explicit `source`; it is empty for every shipped entry,
and the recommendation engine treats any such note as advisory only.

Adding a model = adding one catalog entry. No code changes.

## RecommendationEngine — deterministic, honest

`recommendModels(inventory, requirements)` ranks the catalog for the
measured machine:

**Hard constraints** (a violating model is never recommended):

- architecture must intersect the detected one (`any` always fits)
- download size must fit measured free disk
- `ramBytes` must fit measured RAM

**Execution class**: `gpu` only when the model's VRAM requirement is
known AND a GPU with sufficient *measured* VRAM exists. Unknown VRAM
never unlocks GPU execution. Large models on GPU-less machines get an
explicit `GPU_REQUIRED_NOT_DETECTED` warning ("will run on the CPU and
may be slow") instead of a fabricated speed figure.

**Output**:

- `best` — the top-scoring runnable model (or `null` when nothing
  fits, with an honest note pointing at cloud deployment)
- `alternatives` — all runnable models, best first, deterministic
  order (score desc, then id)
- `warnings` — machine-readable codes with human messages:
  `INSUFFICIENT_RAM`, `INSUFFICIENT_VRAM`, `INSUFFICIENT_DISK`,
  `INCOMPATIBLE_ARCHITECTURE`, `GPU_REQUIRED_NOT_DETECTED`,
  `LOW_HEADROOM` (<512 MB RAM headroom → possible swapping),
  `CAPABILITY_PARTIAL` (missing requested capabilities)
- `ramHeadroomBytes` and `execution` per alternative

Scoring is deterministic (capability coverage, GPU execution, size
preference, RAM headroom). **BLAXIN never claims a model will achieve
a specific speed** — the UI shows fit and execution class only.

## ModelRuntime — the lifecycle contract

`ModelRuntime` (in `models/runtime.ts`) is what the Brain consumes:

```ts
interface ModelRuntime {
  id: string; name: string;
  isInstalled(): Promise<boolean>;
  install(): Promise<RuntimeOperationResult>;   // engine, not models
  uninstall(): Promise<RuntimeOperationResult>;
  start(): Promise<RuntimeOperationResult>;
  stop(): Promise<RuntimeOperationResult>;
  restart(): Promise<RuntimeOperationResult>;
  status(): Promise<RuntimeStatus>;              // truthful snapshot
  loadModel(modelId) / unloadModel(modelId)
  modelInfo(): Promise<RuntimeModelInfo[]>;
  resourceRequirements(): { diskBytes; ramBytes };
  logs(tailLines?): Promise<string>;
}
```

`RuntimeStatus` states: `not-installed | stopped | starting | running
(endpoint + models) | unhealthy (error)`. There is **no fake READY**:
`status()` reflects what the engine actually reports at the moment of
the call.

## OllamaRuntime — first implementation

Manages the local Ollama engine over its native HTTP API
(`127.0.0.1:11434` by default; `BLAXIN_OLLAMA_HOST`/`BLAXIN_OLLAMA_PORT`
override, loopback-only — non-loopback endpoints are rejected).

- **detect**: binary on PATH or the API answering `/api/version`.
- **install**: official installer per OS (Linux script from
  `ollama.com`, macOS via Homebrew; other OSes get an honest
  "install it from ollama.com" result).
- **start/stop**: detached `ollama serve` with a bounded real health
  wait (no fake READY). `stop()` only stops a daemon BLAXIN spawned
  (tracked via pid file) and reports honestly when the daemon is
  managed outside BLAXIN.
- **model list / pull**: `/api/tags` mapping (size, parameter count,
  quantization); `pullModel()` streams REAL progress from Ollama's
  NDJSON response and confirms the model actually landed in the local
  list before reporting success.
- **health/status/logs**: real API probes; log tail from the daemon
  log BLAXIN writes.
- **security**: loopback-only endpoint guard on every network method;
  model ids are strictly validated before any request.

## Local model lifecycle

1. **Detect** — inventory + runtime status (real values).
2. **Recommend** — best match + alternatives + warnings.
3. **Install engine** (if missing) → **pull model** (real streamed
   progress) → **start** (bounded health wait) → **use**.
4. The UI shows each state truthfully, including errors.

## Brain integration

The Brain's provider registry includes an Ollama provider. When a
cloud deployment finishes (see `docs/oci.md`), the verified tunneled
endpoint is registered through `POST /api/providers/ollama/endpoint`,
which:

- accepts **loopback endpoints only** (the tunnel makes the remote
  engine appear on `127.0.0.1`), and
- makes Ollama the active provider (and optionally sets the active
  model) so the Brain uses it for reasoning.

The Brain never sends credentials to model providers and never
executes anything on the Body beyond its validated capability layer.

## REST API (implemented)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/resources` | Real local inventory |
| GET | `/api/catalog` | Model catalog |
| POST | `/api/recommend` | Recommendation (`{capabilities?, scope?, compartmentId?, shapeId?}`) |
| GET | `/api/runtime/status` | Engine status + in-flight pulls |
| POST | `/api/runtime/install` \| `start` \| `stop` \| `restart` | Lifecycle |
| POST | `/api/runtime/pull` | `{modelId}` — background pull |
| GET | `/api/runtime/logs?lines=N` | Engine log tail |
| POST | `/api/providers/ollama/endpoint` | Loopback endpoint override + active model |
| GET/POST/DELETE | `/api/cloud/*` | See [`docs/oci.md`](./oci.md) |

## Tests

`server/src/__tests__/models/` covers the catalog invariants, the
recommendation engine's hard constraints and warnings, inventory
normalization + real detection, and the Ollama runtime against a real
in-process fake of the Ollama HTTP API (status, pulls with streamed
progress, loopback guards, honest stop semantics).
