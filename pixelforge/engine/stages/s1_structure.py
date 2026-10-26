"""S1 结构分析：边缘强度图 E + 线稿 L。

- E = 归一化 Sobel 幅值（DoG 分量待 golden 验证后按需加入）：S2 权重、重要度图分量
- 线稿三档：off | xdog（下一批实现，暂返回 None）| onnx（AI 档，v1 仅接口）
"""

from __future__ import annotations

import numpy as np

from engine.ai.base import LineartProvider
from engine.recipe import Recipe
from engine.types import GrayMap, RGBImage


def edge_strength(image: RGBImage, recipe: Recipe) -> GrayMap:
    """Sobel 幅值，/720 经验归一化（与前端原型一致），钳到 0..1。"""
    gray = image.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    # Sobel：列方向梯度 gx、行方向梯度 gy（切片实现 3x3 核）
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[1:-1, 1:-1] = (
        -gray[:-2, :-2] - 2 * gray[1:-1, :-2] - gray[2:, :-2]
        + gray[:-2, 2:] + 2 * gray[1:-1, 2:] + gray[2:, 2:]
    )
    gy[1:-1, 1:-1] = (
        -gray[:-2, :-2] - 2 * gray[:-2, 1:-1] - gray[:-2, 2:]
        + gray[2:, :-2] + 2 * gray[2:, 1:-1] + gray[2:, 2:]
    )
    mag = np.sqrt(gx * gx + gy * gy)
    np.clip(mag / 720.0, 0.0, 1.0, out=mag)
    return mag.astype(np.float32)


def xdog_lineart(image: RGBImage, recipe: Recipe) -> GrayMap:
    """XDoG 线稿（Winnemöller 2012），输出 1=线、0=纸。

    D = (1+p)·G_σ − p·G_{kσ}；T = 1 (D≥ε) else 1+tanh(φ·(D−ε))。
    XDoG 对暗部平区会整体变黑（已知特性），用边缘门控 E>0.05 压掉——
    只保留真正落在结构边缘上的线。
    """
    import cv2

    params = recipe.raw["structure"]["lineart"].get("xdog", {})
    sigma = float(params.get("sigma", 1.2))
    k = 1.6
    p = float(params.get("p", 20.0))
    epsilon = float(params.get("epsilon", 0.72))
    phi = 20.0

    gray = (
        image.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32) / 255.0
    )
    g1 = cv2.GaussianBlur(gray, (0, 0), sigma)
    g2 = cv2.GaussianBlur(gray, (0, 0), sigma * k)
    D = (1.0 + p) * g1 - p * g2
    T = np.where(D >= epsilon, 1.0, 1.0 + np.tanh(phi * (D - epsilon)))
    line = 1.0 - T

    gate = edge_strength(image, recipe) > 0.05
    return np.clip(line * gate, 0.0, 1.0).astype(np.float32)


def run(
    P0: RGBImage, recipe: Recipe, lineart: LineartProvider
) -> tuple[GrayMap, GrayMap | None]:
    E = edge_strength(P0, recipe)
    mode = recipe.raw["structure"]["lineart"]["mode"]
    L: GrayMap | None = None
    if mode == "onnx":
        L = lineart.extract(P0)
    elif mode == "xdog":
        L = xdog_lineart(P0, recipe)  # 暂抛 NotImplementedError，见上
    return E, L
