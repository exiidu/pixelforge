"""统一图片加载（引擎与 CLI 共用）。

两个历史坑（2026-10-25 视觉验收发现）：
1. RGBA 直接 convert("RGB") 会丢 alpha——透明像素底下的 RGB 多为抠图残留噪声，
   丢掉 alpha 后噪声全数暴露（"背景变噪音"）。处理：先转 RGBA 再合成白底。
2. 带 ICC 配置文件的照片（如 Adobe RGB）默认按原始值读入导致偏色。
   处理：存在 icc_profile 时转 sRGB。

真正的透明像素投票（输出带 alpha 的精灵）按设计文档属 v1.5，当前先保证
合成底色干净可用。
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from PIL import Image


def load_rgb(src: str | Path | bytes) -> np.ndarray:
    """从路径或字节加载为 (H, W, 3) uint8 sRGB。

    RGBA/LA/PA/P(带透明索引) → 合成白底；带 ICC → 转 sRGB。
    """
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

    if img.mode in ("RGBA", "LA", "PA") or (
        img.mode == "P" and "transparency" in img.info
    ):
        rgba = img.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[3])
        img = bg
    else:
        img = img.convert("RGB")
    return np.asarray(img)
