"""ONNX Provider 的单元测试（模型缺失时自动跳过）。"""

from pathlib import Path

import numpy as np
import pytest

MODELS = Path(__file__).resolve().parents[1] / "models"
LINEART = MODELS / "lineart" / "model.onnx"
MATTING = MODELS / "matting" / "u2net.onnx"


@pytest.mark.skipif(not LINEART.exists(), reason="线稿模型未下载")
def test_lineart_edges_high_flats_low():
    from engine.ai.onnx_lineart import OnnxLineartProvider

    img = np.full((96, 96, 3), 255, dtype=np.uint8)
    img[24:72, 24:72] = 40  # 深色方块
    L = OnnxLineartProvider().extract(img)

    assert L.shape == (96, 96)
    edge = np.concatenate([L[24, 30:60], L[30:60, 24], L[71, 30:60], L[30:60, 71]])
    flat = np.concatenate([L[5:15, 5:15].ravel(), L[40:56, 40:56].ravel()])
    assert edge.max() > 0.3           # 边缘处出线
    assert edge.mean() > flat.mean() + 0.1  # 边缘显著强于平区
    assert flat.mean() < 0.25         # 平区（含暗平区）基本无线


@pytest.mark.skipif(not LINEART.exists(), reason="线稿模型未下载")
def test_lineart_missing_model_raises_clearly(tmp_path):
    from engine.ai.onnx_lineart import OnnxLineartProvider

    with pytest.raises(FileNotFoundError, match="models/README.md"):
        OnnxLineartProvider(model_path=tmp_path / "nope.onnx").extract(
            np.zeros((8, 8, 3), np.uint8)
        )


@pytest.mark.skipif(not MATTING.exists(), reason="抠图模型未下载")
def test_matting_segments_bright_subject():
    from engine.ai.rembg_matting import U2NetMattingProvider

    img = np.zeros((160, 160, 3), dtype=np.uint8)
    yy, xx = np.mgrid[:160, :160]
    mask = (xx - 80) ** 2 + (yy - 80) ** 2 < 50 ** 2
    img[mask] = [230, 180, 90]  # 黑底上的亮色主体
    _fg, alpha = U2NetMattingProvider().remove_background(img)

    assert alpha.shape == (160, 160)
    assert alpha[80, 80] > 0.7          # 主体中心高
    assert alpha[10, 10] < 0.3          # 背景角落低
    assert alpha[80, 80] > alpha[10, 10] + 0.4


def test_providers_wire_into_ai_providers():
    """模型在位时 AIProviders 应自动挂真实现（惰性，不触发加载）。"""
    from engine.pipeline import AIProviders

    ai = AIProviders()
    if LINEART.exists():
        assert "OnnxLineart" in type(ai.lineart).__name__
    if MATTING.exists():
        assert "U2Net" in type(ai.matting).__name__
    assert "Unavailable" in type(ai.regen).__name__
