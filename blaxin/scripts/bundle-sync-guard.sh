#!/usr/bin/env bash
# Guard against shipping a stale bundled server.
#
# CI (release.yml) prepares blaxin/resources/blaxin-server itself: it builds
# server/dist fresh, copies it in, and runs `npm install --omit=dev`. For
# LOCAL builds the sync was a manual step and was silently skipped since
# v1.3.0 — the v1.4.0 .deb built on this machine contained a Sep-9 dist with
# none of the memory/tool work. This guard runs as the Tauri
# beforeBuildCommand: if the local server build output is newer than the
# bundled copy (or the bundled copy is missing), it re-syncs dist + package
# manifests. CI is a no-op here because its resources were prepared seconds
# earlier.
#
# Refuses to bundle when neither side has a dist at all.

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIST="$ROOT/server/dist"
SRC_PKG="$ROOT/server/package.json"
SRC_LOCK="$ROOT/server/package-lock.json"
DST="$ROOT/resources/blaxin-server"

fail() { echo "bundle-sync-guard: $1" >&2; exit 1; }

[ -d "$SRC_DIST" ] || fail "server/dist does not exist. Run: cd server && npm run build"
[ -f "$DST/node_modules/ws/package.json" ] || fail "resources/blaxin-server has no node_modules. Run CI-equivalent prep: rm -rf resources/blaxin-server && mkdir -p resources/blaxin-server/dist && cp -r server/dist/* resources/blaxin-server/dist/ && cp server/package.json server/package-lock.json resources/blaxin-server/ && cd resources/blaxin-server && npm install --omit=dev"

needs_sync=0
if [ ! -d "$DST/dist" ]; then
  needs_sync=1
elif [ "$(find "$SRC_DIST" -name '*.js' -newer "$DST/dist" -print -quit)" ]; then
  needs_sync=1
fi

if [ "$needs_sync" = "1" ]; then
  echo "bundle-sync-guard: server/dist is newer than the bundled copy — syncing"
  rm -rf "$DST/dist"
  cp -r "$SRC_DIST" "$DST/dist"
  cp "$SRC_PKG" "$DST/package.json"
  [ -f "$SRC_LOCK" ] && cp "$SRC_LOCK" "$DST/package-lock.json"
  echo "bundle-sync-guard: synced server dist + manifests into resources/blaxin-server"
else
  echo "bundle-sync-guard: bundled server dist is current"
fi
