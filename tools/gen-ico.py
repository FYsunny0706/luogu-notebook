# 从 PWA 图标生成 Windows 快捷方式用的 .ico（多尺寸）
# 用法：python tools/gen-ico.py
from PIL import Image
import os
import sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(root, "public", "icons", "icon-512.png")
dst = os.path.join(root, "public", "icons", "icon.ico")

if not os.path.exists(src):
    print(f"找不到源图：{src}")
    sys.exit(1)

im = Image.open(src).convert("RGBA")
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
im.save(dst, format="ICO", sizes=sizes)
print(f"已生成 {dst}  {os.path.getsize(dst)} 字节  尺寸 {sizes}")
