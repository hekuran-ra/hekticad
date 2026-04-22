#!/usr/bin/env python3
"""
Render the HektikCad app icon from scratch.

Draws a macOS-style squircle background with an outline-only rendition
of the HektikCad brackets-and-joint mark centered on it. Nothing is
filled except the background — the mark itself is stroked so it reads
as a linework icon, which fits the CAD subject matter and avoids the
"too-heavy" feel of the old filled variant.

Knobs (tweak and re-run):
  CANVAS         — output resolution. 1024 is the macOS standard.
  BG_COLOR       — squircle fill.
  STROKE_COLOR   — color of the drawn mark.
  CONTENT_SCALE  — fraction of the canvas the mark occupies (per axis).
  STROKE_WIDTH   — line weight of the mark, in canvas pixels.
  BG_RADIUS_PCT  — corner radius of the background, as a fraction of
                   CANVAS. macOS Big Sur+ uses roughly 22% for its
                   built-in squircle.

After running this, regenerate the platform icon set:
    npx tauri icon src-tauri/icons/source-1024.png
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "icons" / "source-1024.png"

# -----------------------------------------------------------------------
# Style
# -----------------------------------------------------------------------
CANVAS = 1024
BG_COLOR = (15, 17, 23, 255)      # near-black, matches app chrome
STROKE_COLOR = (230, 232, 236, 255)  # off-white
BG_RADIUS_PCT = 0.225             # macOS-ish squircle corner radius
CONTENT_SCALE = 0.62              # mark fills 62% of the canvas
STROKE_WIDTH = 24                 # line weight


def main() -> None:
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # -- Background squircle -------------------------------------------------
    radius = int(CANVAS * BG_RADIUS_PCT)
    draw.rounded_rectangle(
        (0, 0, CANVAS - 1, CANVAS - 1),
        radius=radius,
        fill=BG_COLOR,
    )

    # -- Mark geometry -------------------------------------------------------
    # Two vertical rounded rectangles flanking a central circle — a stylised
    # "bracket-joint-bracket" echoing the HektikCad wordmark's glyph pair.
    content_w = int(CANVAS * CONTENT_SCALE)
    content_h = int(CANVAS * CONTENT_SCALE)
    cx = CANVAS // 2
    cy = CANVAS // 2
    left = cx - content_w // 2
    right = cx + content_w // 2
    top = cy - content_h // 2
    bottom = cy + content_h // 2

    # Gap between the two brackets, as a fraction of the content width.
    gap = int(content_w * 0.14)
    bracket_w = (content_w - gap) // 2
    bracket_radius = int(bracket_w * 0.30)

    # Left bracket (outline only)
    draw.rounded_rectangle(
        (left, top, left + bracket_w, bottom),
        radius=bracket_radius,
        outline=STROKE_COLOR,
        width=STROKE_WIDTH,
    )
    # Right bracket (outline only)
    draw.rounded_rectangle(
        (right - bracket_w, top, right, bottom),
        radius=bracket_radius,
        outline=STROKE_COLOR,
        width=STROKE_WIDTH,
    )

    # Central circle joining the two. Sized to span the gap with a little
    # overlap into each bracket so it reads as a connector, not a planet.
    circle_r = int(content_h * 0.11)
    draw.ellipse(
        (cx - circle_r, cy - circle_r, cx + circle_r, cy + circle_r),
        outline=STROKE_COLOR,
        width=STROKE_WIDTH,
    )

    # -- Write --------------------------------------------------------------
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, format="PNG")
    print(f"wrote {OUT.relative_to(ROOT)} "
          f"({CANVAS}x{CANVAS}, squircle r={BG_RADIUS_PCT:.0%}, "
          f"content {CONTENT_SCALE:.0%}, stroke {STROKE_WIDTH}px)")


if __name__ == "__main__":
    main()
