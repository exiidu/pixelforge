"""OKLab 色彩空间：量化与调色板提取统一使用的感知均匀色距。

管线内约定：颜色距离一律在 OKLab 下计算（量化最近色、提取聚类、
selective outline 的加深），避免 sRGB/欧氏距离导致的色带偏差。
参考： Björn Ottosson, "A perceptual color space for image processing" (2020).
"""

from __future__ import annotations

import numpy as np

# sRGB (0..255) -> 线性光 (0..1)。所有平均/滤波必须在线性空间进行，
# 否则中间调发灰（gamma 编码空间做平均在数学上是错的）。
_SRGB_TO_LIN_LUT = np.where(
    np.arange(256) / 255.0 <= 0.04045,
    np.arange(256) / 255.0 / 12.92,
    ((np.arange(256) / 255.0 + 0.055) / 1.055) ** 2.4,
).astype(np.float32)


def srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    """(…, 3) uint8 sRGB -> (…, 3) float32 线性光 0..1"""
    return _SRGB_TO_LIN_LUT[rgb]


def linear_to_srgb(lin: np.ndarray) -> np.ndarray:
    """(…, 3) float 线性光 -> uint8 sRGB"""
    lin = np.clip(lin, 0.0, 1.0)
    srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)
    return np.round(srgb * 255.0).astype(np.uint8)


def linear_rgb_to_oklab(lin: np.ndarray) -> np.ndarray:
    """(…, 3) 线性光 -> (…, 3) OKLab (L, a, b)。L 约 0..1，a/b 约 ±0.4。"""
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = np.cbrt(l), np.cbrt(m), np.cbrt(s)
    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return np.stack([L, a, b2], axis=-1).astype(np.float32)


def oklab_to_linear_rgb(lab: np.ndarray) -> np.ndarray:
    """(…, 3) OKLab -> (…, 3) 线性光。供调色板颜色微调后写回用。"""
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    b2 = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return np.stack([r, g, b2], axis=-1)


def rgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    return linear_rgb_to_oklab(srgb_to_linear(rgb))


def delta_e(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """OKLab 欧氏距离。支持 (N,3)x(M,3) 广播成 (N,M)。"""
    return np.linalg.norm(a[..., None, :] - b[None, ...], axis=-1)
