"""S0 预处理：双边去噪 → 色阶/饱和度补偿 → [可选] 抠主体。

解决：照片噪点量化后变彩色雪花（必开双边）；量化饱和度损失的预补偿。
抠图走 AIProviders.matting（v1 仅接口）。
"""

from __future__ import annotations

import numpy as np

from engine.ai.base import MattingProvider
from engine.recipe import Recipe
from engine.types import RGBImage


def _boost_bright_contrast(rgb: np.ndarray, c: float, start: float) -> np.ndarray:
    """亮部 S 曲线对比增强（亮度自适应，**暗部与中间调完全不动**）。

    在 [start, 1] 区间做以中点为轴的 S 曲线（t2 = t − c·(t − smoothstep(t))）：
    两端固定（不裁切、不动最亮/最暗端），区间中点斜率 = 1 + c/2 —— c 越大，
    亮区里的小幅差（天空/云的软梯度）被拉得越开，量化后才会分化成不同色块。
    按比例缩放 RGB 以保持色相/饱和度。
    """
    c = max(0.0, min(0.95, float(c)))
    start = max(0.0, min(0.95, float(start)))
    if c <= 0.0 or start >= 1.0:
        return rgb
    arr = rgb.astype(np.float32)
    lum = arr @ np.array([0.299, 0.587, 0.114], np.float32) / 255.0
    t = np.clip((lum - start) / (1.0 - start), 0.0, 1.0)
    ss = t * t * (3.0 - 2.0 * t)
    t2 = t - c * (t - ss)
    # 只叠加曲线带来的"增量"：lum < start 时 t=t2=0 → 增量为 0（像素原样保留）。
    # 早期版本写成 new_lum = start + t2*(1-start)，会把所有暗部/中间调抬到 start（严重过曝/偏色）。
    new_lum = lum + (t2 - t) * (1.0 - start)
    safe = np.maximum(lum, 1e-4)
    scale = np.where(lum > 1e-4, new_lum / safe, 1.0)
    return np.clip(arr * scale[..., None], 0, 255).astype(np.uint8)


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

    # M5.3：亮部对比增强（默认 0 = 关，行为与改动前逐位一致）
    out = _boost_bright_contrast(out, float(levels.get("bright_contrast", 0.0)),
                                 float(levels.get("bright_start", 0.6)))

    if p["matting"]["enable"]:
        out, _alpha = matting.remove_background(out)

    return out
