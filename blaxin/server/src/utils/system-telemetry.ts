// BLAXIN system telemetry
// =============================================================
// Real, dependency-free readings for the live system panel. Never
// invents numbers: CPU usage is derived from os.cpus() tick deltas
// between calls, memory from os.totalmem/freemem, disk from statfs
// (with a df fallback). No polling happens server-side — each request
// is one cheap read; the client controls the cadence.
// =============================================================

import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { statfsSync } from 'fs';

const execFileAsync = promisify(execFile);

export interface CpuTelemetry {
  /** Percent of CPU ticks spent busy since the previous call (0-100). */
  usagePercent: number;
  cores: number;
  model: string | null;
  loadAvg: { one: number; five: number; fifteen: number };
}

export interface MemoryTelemetry {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  percent: number;
}

export interface DiskTelemetry {
  totalBytes: number;
  usedBytes: number;
  percent: number;
  mount: string;
}

export interface SystemTelemetry {
  timestamp: number;
  cpu: CpuTelemetry;
  memory: MemoryTelemetry;
  disk: DiskTelemetry | null;
  uptimeSec: number;
  os: { platform: string; release: string; arch: string; hostname: string };
  nodeVersion: string;
}

interface CpuSample {
  idle: number;
  total: number;
}

function cpuSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

// Baseline taken at module load so even the first request has a delta.
let lastCpu: CpuSample = cpuSample();

function cpuUsagePercent(): number {
  const now = cpuSample();
  const prev = lastCpu;
  lastCpu = now;
  const idleDelta = now.idle - prev.idle;
  const totalDelta = now.total - prev.total;
  if (totalDelta <= 0 || idleDelta < 0) return 0;
  const used = Math.round((1 - idleDelta / totalDelta) * 100);
  return Math.max(0, Math.min(100, used));
}

function statfsDisk(mount: string): DiskTelemetry | null {
  try {
    const s = (statfsSync as (p: string) => { blocks: number; bsize: number; bfree: number; bavail: number })(mount);
    if (!s || typeof s.blocks !== 'number' || typeof s.bsize !== 'number') return null;
    const total = s.blocks * s.bsize;
    const free = (typeof s.bavail === 'number' ? s.bavail : s.bfree) * s.bsize;
    const used = Math.max(0, total - free);
    return {
      totalBytes: total,
      usedBytes: used,
      percent: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
      mount,
    };
  } catch {
    return null;
  }
}

async function diskUsage(mount: string): Promise<DiskTelemetry | null> {
  if (typeof statfsSync === 'function') {
    const viaStatfs = statfsDisk(mount);
    if (viaStatfs) return viaStatfs;
  }
  // Fallback: df -kP (POSIX, stable column order with -P).
  try {
    const { stdout } = await execFileAsync('df', ['-kP', mount]);
    const lines = stdout.trim().split('\n');
    const last = lines[lines.length - 1]?.trim().split(/\s+/);
    if (last && last.length >= 5 && /^\d+$/.test(last[1])) {
      const totalKb = Number(last[1]);
      const usedKb = Number(last[2]);
      const pct = Number((last[4] || '0').replace('%', ''));
      return {
        totalBytes: totalKb * 1024,
        usedBytes: usedKb * 1024,
        percent: Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0,
        mount: last[5] ?? mount,
      };
    }
  } catch {
    // df unavailable — disk stays null, the UI says so.
  }
  return null;
}

export async function getSystemTelemetry(): Promise<SystemTelemetry> {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;
  const load = os.loadavg();
  const cpus = os.cpus();
  // Home is always a real, existing mount — the most meaningful disk for
  // the user's data (BLAXIN state lives under ~/.local/share/blaxin).
  const disk = await diskUsage(os.homedir());

  return {
    timestamp: Date.now(),
    cpu: {
      usagePercent: cpuUsagePercent(),
      cores: cpus.length,
      model: cpus[0]?.model ?? null,
      loadAvg: { one: load[0], five: load[1], fifteen: load[2] },
    },
    memory: {
      totalBytes: memTotal,
      usedBytes: memUsed,
      freeBytes: memFree,
      percent: memTotal > 0 ? Math.min(100, Math.round((memUsed / memTotal) * 100)) : 0,
    },
    disk,
    uptimeSec: os.uptime(),
    os: { platform: os.platform(), release: os.release(), arch: os.arch(), hostname: os.hostname() },
    nodeVersion: process.version,
  };
}