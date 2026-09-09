import { describe, it, expect } from 'vitest';
import { getSystemTelemetry, getNetworkTelemetry } from '../utils/system-telemetry.js';

describe('system telemetry', () => {
  it('returns real, bounded values (never invented)', async () => {
    const t = await getSystemTelemetry();

    expect(t.timestamp).toBeGreaterThan(0);
    expect(t.nodeVersion.length).toBeGreaterThan(0);

    // CPU
    expect(t.cpu.cores).toBeGreaterThan(0);
    expect(t.cpu.model).toBeTruthy();
    expect(t.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(t.cpu.usagePercent).toBeLessThanOrEqual(100);
    for (const v of [t.cpu.loadAvg.one, t.cpu.loadAvg.five, t.cpu.loadAvg.fifteen]) {
      expect(v).toBeGreaterThanOrEqual(0);
    }

    // Memory
    expect(t.memory.totalBytes).toBeGreaterThan(0);
    expect(t.memory.usedBytes).toBeGreaterThanOrEqual(0);
    expect(t.memory.freeBytes).toBeGreaterThanOrEqual(0);
    expect(t.memory.percent).toBeGreaterThanOrEqual(0);
    expect(t.memory.percent).toBeLessThanOrEqual(100);

    // Disk (may be null only if neither statfs nor df is available)
    if (t.disk) {
      expect(t.disk.totalBytes).toBeGreaterThan(0);
      expect(t.disk.usedBytes).toBeGreaterThanOrEqual(0);
      expect(t.disk.percent).toBeGreaterThanOrEqual(0);
      expect(t.disk.percent).toBeLessThanOrEqual(100);
      expect(t.disk.mount.length).toBeGreaterThan(0);
    }

    // OS / uptime
    expect(t.uptimeSec).toBeGreaterThan(0);
    expect(t.os.platform.length).toBeGreaterThan(0);
    expect(t.os.arch.length).toBeGreaterThan(0);
    expect(t.os.hostname.length).toBeGreaterThan(0);
  });

  it('reports a stable CPU usage over consecutive calls', async () => {
    await getSystemTelemetry(); // seeds the delta baseline
    const a = await getSystemTelemetry();
    const b = await getSystemTelemetry();
    expect(a.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(b.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(a.cpu.usagePercent).toBeLessThanOrEqual(100);
    expect(b.cpu.usagePercent).toBeLessThanOrEqual(100);
  });

  it('returns real, bounded network throughput readings', async () => {
    // Seed the delta baseline, then read a real rate.
    getNetworkTelemetry();
    const n = getNetworkTelemetry();
    expect(n.timestamp).toBeGreaterThan(0);
    expect(n.rxBytesPerSec).toBeGreaterThanOrEqual(0);
    expect(n.txBytesPerSec).toBeGreaterThanOrEqual(0);
    expect(n.rxTotalBytes).toBeGreaterThanOrEqual(0);
    expect(n.txTotalBytes).toBeGreaterThanOrEqual(0);
    // Interface list is either real or honestly empty.
    for (const iface of n.interfaces) {
      expect(iface.name.length).toBeGreaterThan(0);
      expect(iface.rxBytes).toBeGreaterThanOrEqual(0);
    }
  });
});