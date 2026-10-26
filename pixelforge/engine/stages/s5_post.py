"""S5 后处理与导出：孤立像素清理 → 索引 PNG + 元数据。"""

from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image

from engine.types import ConversionResult


def despeckle(result: ConversionResult, strength: int) -> None:
    """3×3 十字邻域内四邻全同色且异于中心的格子并入邻色。0=关。"""
    if strength <= 0 or result.fill is None:
        return
    for _ in range(int(strength)):
        d = result.fill.data
        h, w = d.shape
        if h < 3 or w < 3:
            return
        p = np.pad(d, 1, mode="edge")
        left, right = p[1:-1, :-2], p[1:-1, 2:]
        up, down = p[:-2, 1:-1], p[2:, 1:-1]
        same = (left == right) & (right == up) & (up == down)
        replace = same & (left != d)
        d[replace] = left[replace]


def export_png(result: ConversionResult) -> bytes:
    """带 PLTE 的索引 PNG。"""
    img = Image.fromarray(result.fill.data.astype(np.uint8), mode="P")
    img.putpalette(result.palette.colors.reshape(-1).tolist())
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def composite_preview(result: ConversionResult, scale: int = 8) -> "Image.Image":
    """整数倍最近邻放大预览图（墨线层若存在则叠加）。"""
    fill = result.palette.colors[result.fill.data].astype(np.uint8)
    img = Image.fromarray(fill, mode="RGB")
    if result.ink is not None and result.ink.visible:
        ink_rgb = result.palette.colors[result.ink.data].astype(np.uint8)
        ink_rgb[result.ink.data < 0] = 0
        overlay = Image.fromarray(ink_rgb, mode="RGB")
        mask = Image.fromarray(
            np.where(result.ink.data >= 0, 255, 0).astype(np.uint8), mode="L"
        )
        img = Image.composite(overlay, img, mask)
    if scale > 1:
        img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
    return img
