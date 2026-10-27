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
    # 0.4.0：按 24 位整数去重，替代 np.unique(axis=0) 的逐行排序（大网格快数倍）；
    # 排序仍按 RGB 字典序，k-means 初始化顺序与旧实现一致。
    packed = (
        (flat[:, 0].astype(np.uint32) << 16)
        | (flat[:, 1].astype(np.uint32) << 8)
        | flat[:, 2].astype(np.uint32)
    )
    _, first = np.unique(packed, return_index=True)
    uniq = flat[first]
    k = min(max_colors, len(uniq))
    if k >= len(uniq):
        return Palette(colors=uniq.astype(np.uint8), name=f"extract-{k}", source="extract")

    labs = rgb_to_oklab(uniq).reshape(len(uniq), 3)
    stride = len(uniq) / k
    cent = np.stack([labs[min(int(i * stride), len(uniq) - 1)] for i in range(k)])
    for _ in range(8):
        assign = _pairwise_sqdist(labs, cent).argmin(1)
        counts = np.bincount(assign, minlength=k)
        sums = np.stack(
            [np.bincount(assign, weights=labs[:, c], minlength=k) for c in range(3)], axis=1
        )
        filled = counts > 0
        cent[filled] = sums[filled] / counts[filled, None]
    lin = np.clip(oklab_to_linear_rgb(cent), 0.0, 1.0)
    colors = linear_to_srgb(lin)
    return Palette(colors=colors, name=f"extract-{k}", source="extract")


def _pairwise_sqdist(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """(N,3) × (M,3) → (N,M) 平方距离。

    0.4.0：用矩阵乘展开 ||a−b||² = |a|² + |b|² − 2a·b，避免旧实现的
    (N,M,3) 临时数组（512 格 / 128 色时可达数百 MB），并走 BLAS。
    """
    a2 = (a * a).sum(1)
    b2 = (b * b).sum(1)
    return np.maximum(a2[:, None] + b2[None, :] - 2.0 * (a @ b.T), 0.0)


def nearest_palette_index(small_rgb: RGBImage, palette: Palette) -> np.ndarray:
    """(h,w,3) sRGB → (h,w) int32 最近调色板索引，色距用 OKLab。"""
    labs = rgb_to_oklab(small_rgb).reshape(-1, 3)
    plabs = rgb_to_oklab(palette.colors).reshape(-1, 3)
    out = np.empty(len(labs), dtype=np.int32)
    chunk = 32768  # 分块限制峰值内存（大网格 + 128 色）
    for start in range(0, len(labs), chunk):
        out[start:start + chunk] = _pairwise_sqdist(labs[start:start + chunk], plabs).argmin(1)
    return out.reshape(small_rgb.shape[:2])
