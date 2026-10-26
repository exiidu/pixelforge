"""独立线稿提取（一等功能）：xdog（快，纯算法）| onnx（高质量，Informative Drawings）。

内部约定 1=线（与 S1/S4 一致）；导出用黑线白纸的通行显示约定（255·(1−L)）。
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image

from engine.types import GrayMap, RGBImage


def extract(image: RGBImage, mode: str = "onnx") -> GrayMap:
    """返回与输入同尺寸的线稿强度图，1=线。mode: onnx | xdog。"""
    if mode == "onnx":
        from engine.ai.onnx_lineart import OnnxLineartProvider

        return OnnxLineartProvider().extract(image)
    if mode == "xdog":
        from engine.recipe import load_recipe
        from engine.stages.s1_structure import xdog_lineart

        return xdog_lineart(image, load_recipe(None))
    raise ValueError(f"未知线稿模式: {mode}（可选 onnx | xdog）")


def to_paper_png_bytes(L: GrayMap) -> bytes:
    """黑线白纸显示约定：L(1=线) → 255·(1−L)。"""
    paper = np.clip(255.0 * (1.0 - L), 0, 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(paper, mode="L").save(buf, format="PNG")
    return buf.getvalue()
