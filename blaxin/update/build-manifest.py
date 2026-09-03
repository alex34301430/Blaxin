#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════
# BLAXIN — build the signed update manifest (blaxin/update/latest.json)
#
# Manifest v2 format:
#   version            e.g. "1.1.1"
#   notes              short release note (Tauri updater dialog text)
#   pub_date           ISO-8601 UTC publish time
#   platforms:
#     linux-x86_64:    Tauri updater (AppImage) entry
#       url            https://github.com/alex34301430/Blaxin/releases/download/...
#       signature      single-line base64 of the minisign signature text
#       sha256         hex sha256 of the AppImage
#   deb:               BLAXIN .deb self-updater entry
#     url              https://github.com/.../blaxin_<version>_amd64.deb
#     signature        base64 of the minisign signature text (or raw text)
#     sha256           hex sha256 of the .deb
#
# The signature must be created with the same minisign key as the Tauri
# updater public key embedded in src-tauri/tauri.conf.json, so the desktop
# app can verify both artifact types with one key.
#
# Usage (all paths/URLs required unless noted):
#   python3 build-manifest.py \
#     --version 1.1.1 \
#     --notes "BLAXIN v1.1.1" \
#     --pub-date 2026-09-03T00:00:00Z \
#     --appimage-url ... --appimage-sig <file-or-b64> --appimage-sha256 ... \
#     [--deb-url ... --deb-sig <file-or-b64> --deb-sha256 ...] \
#     --out latest.json
# ═══════════════════════════════════════════════════════════════════════
import argparse
import base64
import json
import sys


def load_sig(value: str) -> str:
    """Accept a path to a signature file or an inline signature value.
    Keep single-line base64 values as-is; embed multi-line text verbatim
    (JSON handles the newlines; the verifier accepts both encodings)."""
    if value.startswith(("untrusted comment:", "dW50cnVzdGVk")):
        return value
    try:
        with open(value, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return value


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--version", required=True)
    p.add_argument("--notes", required=True)
    p.add_argument("--pub-date", required=True)
    p.add_argument("--appimage-url", required=True)
    p.add_argument("--appimage-sig", required=True)
    p.add_argument("--appimage-sha256", required=True)
    p.add_argument("--deb-url", default=None)
    p.add_argument("--deb-sig", default=None)
    p.add_argument("--deb-sha256", default=None)
    p.add_argument("--out", required=True)
    args = p.parse_args()

    manifest = {
        "version": args.version,
        "notes": args.notes,
        "pub_date": args.pub_date,
        "platforms": {
            "linux-x86_64": {
                "signature": load_sig(args.appimage_sig),
                "url": args.appimage_url,
                "sha256": args.appimage_sha256,
            }
        },
    }

    if args.deb_url or args.deb_sig or args.deb_sha256:
        if not (args.deb_url and args.deb_sig and args.deb_sha256):
            print("ERROR: --deb-url, --deb-sig and --deb-sha256 must all be set together", file=sys.stderr)
            return 2
        manifest["deb"] = {
            "url": args.deb_url,
            "signature": load_sig(args.deb_sig),
            "sha256": args.deb_sha256,
        }

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")

    # Self-validate.
    with open(args.out, encoding="utf-8") as fh:
        data = json.load(fh)
    assert data["version"] == args.version
    sig = data["platforms"]["linux-x86_64"]["signature"]
    if len(sig) < 40:
        print("ERROR: AppImage signature looks empty", file=sys.stderr)
        return 1
    if "deb" in data:
        if len(data["deb"]["signature"]) < 40:
            print("ERROR: deb signature looks empty", file=sys.stderr)
            return 1
        if len(data["deb"]["sha256"]) != 64:
            print("ERROR: deb sha256 malformed", file=sys.stderr)
            return 1
    print(f"✓ wrote {args.out} (version {args.version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
