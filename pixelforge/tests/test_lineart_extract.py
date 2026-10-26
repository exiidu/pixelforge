"""独立线稿提取（engine/lineart.py）的单元测试。"""

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from engine import lineart as lineart_mod

MODELS = Path(__file__).resolve().parents[1] / "models"
ONNX = MODELS / "lineart" / "model.onnx"


def _square():
    img = np.full((48, 48, 3), 255, dtype=np.uint8)
    img[12:36, 12:36] = 40
    return img


def test_xdog_routing_and_paper_polarity():
    L = lineart_mod.extract(_square(), "xdog")
    assert L.shape == (48, 48)
    assert L[12, 24] > 0.3 and L[3, 3] < 0.1   # 内部约定 1=线

    png = lineart_mod.to_paper_png_bytes(L)
    paper = np.asarray(Image.open(__import__("io").BytesIO(png)))
    assert paper.mean() > 150                    # 大部分是白纸
    assert paper.min() < 100                     # 有黑线
    assert paper[3, 3] > 200                     # 平区是白的（极性正确）


def test_unknown_mode_raises():
    with pytest.raises(ValueError, match="onnx"):
        lineart_mod.extract(_square(), "canny")


@pytest.mark.skipif(not ONNX.exists(), reason="线稿模型未下载")
def test_onnx_routing():
    L = lineart_mod.extract(_square(), "onnx")
    assert L.shape == (48, 48)
    assert 0.0 <= L.min() and L.max() <= 1.0
    assert L[12, 24] > 0.3
