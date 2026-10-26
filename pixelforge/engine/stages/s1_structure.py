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
    """Sobel 幅值，按图像自身对比度自适应归一化，钳到 0..1。

    旧版固定除 720：低对比/浅色图整体 E 偏小 → XDoG 的 gate 与 S2 的 edge/dark 权重一起偏弱。
    改为按自身 p99 定标，并钳在 [180, 720]：最多放大约 4×（防把噪声放大），
    且不会比旧的固定 720 更弱（高对比图行为不变）。
    """
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
    ref = min(max(float(np.percentile(mag, 99.0)), 180.0), 720.0)
    np.clip(mag / ref, 0.0, 1.0, out=mag)
    return mag.astype(np.float32)


def xdog_lineart(image: RGBImage, recipe: Recipe) -> GrayMap:
    """XDoG 线稿（Winnemöller 2012），输出 1=线、0=纸。

    D = (1+p)·G_σ − p·G_{kσ}；T = 1 (D≥ε) else 1+tanh(φ·(D−ε))。
    XDoG 对暗部平区会整体变黑（已知特性），用边缘门控 E>0.05 压掉——
    只保留真正落在结构边缘上的线。

    已知局限（实测 test2.jpg）：ε 是**绝对亮度阈值**，比 ε 亮的区域被当作"纸"，
    而天空/云的层次是极低对比的软梯度（σ=1.2 时半数天空格的线稿响应恰为 0），
    因此浅色区出不了一致性轮廓。

    M5.3 实验开关 `log_domain`（**默认 False = 与改动前逐位一致，可随时关掉回滚**）：
    在 **log 亮度**（Weber 定律：对比度 ∝ ΔI/I）上补一条**只作用于亮部**的线——
    亮区 1–2 个灰度级的软梯度能出线，暗部结果不变（np.maximum 合并）。
    """
    import cv2

    params = recipe.raw["structure"]["lineart"].get("xdog", {})
    sigma = float(params.get("sigma", 1.2))
    k = 1.6
    p = float(params.get("p", 20.0))
    epsilon = float(params.get("epsilon", 0.72))
    phi = 20.0
    log_domain = bool(params.get("log_domain", False))
    log_gain = float(params.get("log_gain", 3.0))
    log_scale = float(params.get("log_scale", 1.0))

    gray = (
        image.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32) / 255.0
    )
    g1 = cv2.GaussianBlur(gray, (0, 0), sigma)
    g2 = cv2.GaussianBlur(gray, (0, 0), sigma * k)
    D = (1.0 + p) * g1 - p * g2
    T = np.where(D >= epsilon, 1.0, 1.0 + np.tanh(phi * (D - epsilon)))
    line = 1.0 - T
    line = line * (edge_strength(image, recipe) > 0.05)  # 压掉"暗部平区整体变黑"

    if log_domain:
        s_l = max(0.5, sigma * log_scale)
        lg = np.log(np.maximum(gray, 1.0 / 255.0))
        l1 = cv2.GaussianBlur(lg, (0, 0), s_l)
        l2 = cv2.GaussianBlur(lg, (0, 0), s_l * k)
        dev = l1 - l2                       # >0：比更远邻域暗（相对对比，与绝对亮度无关）
        rel = np.clip(np.tanh(phi * log_gain * dev), 0.0, 1.0)
        strong = np.clip(np.abs(dev) / (2.0 / 255.0), 0.0, 1.0)  # ≈0.8% 相对对比地板，防 8bit/JPEG 噪声
        ramp = np.clip((g1 - 0.5) / 0.3, 0.0, 1.0)               # 仅亮部生效
        line = np.maximum(line, rel * strong * ramp)

    return np.clip(line, 0.0, 1.0).astype(np.float32)


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
