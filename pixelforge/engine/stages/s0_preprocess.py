"""S0 预处理：双边去噪 → 色阶/饱和度补偿 → [可选] 抠主体。

解决：照片噪点量化后变彩色雪花（必开双边）；量化饱和度损失的预补偿。
抠图走 AIProviders.matting（v1 仅接口）。
"""

from __future__ import annotations

import numpy as np

from engine.ai.base import MattingProvider
from engine.recipe import Recipe
from engine.types import RGBImage


def run(image: RGBImage, recipe: Recipe, matting: MattingProvider) -> RGBImage:
    p = recipe.raw["preprocess"]
    out = image

    bil = p["bilateral"]
    if bil["enable"]:
        import cv2

        # strength(0..1) 映射到 sigmaColor/sigmaSpace 的常用范围
        sigma = 25 + 100 * float(bil["strength"])
        out = cv2.bilateralFilter(out, int(bil["radius"]) * 2 + 1, sigma, sigma)

    levels = p["levels"]
    sat, con = float(levels["saturation"]), float(levels["contrast"])
    if sat != 1.0 or con != 1.0:
        arr = out.astype(np.float32)
        gray = arr @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
        arr = gray[..., None] + (arr - gray[..., None]) * sat
        arr = (arr - 128.0) * con + 128.0
        out = np.clip(arr, 0, 255).astype(np.uint8)

    if p["matting"]["enable"]:
        out, _alpha = matting.remove_background(out)

    return out
