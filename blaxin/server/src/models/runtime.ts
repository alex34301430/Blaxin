// BLAXIN model runtime abstraction
// =============================================================
// A ModelRuntime manages the *lifecycle* of local inference engines
// (install, start, stop, health, load/unload, logs). The Brain consumes
// this contract only — adding a runtime (llama.cpp server, vLLM, an
// OpenAI-compatible engine) never touches the Brain.
//
// Every operation is honest: it reports real state or a real error.
// There is no fake READY: `status()` reflects what the runtime actually
// reports at the moment of the call.
// =============================================================

export interface RuntimeModelInfo {
  id: string;
  /** Artifact size in bytes when known. */
  sizeBytes: number | null;
  /** Parameter count when the runtime reports it. */
  parameters: number | null;
  /** Quantization label when known. */
  quantization: string | null;
  /** When the model was pulled/created (epoch ms) if known. */
  modifiedAt: number | null;
}

export type RuntimeStatus =
  | { state: 'not-installed' }
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'running'; endpoint: string; models: RuntimeModelInfo[] }
  | { state: 'unhealthy'; endpoint: string | null; error: string };

export interface RuntimeOperationResult {
  ok: boolean;
  error?: string;
  /** Runtime-provided detail (command output tail, etc.). */
  detail?: string;
}

export interface ModelRuntime {
  readonly id: string;
  readonly name: string;
  /** True when the engine binary/service exists on this machine. */
  isInstalled(): Promise<boolean>;
  /** Install the engine (not the models). */
  install(): Promise<RuntimeOperationResult>;
  uninstall(): Promise<RuntimeOperationResult>;
  start(): Promise<RuntimeOperationResult>;
  stop(): Promise<RuntimeOperationResult>;
  restart(): Promise<RuntimeOperationResult>;
  /** Truthful health snapshot of the engine. */
  status(): Promise<RuntimeStatus>;
  /** Load a model into memory (a no-op for pull-based engines). */
  loadModel(modelId: string): Promise<RuntimeOperationResult>;
  unloadModel(modelId: string): Promise<RuntimeOperationResult>;
  /** Models available locally to this runtime. */
  modelInfo(): Promise<RuntimeModelInfo[]>;
  /** What this runtime needs before it can run models. */
  resourceRequirements(): { diskBytes: number; ramBytes: number };
  /** Recent engine logs (tail). */
  logs(tailLines?: number): Promise<string>;
}
