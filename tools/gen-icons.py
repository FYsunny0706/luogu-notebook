import os
import sys
from PIL import Image, ImageDraw

root = sys.argv[1] if len(sys.argv) > 1 else "."
out = os.path.join(root, "public", "icons")
os.makedirs(out, exist_ok=True)


def make(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rad = int(size * 0.22)

    # 渐变底色：深色 → 蓝绿
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], rad, fill=255)
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    for i in range(size):
        t = i / size
        c = (int(20 + (66 - 20) * t), int(24 + (104 - 24) * t), int(34 + (146 - 34) * t), 255)
        ImageDraw.Draw(grad).line([(0, i), (size - 1, i)], c)
    grad.putalpha(mask)

    d = ImageDraw.Draw(grad)
    w = int(size * 0.62)
    x0 = (size - w) // 2
    y0 = int(size * 0.24)
    y1 = int(size * 0.76)
    lw = max(1, int(size * 0.115))
    cy = size // 2
    # <
    d.line([(x0 + int(w * 0.10), y0), (x0 + int(w * 0.46), cy)], fill=(255, 255, 255, 255), width=lw, joint="curve")
    d.line([(x0 + int(w * 0.46), cy), (x0 + int(w * 0.10), y1)], fill=(255, 255, 255, 255), width=lw, joint="curve")
    # /
    d.line([(x0 + int(w * 0.54), y0), (x0 + int(w * 0.90), y1)], fill=(255, 255, 255, 255), width=lw, joint="curve")
    return grad


for s in (192, 512):
    fp = os.path.join(out, f"icon-{s}.png")
    make(s).save(fp, "PNG")
    print(f"  icon-{s}.png  {os.path.getsize(fp) // 1024} KB")
