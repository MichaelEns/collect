"""
Generates the home screen icons: a checklist grid where some squares are
ticked, which is what the app does in one picture.

Deliberately abstract. The icon must not lean on any manufacturer's artwork,
and a grid of ticks reads as "collection progress" at 40 pixels better than a
tiny figure would anyway.

    python tools/make_icons.py
"""

from PIL import Image, ImageDraw
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024

SKY_TOP = (18, 25, 58)
SKY_BOTTOM = (58, 30, 96)
SLOT = (44, 54, 112)
SLOT_EDGE = (72, 84, 158)
FOUND = (67, 209, 124)
FOUND_DARK = (10, 74, 40)
GOLD = (255, 201, 61)

# Which cells are collected. A deliberately incomplete set: the app is about
# progress, and a full grid would say "finished" instead.
FILLED = {0, 1, 3, 4, 6}
STAR = 8


def background(size):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        d.line([(0, y), (size, y)],
               fill=tuple(round(a + (b - a) * t) for a, b in zip(SKY_TOP, SKY_BOTTOM)))
    return img


def tick(d, cx, cy, size, colour):
    """A chunky check mark, drawn as two thick strokes."""
    w = max(2, int(size * 0.16))
    d.line([(cx - size * 0.30, cy + size * 0.02),
            (cx - size * 0.08, cy + size * 0.26)], fill=colour, width=w)
    d.line([(cx - size * 0.09, cy + size * 0.26),
            (cx + size * 0.31, cy - size * 0.26)], fill=colour, width=w)


def star(d, cx, cy, r, colour):
    """Five-pointed star for the rare one, so the grid is not all the same."""
    import math
    points = []
    for i in range(10):
        radius = r if i % 2 == 0 else r * 0.44
        angle = -math.pi / 2 + i * math.pi / 5
        points.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius))
    d.polygon(points, fill=colour)


def build(maskable=False):
    img = background(S)
    d = ImageDraw.Draw(img)

    # A maskable icon is cropped to a circle by the launcher, so the grid
    # shrinks into the safe zone rather than losing its corners.
    span = S * (0.52 if maskable else 0.66)
    gap = span * 0.075
    cell = (span - gap * 2) / 3
    left = (S - span) / 2
    top = (S - span) / 2

    for index in range(9):
        row, col = divmod(index, 3)
        x = left + col * (cell + gap)
        y = top + row * (cell + gap)
        radius = cell * 0.24

        if index == STAR:
            d.rounded_rectangle([x, y, x + cell, y + cell], radius=radius,
                                fill=SLOT, outline=GOLD, width=max(3, int(cell * 0.07)))
            star(d, x + cell / 2, y + cell / 2, cell * 0.30, GOLD)
        elif index in FILLED:
            d.rounded_rectangle([x, y, x + cell, y + cell], radius=radius, fill=FOUND)
            tick(d, x + cell / 2, y + cell / 2, cell, FOUND_DARK)
        else:
            d.rounded_rectangle([x, y, x + cell, y + cell], radius=radius,
                                fill=SLOT, outline=SLOT_EDGE, width=max(2, int(cell * 0.05)))

    return img


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Collection checklist">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#12193a"/>
      <stop offset="1" stop-color="#3a1e60"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="url(#sky)"/>
  <g>
    <rect x="87" y="87" width="104" height="104" rx="26" fill="#43d17c"/>
    <path d="M112 140 l20 22 l38 -46" fill="none" stroke="#0a4a28" stroke-width="17"
          stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="204" y="87" width="104" height="104" rx="26" fill="#43d17c"/>
    <path d="M229 140 l20 22 l38 -46" fill="none" stroke="#0a4a28" stroke-width="17"
          stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="321" y="87" width="104" height="104" rx="26" fill="#2c3670" stroke="#48549e" stroke-width="6"/>

    <rect x="87" y="204" width="104" height="104" rx="26" fill="#43d17c"/>
    <path d="M112 257 l20 22 l38 -46" fill="none" stroke="#0a4a28" stroke-width="17"
          stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="204" y="204" width="104" height="104" rx="26" fill="#43d17c"/>
    <path d="M229 257 l20 22 l38 -46" fill="none" stroke="#0a4a28" stroke-width="17"
          stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="321" y="204" width="104" height="104" rx="26" fill="#2c3670" stroke="#48549e" stroke-width="6"/>

    <rect x="87" y="321" width="104" height="104" rx="26" fill="#43d17c"/>
    <path d="M112 374 l20 22 l38 -46" fill="none" stroke="#0a4a28" stroke-width="17"
          stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="204" y="321" width="104" height="104" rx="26" fill="#2c3670" stroke="#48549e" stroke-width="6"/>
    <rect x="321" y="321" width="104" height="104" rx="26" fill="#2c3670" stroke="#ffc93d" stroke-width="8"/>
    <path d="M373 344 l10 21 l23 3 l-17 16 l4 23 l-20 -11 l-20 11 l4 -23 l-17 -16 l23 -3 z" fill="#ffc93d"/>
  </g>
</svg>
"""


def main():
    jobs = [
        (build(False).resize((180, 180), Image.LANCZOS), "icon-180.png"),
        (build(False).resize((512, 512), Image.LANCZOS), "icon-512.png"),
        (build(True).resize((512, 512), Image.LANCZOS), "icon-maskable-512.png"),
    ]
    for img, name in jobs:
        path = os.path.join(ROOT, name)
        img.save(path, "PNG", optimize=True)
        print(f"{name:<26} {os.path.getsize(path):>7} bytes")

    svg_path = os.path.join(ROOT, "icon.svg")
    with open(svg_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(SVG)
    print(f"{'icon.svg':<26} {os.path.getsize(svg_path):>7} bytes")


if __name__ == "__main__":
    main()
