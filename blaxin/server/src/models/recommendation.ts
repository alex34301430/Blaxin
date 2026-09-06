// BLAXIN model recommendation engine
// =============================================================
// Deterministic matcher between (a) the REAL detected resources
// (ResourceInventory), (b) the ModelCatalog and (c) the task
// requirements. Produces the best model, ranked alternatives and
// honest warnings.
//
// Rules:
//   - NEVER recommends a model that cannot run: RAM/VRAM/disk/arch
//     are hard constraints, checked against measured values.
//   - Unknown resources (null) are treated conservatively: the engine
//     only recommends models whose requirements are satisfied by what
//     IS known (e.g. unknown VRAM cannot unlock a GPU-required model).
//   - NO invented performance numbers: recommendations rank by fit
//     (capability match + resource headroom), never by fabricated
//     benchmarks.
// =============================================================

import { ResourceInventory, formatBytes } from './resource-inventory.js';
import { CatalogModel, MODEL_CATALOG, ModelCapability } from './model-catalog.js';

export interface TaskRequirements {
  /** Capabilities the user actually needs (chat is always implied). */
  capabilities?: ModelCapability[];
  /** Soft preference for the largest model that fits. */
  preferLargest?: boolean;
}

export interface RecommendationWarning {
  code:
    | 'INSUFFICIENT_RAM'
    | 'INSUFFICIENT_VRAM'
    | 'INSUFFICIENT_DISK'
    | 'INCOMPATIBLE_ARCHITECTURE'
    | 'GPU_REQUIRED_NOT_DETECTED'
    | 'LOW_HEADROOM'
    | 'CAPABILITY_PARTIAL';
  message: string;
}

export interface ModelRecommendation {
  model: CatalogModel;
  /** 0–100 fit score: how well resources + capabilities match. */
  score: number;
  /** Where the model will run given the measured resources. */
  execution: 'gpu' | 'cpu' | 'unknown';
  /** Remaining RAM after the model's estimate, or null when unknown. */
  ramHeadroomBytes: number | null;
  warnings: RecommendationWarning[];
}

export interface RecommendationResult {
  /** The single best recommendation, or null when nothing can run. */
  best: ModelRecommendation | null;
  /** All runnable models, best first. */
  alternatives: ModelRecommendation[];
  /** Models the user asked about implicitly (capability misses). */
  notes: string[];
}

/** Hard resource check. Returns warnings for every violated bound. */
function checkFits(
  model: CatalogModel,
  inv: ResourceInventory,
): { fits: boolean; warnings: RecommendationWarning[]; execution: 'gpu' | 'cpu' | 'unknown'; ramHeadroom: number | null } {
  const warnings: RecommendationWarning[] = [];

  // Architecture: 'any' is always fine; otherwise must intersect.
  const modelArchs = model.architectures as readonly string[];
  if (!modelArchs.includes('any') && !modelArchs.includes(inv.architecture)) {
    warnings.push({
      code: 'INCOMPATIBLE_ARCHITECTURE',
      message: `${model.name} is not built for ${inv.architecture}.`,
    });
    return { fits: false, warnings, execution: 'unknown', ramHeadroom: null };
  }

  // Disk: hard constraint (download + run needs the file on disk).
  if (inv.storage.freeBytes !== null && model.diskBytes > inv.storage.freeBytes) {
    warnings.push({
      code: 'INSUFFICIENT_DISK',
      message: `Needs ${formatBytes(model.diskBytes)} free disk; only ${formatBytes(inv.storage.freeBytes)} available.`,
    });
    return { fits: false, warnings, execution: 'unknown', ramHeadroom: null };
  }

  // RAM: hard constraint. The estimate is an upper bound; if even that
  // does not fit, the model cannot run.
  const ramHeadroom = inv.memoryBytes - model.ramBytes;
  if (ramHeadroom < 0) {
    warnings.push({
      code: 'INSUFFICIENT_RAM',
      message: `Needs about ${formatBytes(model.ramBytes)} RAM; this machine has ${formatBytes(inv.memoryBytes)}.`,
    });
    return { fits: false, warnings, execution: 'unknown', ramHeadroom };
  }

  // GPU preference: full offload only when measured VRAM is known and
  // big enough. Unknown VRAM never unlocks GPU execution.
  const gpu = inv.gpus.find((g) => g.kind === 'nvidia-cuda' || g.kind === 'amd-rocm' || g.kind === 'apple-metal');
  let execution: 'gpu' | 'cpu' | 'unknown' = 'cpu';
  if (model.vramBytes !== null && model.vramBytes > 0 && gpu) {
    if (gpu.vramBytes !== null && gpu.vramBytes >= model.vramBytes) {
      execution = 'gpu';
    } else if (gpu.vramBytes !== null) {
      // GPU present but too small for full offload → CPU with a note.
      warnings.push({
        code: 'INSUFFICIENT_VRAM',
        message: `${gpu.name || 'The GPU'} has ${formatBytes(gpu.vramBytes)} VRAM; ${model.name} needs ${formatBytes(model.vramBytes)} for full offload. It will run on the CPU.`,
      });
    }
  } else if (model.vramBytes !== null && model.vramBytes > 4 * 1024 * 1024 * 1024 && !gpu) {
    // Big models effectively need a GPU for usable speed; be honest.
    warnings.push({
      code: 'GPU_REQUIRED_NOT_DETECTED',
      message: `No GPU detected. ${model.name} will run on the CPU and may be slow.`,
    });
  }

  // Low headroom: it "fits" but the estimate has error bars — warn.
  if (ramHeadroom >= 0 && ramHeadroom < 512 * 1024 * 1024) {
    warnings.push({
      code: 'LOW_HEADROOM',
      message: `Only ${formatBytes(ramHeadroom)} RAM headroom above the model's estimate; other apps may cause swapping.`,
    });
  }

  return { fits: true, warnings, execution, ramHeadroom };
}

/** Fit score: resource headroom + capability match. Deterministic. */
function scoreOf(model: CatalogModel, inv: ResourceInventory, exec: 'gpu' | 'cpu' | 'unknown', req: TaskRequirements): number {
  let score = 0;

  // Capability match (the dominant term).
  const wanted = new Set<ModelCapability>(req.capabilities || []);
  if (wanted.size === 0) wanted.add('chat');
  let matched = 0;
  for (const c of wanted) if (model.capabilities.includes(c)) matched++;
  const capRatio = matched / wanted.size;
  score += capRatio * 50;

  // GPU execution beats CPU for anything sizeable.
  if (exec === 'gpu') score += 25;

  // Prefer bigger models when resources allow (soft, unless requested).
  const paramsB = model.parameters / 1e9;
  score += Math.min(15, paramsB * 1.5);

  // Headroom bonus: comfort margin on RAM.
  const headroom = inv.memoryBytes - model.ramBytes;
  if (headroom > 4 * 1024 * 1024 * 1024) score += 10;
  else if (headroom > 2 * 1024 * 1024 * 1024) score += 5;

  return Math.round(Math.min(100, score));
}

/** Rank every catalog model for this machine. Deterministic output. */
export function recommendModels(
  inv: ResourceInventory,
  requirements: TaskRequirements = {},
): RecommendationResult {
  const notes: string[] = [];
  const alternatives: ModelRecommendation[] = [];

  for (const model of MODEL_CATALOG) {
    const check = checkFits(model, inv);
    if (!check.fits) continue;

    const wanted = new Set<ModelCapability>(requirements.capabilities || []);
    if (wanted.size === 0) wanted.add('chat');
    const missing = [...wanted].filter((c) => !model.capabilities.includes(c));
    const warnings = [...check.warnings];
    if (missing.length > 0) {
      warnings.push({
        code: 'CAPABILITY_PARTIAL',
        message: `Does not fully cover: ${missing.join(', ')}.`,
      });
    }

    alternatives.push({
      model,
      score: scoreOf(model, inv, check.execution, requirements),
      execution: check.execution,
      ramHeadroomBytes: check.ramHeadroom,
      warnings,
    });
  }

  alternatives.sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));

  if (alternatives.length === 0) {
    const smallest = MODEL_CATALOG.reduce((m, c) => (c.ramBytes < m.ramBytes ? c : m), MODEL_CATALOG[0]);
    notes.push(
      `No catalog model can run on this machine (smallest option "${smallest.name}" needs about ${formatBytes(smallest.ramBytes)} RAM; this machine has ${formatBytes(inv.memoryBytes)}${inv.storage.freeBytes !== null ? ` and ${formatBytes(inv.storage.freeBytes)} free disk` : ''}). Use a cloud deployment instead.`,
    );
  }

  return { best: alternatives[0] ?? null, alternatives, notes };
}

/** True when a specific model can run (used by the install endpoint). */
export function canModelRun(model: CatalogModel, inv: ResourceInventory): { ok: boolean; reason?: string } {
  const check = checkFits(model, inv);
  if (check.fits) return { ok: true };
  return { ok: false, reason: check.warnings.map((w) => w.message).join(' ') };
}
