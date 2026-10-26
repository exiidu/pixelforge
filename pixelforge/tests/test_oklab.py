"""OKLab 实现的单元测试——引擎中第一个可运行验证点。"""

import numpy as np
import pytest

from engine.core.oklab import (
    delta_e,
    linear_rgb_to_oklab,
    linear_to_srgb,
    oklab_to_linear_rgb,
    rgb_to_oklab,
    srgb_to_linear,
)


def test_srgb_linear_roundtrip():
    rgb = np.arange(256, dtype=np.uint8).repeat(3).reshape(-1, 3)
    back = linear_to_srgb(srgb_to_linear(rgb))
    assert np.array_equal(back, rgb)


def test_oklab_roundtrip():
    rng = np.random.default_rng(42)
    lin = rng.random((64, 3)).astype(np.float32)
    back = oklab_to_linear_rgb(linear_rgb_to_oklab(lin))
    assert np.allclose(back, lin, atol=1e-3)


def test_white_black_extremes():
    white = rgb_to_oklab(np.array([[255, 255, 255]], dtype=np.uint8))
    black = rgb_to_oklab(np.array([[0, 0, 0]], dtype=np.uint8))
    assert white[0, 0] == pytest.approx(1.0, abs=1e-3)
    assert black[0, 0] == pytest.approx(0.0, abs=1e-4)
    # 白到黑是最大色距，应明显大于红绿之差
    red = rgb_to_oklab(np.array([[255, 0, 0]], dtype=np.uint8))
    green = rgb_to_oklab(np.array([[0, 255, 0]], dtype=np.uint8))
    d_wb = float(delta_e(white, black)[0, 0])
    d_rg = float(delta_e(red, green)[0, 0])
    assert d_wb > d_rg > 0.05
