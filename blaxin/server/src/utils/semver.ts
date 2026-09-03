// Minimal semantic version helpers (x.y.z, optional leading "v").

export function parseVersion(input: string): number[] | null {
  const cleaned = String(input || '').trim().replace(/^v/i, '');
  const parts = cleaned.split('.');
  if (parts.length === 0 || parts.length > 3) return null;
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p)) return Number.NaN;
    return parseInt(p, 10);
  });
  if (nums.some(Number.isNaN)) return null;
  while (nums.length < 3) nums.push(0);
  return nums;
}

/** Returns 1 when a > b, -1 when a < b, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/** True when `candidate` is a strictly newer release than `current`. */
export function isVersionNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** True when the major version of `candidate` exceeds that of `current`. */
export function isMajorVersionUpgrade(candidate: string, current: string): boolean {
  const pa = parseVersion(candidate);
  const pb = parseVersion(current);
  if (!pa || !pb) return false;
  return pa[0] > pb[0];
}
