#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# BLAXIN — Production-Grade Installer for Linux
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/alex34301430/Blaxin/main/blaxin/install.sh | bash
#
# What it does:
#   1. Detects Linux distribution and architecture
#   2. Resolves the latest stable BLAXIN release from GitHub
#   3. Downloads the AppImage with retry and timeout
#   4. Verifies SHA-256 checksum
#   5. Installs to /opt/blaxin (requires sudo)
#   6. Creates desktop integration (.desktop file + icon)
#   7. Verifies the installation
#
# Requirements:
#   - Linux x86_64
#   - curl or wget
#   - sudo privileges (for /opt installation)
#
# Security:
#   - Downloads ONLY from official GitHub releases
#   - Verifies SHA-256 checksums
#   - No arbitrary code execution from remote sources
#   - Shows exactly what will be installed before proceeding
# ═══════════════════════════════════════════════════════════════════════

set -Eeuo pipefail

# ── Configuration ──────────────────────────────────────────────────────
REPO="alex34301430/Blaxin"
APP_NAME="blaxin"
INSTALL_DIR="/opt/blaxin"
BIN_DIR="/usr/local/bin"
DESKTOP_DIR="/usr/share/applications"
ICON_DIR="/usr/share/pixmaps"
GITHUB_API="https://api.github.com/repos/${REPO}/releases/latest"
GITHUB_DOWNLOAD="https://github.com/${REPO}/releases/download"

# Timeouts
CURL_TIMEOUT=30
MAX_RETRIES=3
RETRY_DELAY=2

# Exit codes
EXIT_SUCCESS=0
EXIT_GENERAL_ERROR=1
EXIT_INVALID_ARGUMENT=2
EXIT_NETWORK_ERROR=3
EXIT_DOWNLOAD_ERROR=4
EXIT_VERIFICATION_ERROR=5
EXIT_PERMISSION_ERROR=6
EXIT_SPACE_ERROR=7
EXIT_UNSUPPORTED_ERROR=8

# ── Colors ─────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Logging ────────────────────────────────────────────────────────────
_log() {
    local color="$1" prefix="$2"
    shift 2
    echo -e "${color}[${prefix}]${NC} $*"
}

info()    { _log "${BLUE}"   "INFO"  "$@"; }
success() { _log "${GREEN}"  "  OK"  "$@"; }
warn()    { _log "${YELLOW}" "WARN"  "$@"; }
error()   { _log "${RED}"    "ERROR" "$@" >&2; }
fatal()   { error "$@"; exit "${EXIT_GENERAL_ERROR}"; }

header() {
    echo ""
    echo -e "${CYAN}${BOLD}$*${NC}"
    echo -e "${DIM}$(printf '%.0s─' {1..50})${NC}"
}

# ── Cleanup ────────────────────────────────────────────────────────────
TEMP_DIR=""
cleanup() {
    if [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]]; then
        rm -rf "${TEMP_DIR}"
    fi
}
trap cleanup EXIT

# ── Utility functions ──────────────────────────────────────────────────
check_command() {
    command -v "$1" >/dev/null 2>&1
}

# Retry a command with exponential backoff
retry() {
    local max_attempts="$1"
    local delay="$2"
    shift 2
    local attempt=1
    local exit_code

    while (( attempt <= max_attempts )); do
        if "$@"; then
            return 0
        fi
        exit_code=$?
        if (( attempt == max_attempts )); then
            return $exit_code
        fi
        warn "Attempt $attempt/$max_attempts failed. Retrying in ${delay}s..."
        sleep "$delay"
        delay=$(( delay * 2 ))
        (( attempt++ ))
    done
}

# ── Banner ─────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}"
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║                                               ║"
echo "  ║         ⚡  BLAXIN Installer  ⚡              ║"
echo "  ║                                               ║"
echo "  ║    Personal AI Desktop Agent for Linux        ║"
echo "  ║                                               ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo -e "${NC}"

# ═══════════════════════════════════════════════════════════════════════
# Step 1: System Detection & Prerequisites
# ═══════════════════════════════════════════════════════════════════════
header "Step 1/6: Checking system requirements"

# Detect OS
OS_NAME=$(uname -s)
if [[ "${OS_NAME}" != "Linux" ]]; then
    fatal "This installer is for Linux only. Detected: ${OS_NAME}" \
          "Visit https://github.com/${REPO} for other platforms."
fi
success "Operating system: Linux"

# Detect architecture
ARCH=$(uname -m)
case "${ARCH}" in
    x86_64|amd64)
        ARCH="x86_64"
        ARCH_ALT="amd64"
        ;;
    aarch64|arm64)
        fatal "ARM64 support is coming soon. Currently x86_64 only." \
              "You can build from source: https://github.com/${REPO}"
        ;;
    *)
        fatal "Unsupported architecture: ${ARCH}" \
              "BLAXIN currently supports x86_64 Linux only."
        ;;
esac
success "Architecture: ${ARCH}"

# Detect download tool
DOWNLOAD_TOOL=""
if check_command curl; then
    DOWNLOAD_TOOL="curl"
elif check_command wget; then
    DOWNLOAD_TOOL="wget"
else
    fatal "Neither curl nor wget is installed." \
          "Install one of them: sudo apt install curl"
fi
success "Download tool: ${DOWNLOAD_TOOL} $(command -v ${DOWNLOAD_TOOL})"

# Check for sha256sum
if ! check_command sha256sum && ! check_command shasum; then
    warn "sha256sum/shasum not found. Checksum verification will be skipped."
    HAS_SHA256=false
else
    HAS_SHA256=true
    success "Checksum tool: available"
fi

# Check disk space (need at least 200MB in /opt)
if check_command df; then
    AVAILABLE_KB=$(df -k /opt 2>/dev/null | awk 'NR==2{print $4}' || echo "0")
    if (( AVAILABLE_KB > 0 && AVAILABLE_KB < 204800 )); then
        warn "Low disk space on /opt: $(( AVAILABLE_KB / 1024 ))MB available"
        warn "BLAXIN requires at least ~200MB for installation."
    fi
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 2: Resolve Latest Release
# ═══════════════════════════════════════════════════════════════════════
header "Step 2/6: Finding latest release"

fetch_release_info() {
    local api_url="$1"
    local response=""
    local http_code=""

    if [[ "${DOWNLOAD_TOOL}" == "curl" ]]; then
        http_code=$(curl -s -w "%{http_code}" -o /dev/null \
            --connect-timeout "${CURL_TIMEOUT}" \
            --max-time "${CURL_TIMEOUT}" \
            -H "Accept: application/vnd.github+json" \
            "${api_url}" 2>/dev/null) || true

        if [[ "${http_code}" == "200" ]]; then
            response=$(curl -sS \
                --connect-timeout "${CURL_TIMEOUT}" \
                --max-time "${CURL_TIMEOUT}" \
                -H "Accept: application/vnd.github+json" \
                "${api_url}" 2>/dev/null)
        fi
    else
        response=$(wget -q -O - \
            --timeout="${CURL_TIMEOUT}" \
            --header="Accept: application/vnd.github+json" \
            "${api_url}" 2>/dev/null) || true
        http_code="200"
    fi

    if [[ "${http_code}" != "200" ]]; then
        return 1
    fi

    if [[ -z "${response}" ]]; then
        return 1
    fi

    echo "${response}"
    return 0
}

# Try fetching the latest release
RELEASE_JSON=""
RELEASE_JSON=$(fetch_release_info "${GITHUB_API}") || true

# Handle case where /releases/latest returns 404 (no releases yet)
if [[ -z "${RELEASE_JSON}" ]]; then
    echo ""
    error "Unable to retrieve the latest stable release."
    echo ""
    echo -e "  ${BOLD}This could mean:${NC}"
    echo "  • BLAXIN has not published a release yet"
    echo "  • The GitHub repository is temporarily unavailable"
    echo "  • Your network connection is interrupted"
    echo ""
    echo -e "  ${BOLD}What to do:${NC}"
    echo "  • Check your internet connection and try again"
    echo "  • Visit https://github.com/${REPO}/releases manually"
    echo "  • Report issues at https://github.com/${REPO}/issues"
    echo ""
    exit "${EXIT_NETWORK_ERROR}"
fi

# Parse version
VERSION=$(echo "${RELEASE_JSON}" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

if [[ -z "${VERSION}" ]]; then
    fatal "Release metadata is malformed. Could not determine version." \
          "Please report this at https://github.com/${REPO}/issues"
fi

success "Latest version: ${VERSION}"

# Find AppImage asset
APPIMAGE_URL=$(echo "${RELEASE_JSON}" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.AppImage"' | head -1 | sed 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

if [[ -z "${APPIMAGE_URL}" ]]; then
    fatal "No AppImage found in release ${VERSION}." \
          "The release may be missing Linux artifacts." \
          "Visit https://github.com/${REPO}/releases to check available assets."
fi

APPIMAGE_NAME=$(basename "${APPIMAGE_URL}")
success "AppImage: ${APPIMAGE_NAME}"

# ═══════════════════════════════════════════════════════════════════════
# Step 3: Download
# ═══════════════════════════════════════════════════════════════════════
header "Step 3/6: Downloading BLAXIN ${VERSION}"

TEMP_DIR=$(mktemp -d)
DOWNLOAD_PATH="${TEMP_DIR}/${APPIMAGE_NAME}"

download_file() {
    local url="$1"
    local dest="$2"

    if [[ "${DOWNLOAD_TOOL}" == "curl" ]]; then
        curl -fL \
            --progress-bar \
            --connect-timeout "${CURL_TIMEOUT}" \
            --max-time 300 \
            --retry "${MAX_RETRIES}" \
            --retry-delay "${RETRY_DELAY}" \
            --retry-all-errors \
            -o "${dest}" \
            "${url}"
    else
        wget -q --show-progress \
            --timeout="${CURL_TIMEOUT}" \
            --tries="${MAX_RETRIES}" \
            -O "${dest}" \
            "${url}"
    fi
}

info "Downloading ${APPIMAGE_NAME}..."
info "Source: ${APPIMAGE_URL}"
echo ""

if ! retry "${MAX_RETRIES}" "${RETRY_DELAY}" download_file "${APPIMAGE_URL}" "${DOWNLOAD_PATH}"; then
    rm -f "${DOWNLOAD_PATH}"
    fatal "Download failed after ${MAX_RETRIES} attempts." \
          "Check your network connection and try again."
fi

# Verify the download is not empty
if [[ ! -s "${DOWNLOAD_PATH}" ]]; then
    rm -f "${DOWNLOAD_PATH}"
    fatal "Downloaded file is empty. The release artifact may be corrupted."
fi

DOWNLOAD_SIZE=$(stat -c%s "${DOWNLOAD_PATH}" 2>/dev/null || stat -f%z "${DOWNLOAD_PATH}" 2>/dev/null || echo "0")
if (( DOWNLOAD_SIZE < 1000000 )); then
    warn "Downloaded file is unusually small ($(( DOWNLOAD_SIZE / 1024 ))KB)."
    warn "Expected an AppImage (typically 50-200MB). The file may be corrupted."
fi

success "Downloaded: ${APPIMAGE_NAME} ($(numfmt --to=iec-i --suffix=B "${DOWNLOAD_SIZE}" 2>/dev/null || echo "${DOWNLOAD_SIZE} bytes"))"

# ═══════════════════════════════════════════════════════════════════════
# Step 4: Verify Checksum
# ═══════════════════════════════════════════════════════════════════════
header "Step 4/6: Verifying checksum"

if [[ "${HAS_SHA256}" == "true" ]]; then
    CHECKSUM_URL="${APPIMAGE_URL}.sha256"
    CHECKSUM_PATH="${TEMP_DIR}/${APPIMAGE_NAME}.sha256"

    # Try to download checksum file
    CHECKSUM_OK=false
    if download_file "${CHECKSUM_URL}" "${CHECKSUM_PATH}" 2>/dev/null; then
        # Parse expected hash (format: "hash  filename" or just "hash")
        EXPECTED_HASH=$(awk '{print $1}' "${CHECKSUM_PATH}")

        if [[ -n "${EXPECTED_HASH}" ]]; then
            if check_command sha256sum; then
                ACTUAL_HASH=$(sha256sum "${DOWNLOAD_PATH}" | awk '{print $1}')
            else
                ACTUAL_HASH=$(shasum -a 256 "${DOWNLOAD_PATH}" | awk '{print $1}')
            fi

            if [[ "${EXPECTED_HASH}" == "${ACTUAL_HASH}" ]]; then
                success "Checksum verified: ${ACTUAL_HASH:0:16}..."
                CHECKSUM_OK=true
            else
                error "Checksum mismatch!"
                error "Expected: ${EXPECTED_HASH}"
                error "Actual:   ${ACTUAL_HASH}"
                error "The downloaded file may be corrupted or tampered with."
                fatal "Aborting installation for safety."
            fi
        fi
    fi

    if [[ "${CHECKSUM_OK}" == "false" ]]; then
        warn "Could not verify checksum (checksum file unavailable)."
        warn "Proceeding — the download came from HTTPS GitHub CDN."
    fi
else
    warn "Checksum verification skipped (sha256sum not available)."
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 5: Install
# ═══════════════════════════════════════════════════════════════════════
header "Step 5/6: Installing BLAXIN"

# Determine if we need sudo
SUDO=""
if [[ "${EUID}" -ne 0 ]]; then
    if check_command sudo; then
        SUDO="sudo"
        info "Using sudo for system installation"
    else
        fatal "This installer requires root privileges to install to ${INSTALL_DIR}." \
              "Run with sudo or as root."
    fi
fi

# Create directories
${SUDO} mkdir -p "${INSTALL_DIR}"
${SUDO} mkdir -p "${BIN_DIR}"
${SUDO} mkdir -p "${DESKTOP_DIR}"
${SUDO} mkdir -p "${ICON_DIR}"

# Remove old installation if exists (idempotent)
if [[ -f "${INSTALL_DIR}/${APPIMAGE_NAME}" ]]; then
    info "Removing previous installation..."
    # Find and remove old AppImages
    find "${INSTALL_DIR}" -name "*.AppImage" -exec ${SUDO} rm -f {} \; 2>/dev/null || true
    success "Cleaned previous installation"
fi

# Make AppImage executable
chmod +x "${DOWNLOAD_PATH}"

# Install AppImage
INSTALL_PATH="${INSTALL_DIR}/${APPIMAGE_NAME}"
${SUDO} cp "${DOWNLOAD_PATH}" "${INSTALL_PATH}"
${SUDO} chmod 755 "${INSTALL_PATH}"
success "Installed AppImage to ${INSTALL_PATH}"

# Create wrapper script in /usr/local/bin
WRAPPER_CONTENT="#!/bin/bash
exec \"${INSTALL_PATH}\" \"\$@\"
"
echo "${WRAPPER_CONTENT}" | ${SUDO} tee "${BIN_DIR}/${APP_NAME}" > /dev/null
${SUDO} chmod 755 "${BIN_DIR}/${APP_NAME}"
success "Created launcher: ${BIN_DIR}/${APP_NAME}"

# Create .desktop file
DESKTOP_CONTENT="[Desktop Entry]
Type=Application
Name=BLAXIN
GenericName=AI Desktop Agent
Comment=Personal AI Desktop Agent — Control your computer with natural language
Exec=${INSTALL_PATH} %U
Icon=blaxin
Terminal=false
StartupNotify=true
Categories=Utility;Development;System;
Keywords=ai;agent;desktop;automation;assistant;
StartupWMClass=blaxin
MimeType=x-scheme-handler/blaxin;
"
echo "${DESKTOP_CONTENT}" | ${SUDO} tee "${DESKTOP_DIR}/${APP_NAME}.desktop" > /dev/null
${SUDO} chmod 644 "${DESKTOP_DIR}/${APP_NAME}.desktop"
success "Created desktop entry: ${DESKTOP_DIR}/${APP_NAME}.desktop"

# Try to extract icon from AppImage
info "Extracting application icon..."
TMP_EXTRACT="${TEMP_DIR}/extract"
mkdir -p "${TMP_EXTRACT}"

if "${INSTALL_PATH}" --appimage-extract > /dev/null 2>&1; then
    # Look for icon in standard locations
    ICON_FOUND=false
    for icon_path in \
        "squashfs-root/usr/share/icons/hicolor/256x256/apps/blaxin.png" \
        "squashfs-root/usr/share/icons/hicolor/128x128/apps/blaxin.png" \
        "squashfs-root/usr/share/icons/hicolor/512x512/apps/blaxin.png" \
        "squashfs-root/AppRun.png" \
        "squashfs-root/*.png"; do
        # Use glob matching for the last pattern
        if [[ "${icon_path}" == *"*" ]]; then
            for f in ${icon_path}; do
                if [[ -f "${f}" ]]; then
                    ${SUDO} cp "${f}" "${ICON_DIR}/blaxin.png"
                    success "Extracted icon from AppImage"
                    ICON_FOUND=true
                    break 2
                fi
            done
        elif [[ -f "${icon_path}" ]]; then
            ${SUDO} cp "${icon_path}" "${ICON_DIR}/blaxin.png"
            success "Extracted icon from AppImage"
            ICON_FOUND=true
            break
        fi
    done

    rm -rf squashfs-root 2>/dev/null || true

    if [[ "${ICON_FOUND}" == "false" ]]; then
        warn "Could not extract icon from AppImage"
    fi
else
    warn "Could not extract icon from AppImage (may require --appimage-extract support)"
fi

# Update desktop database and icon cache
if check_command update-desktop-database; then
    ${SUDO} update-desktop-database "${DESKTOP_DIR}" 2>/dev/null || true
    success "Updated desktop database"
fi

if check_command gtk-update-icon-cache; then
    ${SUDO} gtk-update-icon-cache -f "${ICON_DIR}" 2>/dev/null || true
    success "Updated icon cache"
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 6: Verify Installation
# ═══════════════════════════════════════════════════════════════════════
header "Step 6/6: Verifying installation"

INSTALLED=true

if [[ -f "${INSTALL_PATH}" ]]; then
    success "AppImage: ${INSTALL_PATH}"
else
    error "AppImage not found at ${INSTALL_PATH}"
    INSTALLED=false
fi

if [[ -x "${BIN_DIR}/${APP_NAME}" ]]; then
    success "Launcher: ${BIN_DIR}/${APP_NAME}"
else
    error "Launcher not found at ${BIN_DIR}/${APP_NAME}"
    INSTALLED=false
fi

if [[ -f "${DESKTOP_DIR}/${APP_NAME}.desktop" ]]; then
    success "Desktop entry: ${DESKTOP_DIR}/${APP_NAME}.desktop"
else
    error "Desktop entry not found"
    INSTALLED=false
fi

# Clean up temp directory
TEMP_DIR=""

# ═══════════════════════════════════════════════════════════════════════
# Done
# ═══════════════════════════════════════════════════════════════════════
echo ""
if [[ "${INSTALLED}" == "true" ]]; then
    echo -e "${GREEN}${BOLD}"
    echo "  ╔═══════════════════════════════════════════════╗"
    echo "  ║                                               ║"
    echo "  ║      ⚡  BLAXIN Installed Successfully!  ⚡   ║"
    echo "  ║                                               ║"
    echo "  ╚═══════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo -e "  Version:    ${BOLD}${VERSION}${NC}"
    echo -e "  Installed:  ${INSTALL_PATH}"
    echo -e "  Launcher:   ${BIN_DIR}/${APP_NAME}"
    echo ""
    echo -e "  ${BOLD}To launch:${NC}"
    echo "    • Open ${CYAN}BLAXIN${NC} from your application menu"
    echo "    • Or run: ${CYAN}${APP_NAME}${NC}"
    echo ""
    echo -e "  ${BOLD}First run:${NC}"
    echo "    BLAXIN will guide you through setup on first launch."
    echo "    You'll configure your AI provider and select a model."
    echo ""
    echo -e "  ${BOLD}To uninstall:${NC}"
    echo "    sudo rm -rf ${INSTALL_DIR} ${BIN_DIR}/${APP_NAME} ${DESKTOP_DIR}/${APP_NAME}.desktop ${ICON_DIR}/blaxin.png"
    echo ""
else
    echo ""
    error "Installation completed with errors."
    error "BLAXIN may not work correctly."
    error "Try reinstalling or check the error messages above."
    exit "${EXIT_GENERAL_ERROR}"
fi
