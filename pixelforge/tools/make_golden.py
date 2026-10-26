"""生成 golden 测试图：蘑菇小屋场景（与前端原型同一构图）。

特征：细深轮廓（蘑菇/树/门）、高饱和小特征（太阳/红帽/白点）、大面积渐变天空
——分别命中「均值稀释暗线」「高饱和小特征消失」「量化色带」三类问题。

用法: python tools/make_golden.py [输出路径]
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "tests" / "golden" / "scene.png"

TOP = (127, 192, 230)
BOTTOM = (230, 241, 232)
OUTLINE = (58, 44, 51)
CANOPY_OUTLINE = (35, 64, 42)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def build() -> Image.Image:
    img = Image.new("RGB", (256, 256))
    d = ImageDraw.Draw(img)

    for y in range(256):  # 天空渐变
        d.line([(0, y), (256, y)], fill=lerp(TOP, BOTTOM, y / 255))

    d.ellipse((27, 23, 65, 61), fill=(255, 210, 63), outline=(217, 154, 23), width=2)   # 太阳
    for bbox in [(128, 26, 176, 74), (161, 40, 195, 74), (185, 36, 211, 62)]:           # 云
        d.ellipse(bbox, fill=(255, 255, 255))

    d.polygon([(0, 192), (64, 118), (142, 192)], fill=(151, 163, 186))                  # 远山
    d.polygon([(92, 192), (158, 104), (248, 192)], fill=(135, 148, 173))
    d.ellipse((-92, 174, 348, 438), fill=(134, 196, 106))                               # 草坡
    d.ellipse((-130, 210, 170, 450), fill=(116, 180, 90))

    d.rectangle((42, 150, 52, 184), fill=(122, 74, 43))                                 # 树
    cap = [(27, 152), (67, 152), (58, 128), (36, 128)]
    d.polygon(cap, fill=(63, 155, 79))
    d.line(cap + [cap[0]], fill=CANOPY_OUTLINE, width=2, joint="curve")
    d.ellipse((31, 106, 63, 138), fill=(79, 174, 95), outline=CANOPY_OUTLINE, width=2)

    d.rectangle((138, 158, 174, 198), fill=(239, 227, 200), outline=OUTLINE, width=2)   # 蘑菇小屋
    mushroom = [(128, 160), (142, 124), (156, 108), (170, 124), (184, 160)]
    d.polygon(mushroom, fill=(217, 68, 48))
    d.line(mushroom + [mushroom[0]], fill=OUTLINE, width=2, joint="curve")
    for bbox in [(137, 132, 147, 142), (152, 116, 164, 128), (166, 138, 174, 146)]:    # 白点
        d.ellipse(bbox, fill=(255, 246, 236))
    d.rectangle((150, 174, 163, 198), fill=(107, 74, 47), outline=OUTLINE, width=2)     # 门

    d.arc((201, 67, 215, 81), 200, 340, fill=(64, 72, 90), width=2)                     # 小鸟
    d.arc((214, 67, 228, 81), 200, 340, fill=(64, 72, 90), width=2)
    return img


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
    target.parent.mkdir(parents=True, exist_ok=True)
    build().save(target)
    print(f"golden 测试图 -> {target}")
