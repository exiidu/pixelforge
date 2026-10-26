"""S3 调色板量化：低分辨率 RGB → 索引色网格。

色距一律 OKLab。抖动默认关；目标 ≥128 且用户开启时才提供 Bayer 有序抖动
（Bayer 本批未实现，参数透传保留）。
"""

from __future__ import annotations

from engine.core.palette import (
    extract_from_image,
    load_builtin,
    nearest_palette_index,
)
from engine.recipe import Recipe
from engine.types import IndexGrid, Palette, RGBImage


def run(small_rgb: RGBImage, recipe: Recipe) -> tuple[IndexGrid, Palette]:
    q = recipe.raw["quantize"]["palette"]
    if q["source"] == "extract":
        palette = extract_from_image(small_rgb, int(q["max_colors"]))
    elif q["source"] == "builtin":
        if not q.get("ref"):
            raise ValueError("builtin 调色板需要指定 ref（如 gameboy）")
        palette = load_builtin(str(q["ref"]))
    else:
        raise NotImplementedError(f"调色板来源未实现: {q['source']}（custom 编辑器提供）")
    idx = nearest_palette_index(small_rgb, palette)
    return IndexGrid(data=idx), palette
