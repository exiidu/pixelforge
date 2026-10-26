"""S2 采样的单元测试——直接验证用户问题 1（颜色稀释）与 2.1（暗部权重）。"""

import numpy as np

from engine.core.grid import build_mapping
from engine.stages import s2_sampling


def test_mean_constant_image_unchanged():
    img = np.full((8, 8, 3), 200, dtype=np.uint8)
    out = s2_sampling.sample_mean(img, build_mapping((8, 8), (4, 4)))
    assert out.shape == (4, 4, 3)
    assert (out == 200).all()


def test_mean_dilutes_thin_dark_line():
    """均值模式：格内 50% 黑线被平均成中灰（问题 1 的最小复现）。"""
    img = np.full((16, 16, 3), 255, dtype=np.uint8)
    img[:, 6:8] = 20  # 2px 竖线，完整落在第 2 列格子（cols 4..7）内
    out = s2_sampling.sample_mean(img, build_mapping((16, 16), (4, 4)))
    mean_px = out[0, 1].astype(int)
    assert 80 < mean_px.max() < 230  # 既不是黑也不是白：被稀释


def test_weighted_mode_keeps_thin_dark_line():
    """加权众数：同样的线，暗部权重让黑色赢家通吃。"""
    img = np.full((16, 16, 3), 255, dtype=np.uint8)
    img[:, 6:8] = 20
    E = np.zeros((16, 16), dtype=np.float32)
    out = s2_sampling.sample_weighted_mode(
        img, build_mapping((16, 16), (4, 4)), E, edge_weight=0.0, dark_weight=1.5
    )
    assert out[0, 1].max() < 60      # 线所在格子保持黑
    assert out[0, 0].max() > 240     # 纯白格子不受影响


def test_weighted_mode_edge_weight_favors_edges():
    """边缘权重：亮色边缘特征在仅靠暗部权重赢不了时，靠 edge 权重胜出。"""
    img = np.full((16, 16, 3), 120, dtype=np.uint8)
    img[:, 6:8] = 200  # 更亮而非更暗的特征
    E = np.zeros((16, 16), dtype=np.float32)
    E[:, 6:8] = 1.0    # 特征处强边缘
    out = s2_sampling.sample_weighted_mode(
        img, build_mapping((16, 16), (4, 4)), E, edge_weight=2.0, dark_weight=0.0
    )
    assert out[0, 1].max() > 170     # 亮边缘特征保留


# ---------------- v1.1：软赢家 / 桶合并 / 局部显著性权重 ----------------

def _zeros_map(shape=(16, 16)):
    return np.zeros(shape, dtype=np.float32)


def test_soft_winner_blends_tied_gradient():
    """软赢家：渐变区前两名桶票数接近时按比例混合，退化为线性均值（吸收 mean 的平滑）。"""
    img = np.zeros((16, 16, 3), dtype=np.uint8)
    for x in range(16):                      # 逐列渐变 8..248
        img[:, x] = 16 * x + 8
    m = build_mapping((16, 16), (4, 4))
    out = s2_sampling.sample_weighted_mode(
        img, m, _zeros_map(), edge_weight=0, dark_weight=0, contrast_weight=0,
        soft_ratio=1.4,
    )
    # 格 0 覆盖 8/24/40/56：两桶票数并列 → 混合 = 线性均值 ≈ sRGB 37
    assert 33 <= out[0, 0].max() <= 41
    # 关掉软赢家（soft_ratio=1）则退回赢家通吃：只剩单一桶的深/中色，不再是混合值
    off = s2_sampling.sample_weighted_mode(
        img, m, _zeros_map(), edge_weight=0, dark_weight=0, contrast_weight=0,
        soft_ratio=1.0,
    )
    assert not (33 <= off[0, 0].max() <= 41)  # 并列时胜者桶顺序不定，只断言"未混合"


def test_bucket_merge_rescues_split_line():
    """桶合并：线跨桶边界（30/34 分属两桶）选票被劈开时，ΔE 合并让线赢回来。"""
    img = np.full((16, 16, 3), 200, dtype=np.uint8)
    img[:, 6] = 30      # 桶 0
    img[:, 7] = 34      # 桶 1（与 30 感知上几乎同色）
    m = build_mapping((16, 16), (4, 4))
    merged = s2_sampling.sample_weighted_mode(
        img, m, _zeros_map(), edge_weight=0, dark_weight=0.5, contrast_weight=0,
        merge_delta=0.05,
    )
    split = s2_sampling.sample_weighted_mode(
        img, m, _zeros_map(), edge_weight=0, dark_weight=0.5, contrast_weight=0,
        merge_delta=0.0,   # 关闭合并即复现分裂缺陷
    )
    assert merged[0, 1].max() < 60    # 合并后线保住
    assert split[0, 1].max() > 150    # 分裂时输给了背景（缺陷的回归基线）


def test_contrast_weight_keeps_bright_highlight():
    """局部显著性权重：中灰背景上的小亮块（无边缘图辅助）凭"与周围不同"赢得格子。"""
    img = np.full((16, 16, 3), 120, dtype=np.uint8)
    img[0:3, 4:6] = 255  # 2×3 白色高光，落在格 (0,1)
    m = build_mapping((16, 16), (4, 4))
    with_w = s2_sampling.sample_weighted_mode(
        img, m, _zeros_map(), edge_weight=0, dark_weight=0, contrast_weight=3.0,
        soft_ratio=1.0,  # 关软混合以隔离对比项的胜负
    )
    without = s2_sampling.sample_weighted_mode(
        img, m, _zeros_map(), edge_weight=0, dark_weight=0, contrast_weight=0.0,
        soft_ratio=1.0,
    )
    assert with_w[0, 1].min() > 200   # 高光保住
    assert without[0, 1].max() < 160  # 无此项时按像素数输给背景
