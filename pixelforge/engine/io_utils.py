"""统一图片加载（引擎与 CLI 共用）。

两个历史坑（2026-10-25 视觉验收发现）：
1. RGBA 直接 convert("RGB") 会丢 alpha——透明像素底下的 RGB 多为抠图残留噪声，
   丢掉 alpha 后噪声全数暴露（"背景变噪音"）。处理：先转 RGBA 再合成白底。
2. 带 ICC 配置文件的照片（如 Adobe RGB）默认按原始值读入导致偏色。
   处理：存在 icc_profile 时转 sRGB。

M5-0 起额外提供 load_rgb_with_alpha：同样合成白底给 RGB，但把源 alpha 作为
(H,W) float32 0..1 一并返回，供管线生成"与 fill 正交"的网格 alpha。
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from PIL import Image


def _open_srgb(src: str | Path | bytes) -> Image.Image:
    """打开图片并在存在 ICC 时转换到 sRGB（无效配置按原图处理）。"""
    img = Image.open(io.BytesIO(src) if isinstance(src, (bytes, bytearray)) else src)

    icc = img.info.get("icc_profile")
    if icc:
        try:
            from PIL import ImageCms

            img = ImageCms.profileToProfile(
                img,
                ImageCms.ImageCmsProfile(io.BytesIO(icc)),
                ImageCms.createProfile("sRGB"),
            )
        except Exception:  # noqa: BLE001 —— 无效配置文件时按原图处理
            pass
    return img


def _has_alpha(img: Image.Image) -> bool:
    return img.mode in ("RGBA", "LA", "PA") or (
        img.mode == "P" and "transparency" in img.info
    )


def load_rgb(src: str | Path | bytes) -> np.ndarray:
    """从路径或字节加载为 (H, W, 3) uint8 sRGB。

    RGBA/LA/PA/P(带透明索引) → 合成白底；带 ICC → 转 sRGB。
    """
    img = _open_srgb(src)

    if _has_alpha(img):
        rgba = img.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[3])
        img = bg
    else:
        img = img.convert("RGB")
    return np.asarray(img)


def load_rgb_with_alpha(src: str | Path | bytes) -> tuple[np.ndarray, np.ndarray]:
    """加载为 (rgb, alpha)：rgb 同 load_rgb（白底合成），alpha 为 (H, W) float32 0..1。

    无 alpha 通道的图片 alpha 全 1。ICC 处理与 load_rgb 一致。
    """
    img = _open_srgb(src)

    if _has_alpha(img):
        rgba = img.convert("RGBA")
        alpha_img = rgba.split()[3]
        alpha = np.asarray(alpha_img, dtype=np.float32) / 255.0
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=alpha_img)
        rgb = np.asarray(bg)
    else:
        rgb = np.asarray(img.convert("RGB"))
        alpha = np.ones(rgb.shape[:2], dtype=np.float32)
    return rgb, alpha
