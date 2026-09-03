// BLAXIN data directory resolution
// =============================================================
// All runtime state (config, encrypted credentials, session state)
// must live in a *writable, persistent* location:
//
//   - When BLAXIN_DATA_DIR is set (explicitly configured), use it.
//   - Desktop (Tauri / system service): default to the XDG data dir
//     (~/.local/share/blaxin). The packaged AppImage resources are a
//     read-only squashfs mount, so writing next to the executable (the
//     old cwd-relative default) silently fails there.
//   - Development / CI: keep the historic cwd-relative behaviour so
//     existing workflows and .gitignore rules keep working.
//
// Precedence: BLAXIN_DATA_DIR > BLAXIN_STATE_DIR(cwd-relative, legacy)
// > ~/.local/share/blaxin when HOME exists and the cwd is not writable
// or we are running under a packaged desktop build (indicated by the
// BLAXIN_DESKTOP env var set by the Tauri shell) > cwd.
// =============================================================

import { existsSync, mkdirSync, accessSync, constants } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';

function cwdWritable(): boolean {
  try {
    const cwd = process.cwd();
    accessSync(cwd, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveDataDir(): string {
  // 1. Explicit configuration wins.
  const configured = process.env.BLAXIN_DATA_DIR;
  if (configured && configured.trim()) {
    return resolve(isAbsolute(configured) ? configured : join(process.cwd(), configured));
  }

  // 2. Packaged desktop build: the bundled server's cwd points into the
  //    (often read-only) AppImage mount, so always use the user data dir.
  if (process.env.BLAXIN_DESKTOP === '1') {
    const xdg = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim()
      ? process.env.XDG_DATA_HOME
      : join(homedir(), '.local', 'share');
    return join(xdg, 'blaxin');
  }

  // 3. Dev/CI/container: prefer cwd-relative legacy behaviour when writable,
  //    otherwise fall back to the user data dir.
  if (cwdWritable()) {
    return process.cwd();
  }
  const xdg = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim()
    ? process.env.XDG_DATA_HOME
    : join(homedir(), '.local', 'share');
  return join(xdg, 'blaxin');
}

let dataDirCache: string | null = null;

export function getDataDir(): string {
  if (!dataDirCache) {
    dataDirCache = resolveDataDir();
    try {
      mkdirSync(dataDirCache, { recursive: true, mode: 0o700 });
    } catch (error: any) {
      logger.error('paths', `Failed to create data directory ${dataDirCache}: ${error.message}`);
    }
  }
  return dataDirCache;
}

/** Resolve a runtime data file/dir under the data directory. */
export function dataPath(...segments: string[]): string {
  return join(getDataDir(), ...segments);
}

/** True when the supplied path already exists on disk. */
export function dataPathExists(...segments: string[]): boolean {
  return existsSync(dataPath(...segments));
}
