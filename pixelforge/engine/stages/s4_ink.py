"""S4 墨线合成：线稿 → 恰 1 格宽的独立 Ink 层。

- 线强度 = 格内线稿最大值（线必须完整存活，不取均值）
- 阈值二值化后去掉完全孤立的墨线格
- selective outline：墨线色 = 该格底色在线性空间加深 darken 比例（非纯黑）；
  新色追加进调色板（Fill 索引不变），黑线模式则吸附调色板最近色
- Ink 格存调色板索引，非墨线格存 -1 哨兵；opacity 由渲染端处理（引擎存满强度）
"""

from __future__ import annotations

import numpy as np

from engine.core.grid import build_mapping
from engine.core.oklab import linear_to_srgb, srgb_to_linear
from engine.core.palette import nearest_palette_index
from engine.recipe import Recipe
from engine.types import GrayMap, IndexGrid, Palette

_LINE_THR = 0.5


def _cell_line_strength(L: GrayMap, grid_shape: tuple[int, int]) -> np.ndarray:
    """逐格墨线强度 = 格内线稿最大值。"""
    th, tw = grid_shape
    mapping = build_mapping(L.shape[:2], grid_shape)
    out = np.zeros(th * tw, dtype=np.float32)
    np.maximum.at(out, mapping.cell_index, L.ravel().astype(np.float32))
    return out.reshape(th, tw)


def _drop_isolated(mask: np.ndarray) -> np.ndarray:
    p = np.pad(mask, 1, mode="constant")
    nb = (
        p[:-2, 1:-1].astype(np.int8)
        + p[2:, 1:-1]
        + p[1:-1, :-2]
        + p[1:-1, 2:]
    )
    return mask & (nb >= 1)


def run(
    L: GrayMap, fill: IndexGrid, palette: Palette, recipe: Recipe
) -> tuple[IndexGrid, Palette]:
    """返回 (Ink 层, 可能已扩展的调色板)。"""
    p = recipe.raw["ink"]
    th, tw = fill.data.shape
    mask = _drop_isolated(_cell_line_strength(L, (th, tw)) >= _LINE_THR)
    ink = np.full((th, tw), -1, dtype=np.int32)

    if not mask.any():
        return IndexGrid(data=ink, visible=False), palette

    mode = p["recolor"]["mode"]
    darken = float(p["recolor"]["darken"])
    if mode == "selective":
        fill_rgb = palette.colors[fill.data]  # (th, tw, 3) uint8
        lin = srgb_to_linear(fill_rgb[mask])
        dark = linear_to_srgb(np.clip(lin * (1.0 - darken), 0.0, 1.0))
        index_of = {tuple(int(v) for v in c): i for i, c in enumerate(palette.colors)}
        extra: list[tuple[int, int, int]] = []
        base = len(palette.colors)
        ys, xs = np.nonzero(mask)
        for row, (y, x) in enumerate(zip(ys, xs)):
            t = tuple(int(v) for v in dark[row])
            i = index_of.get(t)
            if i is None:
                i = base + len(extra)
                index_of[t] = i
                extra.append(t)
            ink[y, x] = i
        if extra:
            palette = Palette(
                colors=np.vstack([palette.colors, np.array(extra, dtype=np.uint8)]),
                name=palette.name + "+ink",
                source=palette.source,
            )
    else:  # black：吸附最近调色板色，调色板不变
        black = np.array([[[10, 10, 14]]], dtype=np.uint8)  # 1×1 像素
        idx = int(nearest_palette_index(black, palette)[0, 0])
        ink[mask] = idx

    return IndexGrid(data=ink), palette
