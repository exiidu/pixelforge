"""S3 调色板量化：低分辨率 RGB → 索引色网格。

色距一律 OKLab。抖动默认关；目标 ≥128 且用户开启时才提供 Bayer 有序抖动
（Bayer 本批未实现，参数透传保留）。

M5-4 色板锁定：quantize.palette.seed_colors 里的颜色（≤32）在 extract 时强制
保留——先从 max_colors 中扣减聚类预算，聚类结果与锁定色 ΔE < SEED_DEDUPE_DELTA
的锁定色丢弃，其余追加到色板尾部。
"""

from __future__ import annotations

import numpy as np

from engine.core.palette import (
    extract_from_image,
    load_builtin,
    nearest_palette_index,
)
from engine.recipe import Recipe
from engine.types import IndexGrid, Palette, RGBImage

SEED_MAX = 32              # 锁定色上限
SEED_DEDUPE_DELTA = 0.03   # 锁定色与已有色 OKLab ΔE 小于此值视为重复，丢弃


def _seed_colors(q: dict) -> np.ndarray:
    """规范 seed_colors 为 (N,3) uint8（截断 32、钳制 0..255）。"""
    raw = q.get("seed_colors") or []
    out: list[list[int]] = []
    for c in list(raw)[:SEED_MAX]:
        if not isinstance(c, (list, tuple)) or len(c) != 3:
            continue
        out.append([max(0, min(255, int(v))) for v in c])
    return np.asarray(out, dtype=np.uint8) if out else np.zeros((0, 3), np.uint8)


def _merge_seed_colors(base: np.ndarray, seeds: np.ndarray) -> np.ndarray:
    """锁定色去重后追加到 base 尾部（与 base 或已保留色 ΔE 过近则丢弃）。"""
    from engine.core.oklab import delta_e, rgb_to_oklab

    kept: list[np.ndarray] = []
    labs = rgb_to_oklab(base).reshape(-1, 3) if len(base) else np.zeros((0, 3), np.float32)
    for c in seeds:
        lab = rgb_to_oklab(c.reshape(1, 1, 3)).reshape(1, 3)
        if len(labs) and float(delta_e(lab, labs).min()) < SEED_DEDUPE_DELTA:
            continue
        kept.append(np.asarray(c, dtype=np.uint8).reshape(3))
        labs = np.vstack([labs, lab])
    if not kept:
        return base
    tail = np.stack(kept).astype(np.uint8)
    return np.vstack([base, tail]) if len(base) else tail


def run(small_rgb: RGBImage, recipe: Recipe) -> tuple[IndexGrid, Palette]:
    q = recipe.raw["quantize"]["palette"]
    if q["source"] == "extract":
        palette = _extract_with_seeds(small_rgb, q)
    elif q["source"] == "builtin":
        if not q.get("ref"):
            raise ValueError("builtin 调色板需要指定 ref（如 gameboy）")
        palette = load_builtin(str(q["ref"]))
    else:
        raise NotImplementedError(f"调色板来源未实现: {q['source']}（custom 编辑器提供）")
    idx = nearest_palette_index(small_rgb, palette)
    return IndexGrid(data=idx), palette


def _extract_with_seeds(small_rgb: RGBImage, q: dict) -> Palette:
    seeds = _seed_colors(q)
    max_colors = max(1, int(q["max_colors"]))
    if not len(seeds):
        return extract_from_image(small_rgb, max_colors)

    used = min(len(seeds), max_colors)
    k_extract = max_colors - used
    if k_extract > 0:
        base = extract_from_image(small_rgb, k_extract)
        colors = _merge_seed_colors(base.colors, seeds[:used])
    else:
        colors = _merge_seed_colors(np.zeros((0, 3), np.uint8), seeds[:used])
    return Palette(colors=colors, name=f"extract+{used}seed", source="extract")
