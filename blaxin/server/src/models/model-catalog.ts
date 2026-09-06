// BLAXIN model catalog
// =============================================================
// A maintainable, data-driven catalog of local models. The catalog
// carries REAL metadata (parameter counts, quantization sizes, memory
// footprints, context lengths, licenses) — it never invents benchmark
// numbers. Performance claims, when present, cite their source; the
// recommendation engine treats them as advisory only.
//
// Adding a model = adding a catalog entry. No recommendation logic
// lives in the UI and nothing here is hard-coded into the Brain.
// =============================================================

export type ModelSource = 'ollama' | 'huggingface' | 'remote';

export type ModelCapability =
  | 'chat'
  | 'tools'
  | 'long-context'
  | 'reasoning'
  | 'code'
  | 'vision';

export type RuntimeCompatibility =
  | 'ollama'
  | 'llama.cpp'
  | 'vllm'
  | 'openai-compatible';

export interface ModelPerformanceNote {
  /** What was measured, e.g. "prompt processing" — never invented. */
  metric: string;
  /** The measured value with units, e.g. "45 tok/s". */
  value: string;
  /** Where the number comes from (upstream release notes, docs…). */
  source: string;
}

export interface CatalogModel {
  /** Canonical id, e.g. "qwen2.5:7b-instruct-q4_K_M". */
  id: string;
  /** Human name. */
  name: string;
  source: ModelSource;
  /** Model family (qwen, llama, mistral…). */
  family: string;
  /** Total parameters, e.g. 7_000_000_000 for 7B. */
  parameters: number;
  /** Quantization label, e.g. "Q4_K_M"; null for unquantized. */
  quantization: string | null;
  /** Approximate download size in bytes (real, from the source). */
  diskBytes: number;
  /** Peak RAM needed to RUN the model (weights + KV cache + overhead),
   * in bytes. Derived from the file size + context estimate — an
   * upper-bound estimate, never a fabricated measurement. */
  ramBytes: number;
  /** Peak VRAM needed to fully offload to GPU, in bytes; null when
   * unknown (partial offload is still possible). */
  vramBytes: number | null;
  /** Maximum context window (tokens). */
  contextTokens: number;
  /** Runtimes that can run this artifact. */
  runtimes: RuntimeCompatibility[];
  /** Machine architectures this build supports. */
  architectures: Array<'x86_64' | 'aarch64' | 'any'>;
  /** What the model can do. */
  capabilities: ModelCapability[];
  /** License identifier (SPDX when possible). */
  license: string;
  /** Where to download from. */
  downloadUrl: string;
  /** Checksum when the source publishes one (null otherwise). */
  checksum: { algorithm: 'sha256'; value: string } | null;
  /** Performance notes with explicit sources; empty = no claims. */
  performance: ModelPerformanceNote[];
  /** Honest one-line description of what this model is good at. */
  description: string;
  /** Catalog schema version. */
  schemaVersion: 1;
}

// ── Catalog ─────────────────────────────────────────────────────
// Sizes are the PUBLISHED artifact sizes (GGUF/ollama manifests) as of
// the catalog date. ramBytes = disk + ~1.5–2 GB KV/overhead allowance
// for the listed context — an engineering estimate marked as such; the
// recommendation engine only uses it as a lower bound for "will fit".

const GB = 1024 * 1024 * 1024;

export const MODEL_CATALOG: CatalogModel[] = [
  {
    id: 'qwen2.5:0.5b-instruct-q4_K_M',
    name: 'Qwen2.5 0.5B Instruct',
    source: 'ollama',
    family: 'qwen2.5',
    parameters: 500_000_000,
    quantization: 'Q4_K_M',
    diskBytes: 400 * 1024 * 1024,
    ramBytes: 1.2 * GB,
    vramBytes: 0.7 * GB,
    contextTokens: 32_768,
    runtimes: ['ollama', 'llama.cpp'],
    architectures: ['x86_64', 'aarch64'],
    capabilities: ['chat'],
    license: 'Apache-2.0',
    downloadUrl: 'ollama://qwen2.5:0.5b-instruct-q4_K_M',
    checksum: null,
    performance: [],
    description: 'Tiny assistant for very constrained machines. Limited reasoning depth.',
    schemaVersion: 1,
  },
  {
    id: 'qwen2.5:1.5b-instruct-q4_K_M',
    name: 'Qwen2.5 1.5B Instruct',
    source: 'ollama',
    family: 'qwen2.5',
    parameters: 1_500_000_000,
    quantization: 'Q4_K_M',
    diskBytes: 1.0 * GB,
    ramBytes: 2.2 * GB,
    vramBytes: 1.4 * GB,
    contextTokens: 32_768,
    runtimes: ['ollama', 'llama.cpp'],
    architectures: ['x86_64', 'aarch64'],
    capabilities: ['chat', 'code'],
    license: 'Apache-2.0',
    downloadUrl: 'ollama://qwen2.5:1.5b-instruct-q4_K_M',
    checksum: null,
    performance: [],
    description: 'Small general assistant; usable simple coding help on low-RAM machines.',
    schemaVersion: 1,
  },
  {
    id: 'qwen2.5:3b-instruct-q4_K_M',
    name: 'Qwen2.5 3B Instruct',
    source: 'ollama',
    family: 'qwen2.5',
    parameters: 3_100_000_000,
    quantization: 'Q4_K_M',
    diskBytes: 2.0 * GB,
    ramBytes: 4.0 * GB,
    vramBytes: 2.6 * GB,
    contextTokens: 32_768,
    runtimes: ['ollama', 'llama.cpp'],
    architectures: ['x86_64', 'aarch64'],
    capabilities: ['chat', 'code', 'tools'],
    license: 'Qwen Research License',
    downloadUrl: 'ollama://qwen2.5:3b-instruct-q4_K_M',
    checksum: null,
    performance: [],
    description: 'Balanced small model with basic tool use; good default for 8 GB machines.',
    schemaVersion: 1,
  },
  {
    id: 'qwen2.5:7b-instruct-q4_K_M',
    name: 'Qwen2.5 7B Instruct',
    source: 'ollama',
    family: 'qwen2.5',
    parameters: 7_600_000_000,
    quantization: 'Q4_K_M',
    diskBytes: 4.7 * GB,
    ramBytes: 7.2 * GB,
    vramBytes: 5.5 * GB,
    contextTokens: 32_768,
    runtimes: ['ollama', 'llama.cpp'],
    architectures: ['x86_64', 'aarch64'],
    capabilities: ['chat', 'code', 'tools', 'reasoning'],
    license: 'Qwen Research License',
    downloadUrl: 'ollama://qwen2.5:7b-instruct-q4_K_M',
    checksum: null,
    performance: [],
    description: 'Strong general assistant with tool use; needs 8 GB RAM or a 6 GB+ GPU.',
    schemaVersion: 1,
  },
  {
    id: 'llama3.1:8b-instruct-q4_K_M',
    name: 'Llama 3.1 8B Instruct',
    source: 'ollama',
    family: 'llama3.1',
    parameters: 8_000_000_000,
    quantization: 'Q4_K_M',
    diskBytes: 4.9 * GB,
    ramBytes: 7.5 * GB,
    vramBytes: 5.8 * GB,
    contextTokens: 131_072,
    runtimes: ['ollama', 'llama.cpp'],
    architectures: ['x86_64', 'aarch64'],
    capabilities: ['chat', 'code', 'tools', 'long-context'],
    license: 'Llama 3.1 Community License',
    downloadUrl: 'ollama://llama3.1:8b-instruct-q4_K_M',
    checksum: null,
    performance: [],
    description: 'Meta 8B with a very large context window; solid all-round assistant.',
    schemaVersion: 1,
  },
  {
    id: 'qwen2.5-coder:7b-q4_K_M',
    name: 'Qwen2.5 Coder 7B',
    source: 'ollama',
    family: 'qwen2.5-coder',
    parameters: 7_600_000_000,
    quantization: 'Q4_K_M',
    diskBytes: 4.7 * GB,
    ramBytes: 7.2 * GB,
    vramBytes: 5.5 * GB,
    contextTokens: 32_768,
    runtimes: ['ollama', 'llama.cpp'],
    architectures: ['x86_64', 'aarch64'],
    capabilities: ['chat', 'code', 'tools'],
    license: 'Apache-2.0',
    downloadUrl: 'ollama://qwen2.5-coder:7b-q4_K_M',
    checksum: null,
    performance: [],
    description: 'Coding-specialized 7B; strongest local option for code tasks at this size.',
    schemaVersion: 1,
  },
  {
    id: 'llama3.1:70b-instruct-q4_K_M',
    name: 'Llama 3.1 70B Instruct',
    source: 'ollama',
    family: 'llama3.1',
    parameters: 70_600_000_000,
    quantization: 'Q4_K_M',
    diskBytes: 42.5 * GB,
    ramBytes: 48 * GB,
    vramBytes: 44 * GB,
    contextTokens: 131_072,
    runtimes: ['ollama', 'llama.cpp', 'vllm'],
    architectures: ['x86_64', 'aarch64'],
    capabilities: ['chat', 'code', 'tools', 'reasoning', 'long-context'],
    license: 'Llama 3.1 Community License',
    downloadUrl: 'ollama://llama3.1:70b-instruct-q4_K_M',
    checksum: null,
    performance: [],
    description: 'Large model for server-class machines or multi-GPU cloud instances only.',
    schemaVersion: 1,
  },
];

/** Find one catalog entry by exact id. */
export function getCatalogModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/** All models compatible with a runtime. */
export function modelsForRuntime(runtime: RuntimeCompatibility): CatalogModel[] {
  return MODEL_CATALOG.filter((m) => m.runtimes.includes(runtime));
}
