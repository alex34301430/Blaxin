#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# BLAXIN — Secure One-Command Installer for Linux
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/alex34301430/Blaxin/main/install.sh | bash
#   wget -qO- https://raw.githubusercontent.com/alex34301430/Blaxin/main/install.sh | bash
#
# What it does:
#   1. Detects Linux architecture
#   2. Downloads the latest BLAXIN release from GitHub
#   3. Verifies SHA256 checksum
#   4. Installs to /opt/blaxin (requires sudo)
#   5. Creates desktop integration (.desktop file + icon)
#   6. Verifies installation
#
# Requirements:
#   - Linux x86_64
#   - curl or wget
#   - sudo privileges (for /opt installation)
#
# Security:
#   - Downloads ONLY from official GitHub releases
#   - Verifies SHA256 checksums
#   - No arbitrary code execution from remote sources
#   - Shows exactly what will be installed before proceeding
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────
REPO="alex34301430/Blaxin"
INSTALL_DIR="/opt/blaxin"
BIN_DIR="/usr/local/bin"
DESKTOP_DIR="/usr/share/applications"
ICON_DIR="/usr/share/pixmaps"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── Helper functions ───────────────────────────────────────────────────
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
header()  { echo -e "\n${CYAN}${BOLD}$*${NC}"; }

check_command() {
    command -v "$1" >/dev/null 2>&1
}

# ── Banner ─────────────────────────────────────────────────────────────
echo -e "${CYAN}${BOLD}"
echo "╔══════════════════════════════════════════════════╗"
echo "║                                                  ║"
echo "║          ⚡ BLAXIN Installer ⚡                 ║"
echo "║                                                  ║"
echo "║     Personal AI Desktop Agent for Linux         ║"
echo "║                                                  ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Step 1: Check prerequisites ────────────────────────────────────────
header "Step 1/6: Checking prerequisites"

# Check architecture
ARCH=$(uname -m)
if [ "$ARCH" != "x86_64" ]; then
    error "Unsupported architecture: $ARCH"
    error "BLAXIN currently supports x86_64 Linux only."
    exit 1
fi
success "Architecture: $ARCH"

# Check OS
if ! uname -s | grep -qi "linux"; then
    error "This installer is for Linux only."
    exit 1
fi
success "Operating system: Linux"

# Check for curl or wget
DOWNLOAD_TOOL=""
if check_command curl; then
    DOWNLOAD_TOOL="curl"
elif check_command wget; then
    DOWNLOAD_TOOL="wget"
else
    error "Neither curl nor wget is installed."
    error "Install one of them: sudo apt install curl"
    exit 1
fi
success "Download tool: $DOWNLOAD_TOOL"

# Check sudo
if [ "$EUID" -ne 0 ]; then
    warn "This installer requires sudo privileges to install to $INSTALL_DIR"
    warn "You may be prompted for your password."
fi

# ── Step 2: Get latest release info ────────────────────────────────────
header "Step 2/6: Finding latest release"

GITHUB_API="https://api.github.com/repos/$REPO/releases/latest"

if [ "$DOWNLOAD_TOOL" = "curl" ]; then
    RELEASE_JSON=$(curl -fsSL "$GITHUB_API")
else
    RELEASE_JSON=$(wget -qO- "$GITHUB_API")
fi

if [ -z "$RELEASE_JSON" ]; then
    error "Failed to fetch release information from GitHub."
    error "Check your internet connection and try again."
    exit 1
fi

# Parse version and assets
VERSION=$(echo "$RELEASE_JSON" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
if [ -z "$VERSION" ]; then
    error "Failed to determine release version."
    exit 1
fi

success "Latest version: $VERSION"

# ── Step 3: Download release assets ────────────────────────────────────
header "Step 3/6: Downloading BLAXIN $VERSION"

DOWNLOAD_DIR=$(mktemp -d)
trap "rm -rf $DOWNLOAD_DIR" EXIT

# Find the AppImage asset
APPIMAGE_URL=$(echo "$RELEASE_JSON" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.AppImage"' | head -1 | sed 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
APPIMAGE_NAME=$(basename "$APPIMAGE_URL" 2>/dev/null || echo "")

if [ -z "$APPIMAGE_URL" ]; then
    error "No AppImage found in release $VERSION."
    error "Available assets may not include Linux builds."
    exit 1
fi

info "Downloading: $APPIMAGE_NAME"
info "URL: $APPIMAGE_URL"

if [ "$DOWNLOAD_TOOL" = "curl" ]; then
    curl -fL --progress-bar -o "$DOWNLOAD_DIR/$APPIMAGE_NAME" "$APPIMAGE_URL"
else
    wget -q --show-progress -O "$DOWNLOAD_DIR/$APPIMAGE_NAME" "$APPIMAGE_URL"
fi

if [ ! -f "$DOWNLOAD_DIR/$APPIMAGE_NAME" ]; then
    error "Download failed."
    exit 1
fi
success "Downloaded: $APPIMAGE_NAME"

# ── Step 4: Verify checksum ────────────────────────────────────────────
header "Step 4/6: Verifying checksum"

CHECKSUM_URL="${APPIMAGE_URL}.sha256"
if [ "$DOWNLOAD_TOOL" = "curl" ]; then
    curl -fsSL -o "$DOWNLOAD_DIR/$APPIMAGE_NAME.sha256" "$CHECKSUM_URL" 2>/dev/null || true
else
    wget -q -O "$DOWNLOAD_DIR/$APPIMAGE_NAME.sha256" "$CHECKSUM_URL" 2>/dev/null || true
fi

if [ -f "$DOWNLOAD_DIR/$APPIMAGE_NAME.sha256" ]; then
    EXPECTED_HASH=$(cat "$DOWNLOAD_DIR/$APPIMAGE_NAME.sha256" | awk '{print $1}')
    ACTUAL_HASH=$(sha256sum "$DOWNLOAD_DIR/$APPIMAGE_NAME" | awk '{print $1}')
    
    if [ "$EXPECTED_HASH" = "$ACTUAL_HASH" ]; then
        success "Checksum verified: $ACTUAL_HASH"
    else
        error "Checksum mismatch!"
        error "Expected: $EXPECTED_HASH"
        error "Actual:   $ACTUAL_HASH"
        error "The downloaded file may be corrupted or tampered with."
        error "Aborting installation."
        exit 1
    fi
else
    warn "No checksum file found. Skipping verification."
    warn "This is not ideal — proceed with caution."
fi

# ── Step 5: Install ────────────────────────────────────────────────────
header "Step 5/6: Installing BLAXIN"

# Create directories
sudo mkdir -p "$INSTALL_DIR"
sudo mkdir -p "$BIN_DIR"
sudo mkdir -p "$DESKTOP_DIR"
sudo mkdir -p "$ICON_DIR"

# Make AppImage executable
chmod +x "$DOWNLOAD_DIR/$APPIMAGE_NAME"

# Install AppImage
INSTALL_PATH="$INSTALL_DIR/$APPIMAGE_NAME"
sudo cp "$DOWNLOAD_DIR/$APPIMAGE_NAME" "$INSTALL_PATH"
sudo chmod +x "$INSTALL_PATH"
success "Installed AppImage to $INSTALL_PATH"

# Create wrapper script
WRAPPER="#!/bin/bash
exec \"$INSTALL_PATH\" \"\$@\"
"
echo "$WRAPPER" | sudo tee "$BIN_DIR/blaxin" > /dev/null
sudo chmod +x "$BIN_DIR/blaxin"
success "Created launcher: $BIN_DIR/blaxin"

# Create .desktop file
DESKTOP_FILE="[Desktop Entry]
Type=Application
Name=BLAXIN
GenericName=AI Desktop Agent
Comment=Personal AI Desktop Agent — Control your computer with natural language
Exec=blaxin %U
Icon=blaxin
Terminal=false
Categories=Utility;Development;System;
Keywords=ai;agent;desktop;automation;
StartupWMClass=blaxin
"
echo "$DESKTOP_FILE" | sudo tee "$DESKTOP_DIR/blaxin.desktop" > /dev/null
success "Created desktop entry: $DESKTOP_DIR/blaxin.desktop"

# Extract icon from AppImage (if possible)
if check_command file; then
    APPIMAGE_TYPE=$(file -b "$INSTALL_PATH" 2>/dev/null || echo "")
    if echo "$APPIMAGE_TYPE" | grep -q "ELF"; then
        # Try to extract icon from AppImage
        TMP_MOUNT=$(mktemp -d)
        if "$INSTALL_PATH" --appimage-extract >/dev/null 2>&1; then
            if [ -f "squashfs-root/usr/share/icons/hicolor/256x256/apps/blaxin.png" ]; then
                sudo cp "squashfs-root/usr/share/icons/hicolor/256x256/apps/blaxin.png" "$ICON_DIR/blaxin.png"
                success "Extracted icon"
            elif [ -f "squashfs-root/AppRun.png" ]; then
                sudo cp "squashfs-root/AppRun.png" "$ICON_DIR/blaxin.png"
                success "Extracted icon"
            fi
            rm -rf squashfs-root
        fi
        rm -rf "$TMP_MOUNT"
    fi
fi

# Update desktop database
if check_command update-desktop-database; then
    sudo update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi

# Update icon cache
if check_command gtk-update-icon-cache; then
    sudo gtk-update-icon-cache "$ICON_DIR" 2>/dev/null || true
fi

# ── Step 6: Verify installation ────────────────────────────────────────
header "Step 6/6: Verifying installation"

INSTALLED=true

if [ -f "$INSTALL_PATH" ]; then
    success "AppImage exists: $INSTALL_PATH"
else
    error "AppImage not found at $INSTALL_PATH"
    INSTALLED=false
fi

if [ -x "$BIN_DIR/blaxin" ]; then
    success "Launcher exists: $BIN_DIR/blaxin"
else
    error "Launcher not found at $BIN_DIR/blaxin"
    INSTALLED=false
fi

if [ -f "$DESKTOP_DIR/blaxin.desktop" ]; then
    success "Desktop entry exists: $DESKTOP_DIR/blaxin.desktop"
else
    error "Desktop entry not found"
    INSTALLED=false
fi

# ── Done ───────────────────────────────────────────────────────────────
if [ "$INSTALLED" = true ]; then
    echo ""
    echo -e "${GREEN}${BOLD}"
    echo "╔══════════════════════════════════════════════════╗"
    echo "║                                                  ║"
    echo "║        ⚡ BLAXIN Installed Successfully! ⚡     ║"
    echo "║                                                  ║"
    echo "╚══════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo -e "  Version:    ${BOLD}$VERSION${NC}"
    echo -e "  Installed:  $INSTALL_PATH"
    echo -e "  Launcher:   $BIN_DIR/blaxin"
    echo -e ""
    echo -e "  ${BOLD}To launch:${NC}"
    echo -e "    • Open BLAXIN from your application menu"
    echo -e "    • Or run: ${CYAN}blaxin${NC}"
    echo -e ""
    echo -e "  ${BOLD}First run:${NC}"
    echo -e "    BLAXIN will guide you through setup on first launch."
    echo -e "    You'll configure your AI provider and select a model."
    echo -e ""
else
    echo ""
    error "Installation completed with errors."
    error "BLAXIN may not work correctly."
    error "Try reinstalling or check the error messages above."
    exit 1
fi
