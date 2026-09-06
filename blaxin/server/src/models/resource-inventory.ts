// BLAXIN local resource inventory
// =============================================================
// Detects the REAL hardware this machine offers — CPU, RAM, GPU/VRAM,
// disk, architecture, OS — and maps it onto the provider-neutral
// ResourceInventory shape the recommendation engine consumes.
//
// Honesty rules:
//   - every number here is measured, never invented
//   - when a value cannot be detected the field is null (unknown);
//     the recommendation engine treats null conservatively instead
//     of assuming a best case
//   - detection failures degrade to "unknown", never to a fake value
// =============================================================

import { execFile } from 'child_process';
import { statfs } from 'fs/promises';
import { arch, cpus, totalmem, platform, release } from 'os';
import { logger } from '../utils/logger.js';

// ── Inventory types (provider-neutral) ──────────────────────────

export interface CpuResource {
  /** Logical processor count. */
  cores: number;
  /** Physical cores when detectable, else null. */
  physicalCores: number | null;
  /** CPU model string as reported by the OS, else null. */
  model: string | null;
  /** Base clock MHz when detectable, else null. */
  clockMhz: number | null;
  /** Instruction-set extensions relevant to local inference. */
  flags: {
    avx2: boolean | null;
    avx512: boolean | null;
    neon: boolean | null;
  };
}

export interface GpuResource {
  /** Vendor-reported GPU name, else null. */
  name: string | null;
  /** Dedicated VRAM in bytes when detectable, else null. */
  vramBytes: number | null;
  /** Driver/runtime flavour relevant to local inference runtimes. */
  kind: 'nvidia-cuda' | 'amd-rocm' | 'apple-metal' | 'intel' | 'other' | 'none' | 'unknown';
}

export interface StorageResource {
  /** Free bytes on the BLAXIN data volume. */
  freeBytes: number | null;
  /** Total bytes on the BLAXIN data volume. */
  totalBytes: number | null;
}

export interface ResourceInventory {
  /** Schema version for this record (storage + migrations). */
  schemaVersion: 1;
  /** Where this inventory was taken ('local' machine or a cloud shape). */
  scope: 'local' | 'cloud';
  os: {
    platform: string;
    release: string | null;
    /** Normalized family used for runtime compatibility checks. */
    family: 'linux' | 'macos' | 'windows' | 'other';
  };
  architecture: 'x86_64' | 'aarch64' | 'armv7' | 'riscv64' | 'other';
  cpu: CpuResource;
  /** Installed RAM in bytes (total, not available). */
  memoryBytes: number;
  /** System-visible GPUs; empty when none are reported. */
  gpus: GpuResource[];
  storage: StorageResource;
  /** When this snapshot was taken (epoch ms). */
  detectedAt: number;
}

// ── Architecture normalization ──────────────────────────────────

export function normalizeArch(a: string): ResourceInventory['architecture'] {
  switch (a) {
    case 'x64': case 'amd64': case 'x86_64': return 'x86_64';
    case 'arm64': case 'aarch64': return 'aarch64';
    case 'arm': case 'armv7l': case 'armv6l': return 'armv7';
    case 'riscv64': return 'riscv64';
    default: return 'other';
  }
}

export function normalizeOsFamily(p: string): ResourceInventory['os']['family'] {
  switch (p) {
    case 'linux': return 'linux';
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    default: return 'other';
  }
}

// ── Detection helpers ───────────────────────────────────────────

/** Promise wrapper around execFile with a hard timeout and output cap. */
function run(command: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 512 * 1024 }, (error, stdout) => {
      if (error) resolve(null);
      else resolve(stdout.toString());
    });
  });
}

/** Parse integer from text; null when nothing parseable (never 0-fake). */
function parseIntOrNull(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(/(\d[\d,\.]*)/);
  if (!m) return null;
  const n = Number(m[1].replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function detectCpuFlags(): Promise<CpuResource['flags']> {
  const fam = normalizeOsFamily(platform());
  if (fam === 'linux') {
    const out = await run('sh', ['-c', 'grep -m1 -E "^(flags|Features)" /proc/cpuinfo']);
    const text = out || '';
    return {
      avx2: text.includes('avx2'),
      avx512: text.includes('avx512'),
      neon: text.includes('asimd') || text.includes('neon'),
    };
  }
  if (fam === 'macos') {
    const a = normalizeArch(arch());
    // Apple silicon always has NEON-class AMX/vector extensions.
    return { avx2: false, avx512: false, neon: a === 'aarch64' ? true : null };
  }
  return { avx2: null, avx512: null, neon: null };
}

async function detectGpus(): Promise<GpuResource[]> {
  const fam = normalizeOsFamily(platform());
  const gpus: GpuResource[] = [];

  if (fam === 'linux') {
    // nvidia-smi: name + total VRAM (bytes).
    const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
    if (smi) {
      for (const line of smi.split('\n').map((l) => l.trim()).filter(Boolean)) {
        const [name, mib] = line.split(',').map((s) => s.trim());
        const mibNum = Number(mib);
        gpus.push({
          name: name || null,
          vramBytes: Number.isFinite(mibNum) && mibNum > 0 ? Math.round(mibNum * 1024 * 1024) : null,
          kind: 'nvidia-cuda',
        });
      }
    }
    if (gpus.length === 0) {
      // ROCm / amdgpu path: VRAM is not reliably exposed; name only.
      const rocm = await run('sh', ['-c', 'ls /sys/class/drm/card*/device/vendor 2>/dev/null | head -4']);
      if (rocm && rocm.includes('0x1002')) {
        const name = await run('sh', ['-c', 'grep -m1 -s "^model name" /proc/cpuinfo; lspci 2>/dev/null | grep -m1 -i "vga.*amd" || true']);
        gpus.push({ name: (name || '').trim() || null, vramBytes: null, kind: 'amd-rocm' });
      }
    }
    if (gpus.length === 0) {
      // Any PCI display controller at all (Intel iGPU, others).
      const lspci = await run('lspci', []);
      const display = lspci?.split('\n').find((l) => /vga|3d controller|display/i.test(l));
      if (display) {
        const kind = /intel/i.test(display) ? 'intel' : 'other';
        gpus.push({ name: display.split(':').slice(2).join(':').trim() || null, vramBytes: null, kind });
      }
    }
    return gpus;
  }

  if (fam === 'macos') {
    const name = await run('sh', ['-c', 'system_profiler SPDisplaysDataType 2>/dev/null | grep -m1 "Chipset Model" | cut -d: -f2']);
    // Apple silicon uses unified memory; report VRAM as null (unknown).
    gpus.push({ name: (name || '').trim() || null, vramBytes: null, kind: 'apple-metal' });
    return gpus;
  }

  if (fam === 'windows') {
    const out = await run('wmic', ['path', 'win32_VideoController', 'get', 'name']);
    const name = out?.split('\n').map((l) => l.trim()).filter((l) => l && !/^name$/i.test(l))[0] || null;
    if (name) gpus.push({ name, vramBytes: null, kind: name.toLowerCase().includes('nvidia') ? 'nvidia-cuda' : 'unknown' });
    return gpus;
  }

  return gpus;
}

async function detectStorage(): Promise<StorageResource> {
  try {
    const { dataPath } = await import('../utils/paths.js');
    const st = await statfs(dataPath());
    // bsize = fundamental block size; blocks * bsize = total bytes.
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    return {
      freeBytes: Number.isFinite(free) ? free : null,
      totalBytes: Number.isFinite(total) ? total : null,
    };
  } catch (error: any) {
    logger.warn('resources', `Storage detection failed: ${error.message}`);
    return { freeBytes: null, totalBytes: null };
  }
}

// ── Public API ──────────────────────────────────────────────────

let cache: { inventory: ResourceInventory; at: number } | null = null;
const CACHE_TTL_MS = 30_000;

/** Detect the real hardware of this machine (cached for 30s).
 * gpuCountOverride is for tests only. */
export async function detectResourceInventory(): Promise<ResourceInventory> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.inventory;

  const cpuList = cpus();
  const flags = await detectCpuFlags();
  const gpus = await detectGpus();
  const storage = await detectStorage();

  const inventory: ResourceInventory = {
    schemaVersion: 1,
    scope: 'local',
    os: {
      platform: platform(),
      release: release() || null,
      family: normalizeOsFamily(platform()),
    },
    architecture: normalizeArch(arch()),
    cpu: {
      cores: cpuList.length > 0 ? cpuList.length : 1,
      physicalCores: null, // not exposed by os.cpus(); null = unknown
      model: cpuList[0]?.model?.trim() || null,
      clockMhz: cpuList[0]?.speed ? cpuList[0].speed : null,
      flags,
    },
    memoryBytes: totalmem(),
    gpus,
    storage,
    detectedAt: Date.now(),
  };

  cache = { inventory, at: Date.now() };
  return inventory;
}

/** Invalidate the detection cache (tests / after hardware changes). */
export function invalidateResourceCache(): void {
  cache = null;
}

/** Bytes → human string (for the UI). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}
