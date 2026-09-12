// Secret-hygiene regression guard (directive §2/§29)
// =============================================================
// A runtime Ed25519 identity file (body-identity.json, containing a
// PRIVATE key) was once created inside the source tree by a dev run
// whose data dir resolved to cwd. It was never committed — this test
// exists to keep it that way, forever, at the git layer:
//   1. no file matching secret patterns may be git-tracked;
//   2. the .gitignore patterns covering those names must exist and
//      actually match (so a future .gitignore edit cannot silently
//      drop the protection);
//   3. worktree secret files, if present, must be ignored.
//
// The blaxin project may be the git root OR a subdirectory of a larger
// workspace repo, so the project root is located by its .gitignore,
// and all git pathspecs are issued relative to it.
// =============================================================

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

/** Files whose NAME matches a secret pattern must never be tracked. */
const SECRET_NAME_PATTERNS: RegExp[] = [
  /(^|\/)body-identity\.json$/,
  /(^|\/)brain-identity\.json$/,
  /(^|\/)\.blaxin-credentials$/,
  /(^|\/)blaxin-config\.json$/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  /\.kdbx$/,
];

/** Probes (relative to the blaxin project root) that must be ignored. */
const MUST_IGNORE_PATHS = [
  'server/body-identity.json',
  'server/brain-identity.json',
  'server/.blaxin-credentials',
  'client/body-identity.json',
];

/** Run git with cwd set to dir; return trimmed stdout (null on failure). */
function git(args: string[], dir: string): string | null {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Walk up from the test's cwd to the nearest directory whose .gitignore
 * contains the runtime-identity patterns — that is the blaxin project
 * root regardless of how the workspace repo is laid out.
 */
function findProjectRoot(): string | null {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    const gi = join(dir, '.gitignore');
    if (existsSync(gi) && /body-identity\.json/.test(readFileSync(gi, 'utf-8'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

describe('git secret hygiene (no private keys in the repository)', () => {
  const projectRoot = findProjectRoot();

  it('locates the blaxin project root (guard so the test is meaningful)', () => {
    expect(projectRoot).toBeTruthy();
    expect(git(['rev-parse', '--show-toplevel'], projectRoot!)).toBeTruthy();
  });

  it('has no tracked file matching a secret/identity pattern', () => {
    const tracked = git(['ls-files'], projectRoot!)!.split('\n').filter(Boolean);
    const offenders = tracked.filter((f) => SECRET_NAME_PATTERNS.some((re) => re.test(f)));
    expect(offenders, `secret-like files must never be tracked: ${offenders.join(', ')}`).toEqual([]);
  });

  it('runtime identity/credential files, if created in the worktree, are ignored', () => {
    // check-ignore works on paths that do not exist — exactly the
    // prevention we want (the field leak was an untracked-but-ignored-
    // late file).
    const out = git(['check-ignore', '-v', '--', ...MUST_IGNORE_PATHS], projectRoot!);
    const ignored = new Set((out ?? '').split('\n').filter(Boolean).map((line) => {
      // "<source>:<linenum>:<pattern>\t<path>"
      const pathPart = line.split('\t')[1] ?? '';
      return pathPart;
    }));
    for (const p of MUST_IGNORE_PATHS) {
      expect(ignored, `${p} must be git-ignored`).toContain(p);
    }
  });
});
