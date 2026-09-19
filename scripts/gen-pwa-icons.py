#!/usr/bin/env python3
"""Generate MOHD.HMS PWA icons from the official logo assets.

- Maskable icons: full-bleed brand-green background, logo centered inside the
  safe zone (content circle = 80% of canvas) so device masks never clip it.
- Apple touch icon: solid brand background (iOS composites transparency to
  black on older devices), rounded corners are applied by iOS itself.
- Android/Chrome "any" icons keep the existing transparent official assets.
"""
from PIL import Image
from collections import Counter

BRAND = "/home/z/my-project/public/brand"
LOGO = f"{BRAND}/logo-512.png"


def dominant_green(img: Image.Image) -> tuple[int, int, int]:
    """Sample the badge's interior dark-green field (official brand background).

    The logo is a circular badge: dark forest-green fill inside a light-green
    ring. Sample a ring inside the badge (r = 0.38..0.46 of canvas) in the
    diagonal directions, avoiding the top/bottom white text arcs.
    """
    rgba = img.convert("RGBA")
    w, h = rgba.size
    cx, cy = w / 2, h / 2
    counts: Counter = Counter()
    for frac in (0.38, 0.41, 0.44):
        for dx, dy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
            px = rgba.getpixel((int(cx + dx * w * frac * 0.5), int(cy + dy * h * frac * 0.5)))
            r, g, b, a = px[:4]
            if a < 200:
                continue
            if g > r and g > b and g < 110:  # dark forest green, not the lime ring
                counts[(r // 4 * 4, g // 4 * 4, b // 4 * 4)] += 1
    if not counts:
        return (20, 52, 28)
    (r, g, b), _ = counts.most_common(1)[0]
    return (r, g, b)


def make_maskable(size: int, out: str) -> None:
    canvas = Image.new("RGBA", (size, size), green + (255,))
    logo = Image.open(LOGO).convert("RGBA")
    # Safe zone: keep logo within the central 66% so any circular mask
    # (which can cut up to 10% per side) never touches it.
    inner = int(size * 0.66)
    logo = logo.resize((inner, inner), Image.LANCZOS)
    canvas.alpha_composite(logo, ((size - inner) // 2, (size - inner) // 2))
    canvas.convert("RGB").save(out, "PNG", optimize=True)
    print("maskable", size, "->", out)


def make_apple(size: int, out: str) -> None:
    canvas = Image.new("RGBA", (size, size), green + (255,))
    logo = Image.open(LOGO).convert("RGBA")
    inner = int(size * 0.74)
    logo = logo.resize((inner, inner), Image.LANCZOS)
    canvas.alpha_composite(logo, ((size - inner) // 2, (size - inner) // 2))
    canvas.convert("RGB").save(out, "PNG", optimize=True)
    print("apple", size, "->", out)


base = Image.open(LOGO)
green = dominant_green(base)
print("sampled brand green:", "#%02x%02x%02x" % green)

make_maskable(192, f"{BRAND}/icon-maskable-192.png")
make_maskable(512, f"{BRAND}/icon-maskable-512.png")
make_apple(180, f"{BRAND}/apple-touch-icon.png")
