"""统一图片加载 io_utils 的单元测试。"""

import io

import numpy as np
from PIL import Image

from engine.io_utils import load_rgb


def _png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_rgba_noise_under_transparency_becomes_white():
    """透明像素下的噪声 RGB 合成后应为白底，不暴露。"""
    rng = np.random.default_rng(7)
    arr = rng.integers(0, 256, (16, 16, 4), dtype=np.uint8)
    arr[..., 3] = 0                       # 全透明，RGB 全是噪声
    arr[4:12, 4:12] = [200, 30, 30, 255]  # 中央不透明红块

    out = load_rgb(_png_bytes(Image.fromarray(arr, mode="RGBA")))
    assert out.shape == (16, 16, 3)
    assert (out[0, 0] == 255).all()               # 透明处 → 白
    assert (out[8, 8] == [200, 30, 30]).all()     # 不透明处保色


def test_plain_rgb_passthrough():
    img = np.zeros((8, 8, 3), np.uint8)
    img[...] = [10, 200, 30]
    out = load_rgb(_png_bytes(Image.fromarray(img, mode="RGB")))
    assert (out == [10, 200, 30]).all()


def test_palette_with_transparency_index():
    img = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    img.paste((50, 150, 250, 255), (2, 2, 6, 6))
    pal = img.convert("P")  # P 模式 + 透明索引
    out = load_rgb(_png_bytes(pal))
    assert (out[0, 0] == 255).all()
    assert (out[4, 4] == [50, 150, 250]).all()
