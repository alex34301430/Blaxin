#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════
# BLAXIN — Official brand asset + application icon generator
#
# Source of truth: blaxin/brand/blaxin-logo-source.jpeg
# (the official "Modern Letter B" geometric brand mark: white B on black)
#
# Usage:
#   python3 blaxin/brand/generate-icons.py
#
# Produces (all derived from the single source asset — the logo design is
# never redrawn or altered, only scaled / composited / padded):
#
#   brand/blaxin-mark.png          1024px master PNG (RGBA)
#   brand/blaxin-mark-dark.png     1024px mark composited on brand black
#   brand/blaxin-wordmark.png      logo mark + BLAXIN wordmark lockup
#   src-tauri/icons/32x32.png      Tauri / window icon
#   src-tauri/icons/128x128.png    Tauri / window icon
#   src-tauri/icons/128x128@2x.png Tauri / window icon (256px)
#   src-tauri/icons/icon.png       Tauri / installer icon (512px)
#   client/public/blaxin-mark.png  frontend favicon/UI brand mark
#
# Requirements: Pillow  (pip install pillow)
# ═══════════════════════════════════════════════════════════════════════

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = Path(__file__).resolve().parent.parent
BRAND_DIR = REPO_ROOT / "brand"
SOURCE = BRAND_DIR / "blaxin-logo-source.jpeg"

ICONS_DIR = REPO_ROOT / "src-tauri" / "icons"
CLIENT_PUBLIC = REPO_ROOT / "client" / "public"

TAURI_ICONS = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
}

# Brand black matches the logo's own background (the source is pure
# black behind the white mark), so composited tiles are seamless.
BRAND_BLACK = (0, 0, 0)


def fail(msg: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def load_source() -> Image.Image:
    """Load the official logo. Never edit the design itself."""
    if not SOURCE.is_file():
        fail(f"official logo source not found: {SOURCE}")
    return Image.open(SOURCE)


def mark_rgba(src: Image.Image, size: int) -> Image.Image:
    """
    The source is a JPEG: the mark sits on an opaque black square.
    For icon usage the black background becomes a transparent alpha
    channel (derived from luminance — this preserves the logo exactly:
    the white B and all anti-aliased edges stay untouched; only the
    pure-black backing square is made transparent).
    """
    rgb = src.convert("RGB")
    alpha = rgb.convert("L").point(lambda v: 255 if v >= 8 else 0)
    rgba = rgb.copy().convert("RGBA")
    rgba.putalpha(alpha)

    # Tight-crop the mark itself so it fills the icon canvas cleanly.
    bbox = alpha.getbbox()
    if bbox:
        rgba = rgba.crop(bbox)

    side = max(rgba.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(rgba, ((side - rgba.width) // 2, (side - rgba.height) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def write_mark_assets(mark: Image.Image) -> None:
    """Master brand PNGs (full-bleed square, source-faithful)."""
    BRAND_DIR.mkdir(parents=True, exist_ok=True)

    master = mark.resize((1024, 1024), Image.LANCZOS)
    master.save(BRAND_DIR / "blaxin-mark.png", optimize=True)

    dark = Image.new("RGBA", (1024, 1024), BRAND_BLACK + (255,))
    dark.alpha_composite(master)
    dark.save(BRAND_DIR / "blaxin-mark-dark.png", optimize=True)


def write_wordmark(mark: Image.Image) -> None:
    """Logo + BLAXIN lockup for README / docs / store listings."""
    size = 1024
    mark_big = mark.resize((560, 560), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), BRAND_BLACK + (255,))
    canvas.alpha_composite(mark_big, ((size - 560) // 2, 96))

    text = "BLAXIN"
    font = None
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ):
        if Path(candidate).is_file():
            font = ImageFont.truetype(candidate, 148)
            break
    if font is None:  # no system font — ship the mark-only lockup
        canvas.save(BRAND_DIR / "blaxin-wordmark.png", optimize=True)
        return

    draw = ImageDraw.Draw(canvas)
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    tw, th = right - left, bottom - top
    x, y = (size - tw) // 2 - left, 96 + 560 + 56
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))
    canvas.save(BRAND_DIR / "blaxin-wordmark.png", optimize=True)


def write_tauri_icons(mark: Image.Image) -> None:
    """
    Tauri Linux icon set (see bundle.icon in tauri.conf.json).
    The mark gets a small 4% clear margin so it never touches the
    rounded-corner clip at small sizes; the canvas stays transparent
    so the icon sits cleanly on any launcher background.
    """
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    for name, px in TAURI_ICONS.items():
        canvas_px = int(px / 0.92)
        tile = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
        tile.alpha_composite(mark.resize((canvas_px, canvas_px), Image.LANCZOS))
        icon = tile.resize((px, px), Image.LANCZOS).convert("RGBA")
        icon.save(ICONS_DIR / name, optimize=True)
        print(f"  icons/{name}  ({px}x{px})")


def write_client_assets(mark: Image.Image) -> None:
    """Frontend brand mark (favicon + empty states import this)."""
    CLIENT_PUBLIC.mkdir(parents=True, exist_ok=True)
    mark.resize((256, 256), Image.LANCZOS).save(
        CLIENT_PUBLIC / "blaxin-mark.png", optimize=True
    )
    print("  client/public/blaxin-mark.png  (256x256)")


def main() -> None:
    src = load_source()
    print(f"Official BLAXIN logo: {SOURCE.name} ({src.format} {src.size[0]}x{src.size[1]})")

    mark = mark_rgba(src, 1024)
    print("Generating brand assets:")
    write_mark_assets(mark)
    print("  brand/blaxin-mark.png       (1024x1024 RGBA)")
    print("  brand/blaxin-mark-dark.png  (1024x1024 on brand black)")
    write_wordmark(mark)
    print("  brand/blaxin-wordmark.png   (1024x1024 lockup)")

    print("Generating Tauri icons:")
    write_tauri_icons(mark)
    write_client_assets(mark)
    print("Done.")


if __name__ == "__main__":
    main()
