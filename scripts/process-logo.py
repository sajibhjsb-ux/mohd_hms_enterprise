"""Process MOHD HMS ENTERPRISE round logo:
- crop to badge bounding box, apply circular alpha mask (outside circle -> transparent)
- emit web-ready sizes into public/brand/
"""
from PIL import Image, ImageDraw, ImageFilter

SRC = "/home/z/my-project/upload/MOHD HMS ENTERPRISE Round Logo.png"
OUT = "/home/z/my-project/public/brand"

img = Image.open(SRC).convert("RGBA")

# 1) Find bbox of non-white pixels (threshold 240) to crop away white margins
gray = img.convert("L")
mask_bw = gray.point(lambda p: 255 if p < 240 else 0)
bbox = mask_bw.getbbox()
print("badge bbox:", bbox)
img = img.crop(bbox)
side = min(img.size)
img = img.crop(((img.width - side) // 2, (img.height - side) // 2,
                (img.width + side) // 2, (img.height + side) // 2))
print("cropped square:", img.size)

# 2) Circular alpha mask: everything outside the badge circle -> transparent.
#    Slight inset (99.2%) avoids a white fringe from anti-aliased edge pixels.
big = side * 2  # supersample the mask for smooth edge
mask = Image.new("L", (big, big), 0)
d = ImageDraw.Draw(mask)
inset = int(big * 0.5 * 0.985)
d.ellipse((big // 2 - inset, big // 2 - inset, big // 2 + inset, big // 2 + inset), fill=255)
mask = mask.resize((side, side), Image.LANCZOS)
img.putalpha(mask)

def emit(size: int, name: str):
    out = img.resize((size, size), Image.LANCZOS)
    out.save(f"{OUT}/{name}", optimize=True)
    print("wrote", name, size)

emit(512, "logo-512.png")
emit(256, "logo-256.png")
emit(128, "logo-128.png")
emit(64,  "logo-64.png")
emit(32,  "icon-32.png")
emit(180, "apple-touch-icon.png")  # iOS shows on white; keep full badge (no mask loss)
emit(192, "icon-192.png")

# apple-touch-icon: iOS does not honor transparency — composite on white rounded-none square
at = Image.new("RGB", (180, 180), (255, 255, 255))
badge = img.resize((180, 180), Image.LANCZOS)
at.paste(badge, (0, 0), badge)
at.save(f"{OUT}/apple-touch-icon.png", optimize=True)
print("apple-touch-icon composited on white")

# 3) Transparent watermark-friendly small monochrome not needed; done.
