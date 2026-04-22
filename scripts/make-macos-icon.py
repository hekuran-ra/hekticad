#!/usr/bin/env python3
"""
Render the HektikCad app icon from the VisualsbyHekuran brand SVG.

Pipeline:
  1. Rasterise `src-tauri/icons/mark.svg` to a transparent PNG at the
     target content resolution via `rsvg-convert` (librsvg).
  2. Draw a macOS-style squircle background at full canvas resolution.
  3. Composite the rasterised mark centered on the squircle.
  4. Write the result to `src-tauri/icons/source-1024.png`.

Then:
    npx tauri icon src-tauri/icons/source-1024.png
regenerates the full platform icon set (icon.icns, icon.ico, PNGs).

Requires `rsvg-convert` (Homebrew: `brew install librsvg`).
"""
from pathlib import Path
import subprocess
import sys
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "src-tauri" / "icons" / "mark.svg"
OUT = ROOT / "src-tauri" / "icons" / "source-1024.png"
TMP_MARK = ROOT / "src-tauri" / "icons" / ".mark-raster.png"

# -----------------------------------------------------------------------
# Style
# -----------------------------------------------------------------------
CANVAS = 1024
BG_COLOR = (15, 17, 23, 255)   # near-black squircle — matches SVG's intended backdrop
BG_RADIUS_PCT = 0.225          # macOS Big Sur+ squircle radius
CONTENT_SCALE = 0.66           # mark fills this fraction of the canvas (per axis)


def rasterise_svg(svg_path: Path, size: int, dest: Path) -> None:
    """Invoke rsvg-convert to produce a transparent PNG of `svg_path` at `size` px square."""
    cmd = [
        "rsvg-convert",
        "--width", str(size),
        "--height", str(size),
        "--keep-aspect-ratio",
        "--output", str(dest),
        str(svg_path),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except FileNotFoundError:
        sys.exit("rsvg-convert not found — install with `brew install librsvg`.")
    except subprocess.CalledProcessError as exc:
        sys.exit(f"rsvg-convert failed:\n{exc.stderr.decode()}")


def main() -> None:
    if not SVG.exists():
        sys.exit(f"source SVG missing: {SVG}")

    # Content canvas: fraction of the final canvas the mark should occupy.
    content_size = int(CANVAS * CONTENT_SCALE)
    rasterise_svg(SVG, content_size, TMP_MARK)
    mark = Image.open(TMP_MARK).convert("RGBA")

    # Base canvas with the dark squircle.
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = int(CANVAS * BG_RADIUS_PCT)
    draw.rounded_rectangle(
        (0, 0, CANVAS - 1, CANVAS - 1),
        radius=radius,
        fill=BG_COLOR,
    )

    # Paste the mark centered. The alpha channel of `mark` is the paste mask,
    # so the transparent SVG rim doesn't overwrite the squircle.
    offset = ((CANVAS - mark.width) // 2, (CANVAS - mark.height) // 2)
    img.paste(mark, offset, mark)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, format="PNG")
    TMP_MARK.unlink(missing_ok=True)
    print(
        f"wrote {OUT.relative_to(ROOT)} "
        f"(canvas {CANVAS}px, squircle r={BG_RADIUS_PCT:.0%}, "
        f"mark {CONTENT_SCALE:.0%} from {SVG.name})"
    )


if __name__ == "__main__":
    main()
