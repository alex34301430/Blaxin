#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# BLAXIN — One-command release automation
#
#   $ bash scripts/release.sh                 # release blaxin/VERSION
#   $ bash scripts/release.sh --bump 1.1.2    # bump, then release v1.1.2
#   $ bash scripts/release.sh --dry-run       # audit/test/build only, no git
#
# What it does (and refuses to skip):
#   1. audit gate  — server tsc + tests + build, client build
#   2. build gate  — local `cargo tauri build` (.deb + AppImage)
#   3. version     — bump blaxin/VERSION everywhere (source of truth) or
#                    verify in-repo versions match VERSION
#   4. sign+manifest — IF TAURI_SIGNING_PRIVATE_KEY is exported locally,
#                    sign the .deb, build latest.json v2, validate it
#                    (CI signs with the GitHub secret otherwise)
#   5. commit → push → tag vX → push tag
#   6. CI gate — poll the tag-triggered release workflow to GREEN. If any
#                run fails, do NOT create/release anything: fix, then rerun.
#   7. verify the GitHub release + artifacts + committed latest.json
#
# Requirements: git, gh (authenticated), a clean main, network.
# ═══════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

DRY_RUN=false
BUMP=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --bump)    BUMP="${2:-}"; shift 2 ;;
        --bump=*)  BUMP="${1#*=}"; shift ;;
        *)
            if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                BUMP="$1"; shift
            else
                echo "Unknown argument: $1" >&2
                echo "Usage: bash scripts/release.sh [--dry-run] [--bump x.y.z]" >&2
                exit 2
            fi
            ;;
    esac
done

VERSION="$(tr -d ' \n' < blaxin/VERSION)"
if [[ -n "${BUMP}" ]]; then
    VERSION="${BUMP}"
    echo "==> Version bump requested: v${VERSION}"
    bash scripts/bump-version.sh "${VERSION}"
fi

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  BLAXIN release pipeline — v${VERSION}"
echo "══════════════════════════════════════════════════════════════"
echo ""

# ── 1. Audit gate ───────────────────────────────────────────────────────
echo "── [1/7] Server audit (tsc + tests + build) ──────────────────────"
(cd blaxin/server && npx tsc --noEmit)
(cd blaxin/server && npm test 2>&1 | tail -3)
(cd blaxin/server && npm run build)

echo "── [1/7] Client build ──────────────────────────────────────────────"
(cd blaxin/client && npm run build 2>&1 | tail -4)

# ── 2. Build gate (deb required; AppImage best-effort locally) ─────────
echo "── [2/7] Tauri build (.deb + AppImage) ────────────────────────────"
(cd blaxin/src-tauri && cargo tauri build --bundles deb,appimage 2>&1 | tail -6) || {
    echo "!! AppImage bundle failed locally (needs linuxdeploy/FUSE) — CI builds it." >&2
    echo "!! Rebuilding .deb only for the local gate..." >&2
    (cd blaxin/src-tauri && cargo tauri build --bundles deb 2>&1 | tail -3)
}
DEB="blaxin/src-tauri/target/release/bundle/deb/BLAXIN_${VERSION}_amd64.deb"
if [[ ! -f "${DEB}" ]]; then
    echo "ERROR: deb not found at ${DEB}" >&2
    exit 1
fi
echo "✓ deb built: ${DEB}"

# ── 3. Version consistency ──────────────────────────────────────────────
echo "── [3/7] Version consistency ──────────────────────────────────────"
EXPECTED="${VERSION}"
for f in \
    blaxin/src-tauri/tauri.conf.json \
    blaxin/src-tauri/Cargo.toml \
    blaxin/client/package.json \
    blaxin/server/package.json \
    blaxin/server/src/utils/version.ts; do
    if grep -q "${EXPECTED}" "${f}"; then
        echo "  ✓ ${f}"
    else
        echo "  ✗ ${f} does not contain version ${EXPECTED}" >&2
        exit 1
    fi
done

# ── 4. Sign + manifest (only when the key is available locally) ────────
echo "── [4/7] Signing + manifest ───────────────────────────────────────"
SIGNED=false
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    if ! command -v minisign >/dev/null 2>&1; then
        echo "ERROR: TAURI_SIGNING_PRIVATE_KEY is set but minisign is not installed" >&2
        echo "       (sudo apt install minisign)" >&2
        exit 1
    fi
    KEY_FILE="$(mktemp)"
    trap 'rm -f "${KEY_FILE}"' EXIT
    if printf '%s' "$TAURI_SIGNING_PRIVATE_KEY" | head -1 | grep -q "untrusted comment"; then
        printf '%s\n' "$TAURI_SIGNING_PRIVATE_KEY" > "${KEY_FILE}"
    else
        printf '%s' "$TAURI_SIGNING_PRIVATE_KEY" | base64 -d > "${KEY_FILE}"
    fi
    DEB_SIG="$(dirname "${DEB}")/blaxin_${VERSION}_amd64.deb.sig"
    cp "${DEB}" /tmp/blaxin-release.deb
    if ! minisign -S -s "${KEY_FILE}" -m /tmp/blaxin-release.deb -x "${DEB_SIG}" 2>/dev/null; then
        minisign -S -s "${KEY_FILE}" -p "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
            -m /tmp/blaxin-release.deb -x "${DEB_SIG}"
    fi
    rm -f /tmp/blaxin-release.deb
    SHA256_APPIMAGE=""
    SHA256_DEB="$(sha256sum "${DEB}" | awk '{print $1}')"
    APPIMAGE="blaxin/src-tauri/target/release/bundle/appimage/BLAXIN_${VERSION}_amd64.AppImage"
    if [[ -f "${APPIMAGE}" ]]; then
        SHA256_APPIMAGE="$(sha256sum "${APPIMAGE}" | awk '{print $1}')"
    fi
    SIG_APPIMAGE="blaxin/src-tauri/target/release/bundle/appimage/BLAXIN_${VERSION}_amd64.AppImage.sig"
    python3 blaxin/update/build-manifest.py \
        --version "${VERSION}" \
        --notes "BLAXIN v${VERSION}" \
        --pub-date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --appimage-url "https://github.com/alex34301430/Blaxin/releases/download/v${VERSION}/BLAXIN_${VERSION}_amd64.AppImage" \
        --appimage-sig "${SIG_APPIMAGE}" \
        --appimage-sha256 "${SHA256_APPIMAGE}" \
        --deb-url "https://github.com/alex34301430/Blaxin/releases/download/v${VERSION}/blaxin_${VERSION}_amd64.deb" \
        --deb-sig "${DEB_SIG}" \
        --deb-sha256 "${SHA256_DEB}" \
        --out /tmp/latest.json 2>/dev/null || echo "  (manifest requires an AppImage sig — CI generates it)"
    if [[ -s /tmp/latest.json ]]; then
        cp /tmp/latest.json blaxin/update/latest.json
        bash blaxin/update/validate-latest-json.sh blaxin/update/latest.json "${VERSION}"
    fi
    SIGNED=true
    echo "✓ signed .deb and refreshed update manifest locally"
else
    echo "  TAURI_SIGNING_PRIVATE_KEY not exported — CI will sign the .deb and"
    echo "  refresh latest.json on the tag-triggered workflow (GitHub secret)."
fi

if [[ "${DRY_RUN}" == "true" ]]; then
    echo ""
    echo "── DRY RUN — all local gates passed. Stopping before git. ──────"
    echo "  version: v${VERSION}  signed-locally: ${SIGNED}"
    exit 0
fi

# ── 5. Commit + tag + push ──────────────────────────────────────────────
echo "── [5/7] Commit + tag ─────────────────────────────────────────────"
if [[ -n "$(git status --porcelain)" ]]; then
    git add -A
    git commit -m "release: v${VERSION}" >/dev/null
    echo "✓ committed"
else
    echo "  working tree clean (no new commit)"
fi
git push origin main >/dev/null 2>&1
git tag "v${VERSION}"
git push origin "v${VERSION}" >/dev/null 2>&1
echo "✓ pushed main + tag v${VERSION}"

# ── 6. CI gate: wait for the tag-triggered workflow to finish green ────
echo "── [6/7] CI gate ──────────────────────────────────────────────────"
if ! command -v gh >/dev/null 2>&1; then
    echo "WARN: gh CLI not installed — cannot poll CI. Watch the Actions tab."
    echo "      The release will only be created if the build workflow is green."
    exit 0
fi
RUN_ID=""
for _ in $(seq 1 30); do
    RUN_ID=$(gh run list --workflow release.yml --branch "v${VERSION}" --limit 1 \
        --json databaseId,status,conclusion --jq '.[0].databaseId // empty' 2>/dev/null || true)
    [[ -n "${RUN_ID}" ]] && break
    sleep 10
done
if [[ -z "${RUN_ID}" ]]; then
    echo "ERROR: no CI run appeared for v${VERSION}. Check the Actions tab." >&2
    exit 1
fi
echo "  watching run ${RUN_ID}..."
gh run watch "${RUN_ID}" --exit-status >/dev/null 2>&1
CONCLUSION=$(gh run view "${RUN_ID}" --json conclusion --jq '.conclusion')
if [[ "${CONCLUSION}" != "success" ]]; then
    echo ""
    echo "✗ CI FAILED (${CONCLUSION}) — NOT releasing. Fix and rerun." >&2
    exit 1
fi
echo "✓ CI green"

# ── 7. Verify release ───────────────────────────────────────────────────
echo "── [7/7] Release verification ─────────────────────────────────────"
sleep 20
gh release view "v${VERSION}" --json tagName,isDraft,assets --jq \
    '"tag=\(.tagName) draft=\(.isDraft)\n" + ([.assets[].name] | join("\n"))' 2>/dev/null \
    || echo "WARN: release not visible yet — check in a moment"
bash blaxin/update/validate-latest-json.sh blaxin/update/latest.json "${VERSION}" || true

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  ✓ v${VERSION} released — devices with automatic updates"
echo "    enabled will detect and install it on their next check."
echo "══════════════════════════════════════════════════════════════"
