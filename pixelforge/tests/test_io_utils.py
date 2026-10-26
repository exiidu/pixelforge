"""统一图片加载 io_utils 的单元测试。"""

import io

import numpy as np
from PIL import Image

from engine.io_utils import load_rgb, load_rgb_with_alpha


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


def test_with_alpha_matches_rgb_and_keeps_mask():
    """load_rgb_with_alpha 的 rgb 与 load_rgb 一致，alpha 反映源透明。"""
    arr = np.zeros((10, 10, 4), np.uint8)
    arr[..., 3] = 0
    arr[3:7, 3:7] = [200, 30, 30, 255]
    arr[0, 0] = [1, 2, 3, 128]  # 半透明
    png = _png_bytes(Image.fromarray(arr, mode="RGBA"))

    rgb, alpha = load_rgb_with_alpha(png)
    assert rgb.shape == (10, 10, 3) and alpha.shape == (10, 10)
    assert (rgb == load_rgb(png)).all()             # 与旧加载完全一致
    assert alpha[5, 5] == 1.0                       # 不透明区
    assert abs(float(alpha[0, 0]) - 128 / 255) < 1e-3  # 半透明保留
    assert alpha[9, 9] == 0.0                       # 全透明区


def test_with_alpha_opaque_has_ones():
    img = np.zeros((6, 6, 3), np.uint8)
    img[...] = [10, 200, 30]
    _rgb, alpha = load_rgb_with_alpha(_png_bytes(Image.fromarray(img, mode="RGB")))
    assert alpha.shape == (6, 6) and (alpha == 1.0).all()
