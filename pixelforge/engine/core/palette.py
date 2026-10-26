"""调色板：加载、从图提取、最近色映射。"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from engine.core.oklab import (
    linear_to_srgb,
    oklab_to_linear_rgb,
    rgb_to_oklab,
)
from engine.types import Palette, RGBImage

PALETTES_DIR = Path(__file__).resolve().parent.parent / "assets" / "palettes"


def _parse_hex_palette(text: str) -> list[tuple[int, int, int]]:
    """每行一个颜色：RRGGBB 或 #RRGGBB；空行与 // 注释行跳过。"""
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("//") or s.startswith(";"):
            continue
        s = s.lstrip("#")
        if len(s) >= 6:
            out.append((int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)))
    return out


def load_builtin(name: str) -> Palette:
    """加载内置调色板（assets/palettes/<name>.hex，每行一个 #RRGGBB）。"""
    path = PALETTES_DIR / f"{name}.hex"
    if not path.exists():
        available = ", ".join(p.stem for p in PALETTES_DIR.glob("*.hex"))
        raise FileNotFoundError(f"内置调色板不存在: {name}（可用: {available}）")
    colors = np.array(_parse_hex_palette(path.read_text(encoding="utf-8")), dtype=np.uint8)
    return Palette(colors=colors, name=name, source="builtin")


def extract_from_image(image: RGBImage, max_colors: int) -> Palette:
    """从（已下采样的）小图提取调色板：OKLab 空间 k-means，确定性步长初始化。

    v1 约束（设计文档 §10）：尚未实现最小色相覆盖，暗图可能聚出全灰系——
    golden 验证时观察，必要时加约束。
    """
    flat = image.reshape(-1, 3)
    uniq = np.unique(flat, axis=0)
    k = min(max_colors, len(uniq))
    if k >= len(uniq):
        return Palette(colors=uniq.astype(np.uint8), name=f"extract-{k}", source="extract")

    labs = rgb_to_oklab(uniq)
    stride = len(uniq) / k
    cent = np.stack([labs[min(int(i * stride), len(uniq) - 1)] for i in range(k)])
    for _ in range(8):
        d = ((labs[:, None, :] - cent[None, :, :]) ** 2).sum(-1)
        assign = d.argmin(1)
        for ci in range(k):
            members = labs[assign == ci]
            if len(members):
                cent[ci] = members.mean(0)
    lin = np.clip(oklab_to_linear_rgb(cent), 0.0, 1.0)
    colors = linear_to_srgb(lin)
    return Palette(colors=colors, name=f"extract-{k}", source="extract")


def nearest_palette_index(small_rgb: RGBImage, palette: Palette) -> np.ndarray:
    """(h,w,3) sRGB → (h,w) int32 最近调色板索引，色距用 OKLab。"""
    labs = rgb_to_oklab(small_rgb).reshape(-1, 3)
    plabs = rgb_to_oklab(palette.colors)
    d = ((labs[:, None, :] - plabs[None, :, :]) ** 2).sum(-1)
    return d.argmin(1).reshape(small_rgb.shape[:2]).astype(np.int32)
