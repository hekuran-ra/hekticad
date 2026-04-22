#!/usr/bin/env python3
"""
Produce a macOS-conventional app icon from `public/icon-512.png`.

The source icon fills its canvas edge-to-edge, which makes the app icon
look oversized in the Dock — every well-behaved macOS app leaves roughly
10% transparent padding around its artwork so the rendered tile sits
flush with its neighbours. This script:

  1. Loads the source PNG.
  2. Pastes it, scaled, onto a transparent 1024x1024 canvas with the
     configured inset percentage.
  3. Writes the result to `src-tauri/icons/source-1024.png`.

Then `npx tauri icon src-tauri/icons/source-1024.png` regenerates the full
platform icon set (including icon.icns / icon.ico) from this padded
version.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "icon-512.png"
OUT = ROOT / "src-tauri" / "icons" / "source-1024.png"

CANVAS = 1024
# Fraction of the canvas occupied by the artwork. macOS conventions hover
# around 0.80 (Apple's own apps sit closer to 0.82, third-party Big Sur+
# icons trend a hair smaller).
CONTENT_SCALE = 0.80


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    content_size = int(CANVAS * CONTENT_SCALE)
    scaled = src.resize((content_size, content_size), Image.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    offset = (CANVAS - content_size) // 2
    canvas.paste(scaled, (offset, offset), scaled)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT, format="PNG")
    print(f"wrote {OUT.relative_to(ROOT)} ({CANVAS}x{CANVAS}, {CONTENT_SCALE:.0%} content)")


if __name__ == "__main__":
    main()
