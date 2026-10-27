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


# ---------------- 0.4.0：稀疏 Top-K 与稠密实现等价 ----------------

def _bucketize(flat: np.ndarray) -> np.ndarray:
    return (
        ((flat[:, 0] >> s2_sampling._BUCKET_SHIFT).astype(np.int64) * s2_sampling._BUCKETS_PER_CH
         + (flat[:, 1] >> s2_sampling._BUCKET_SHIFT).astype(np.int64))
        * s2_sampling._BUCKETS_PER_CH
        + (flat[:, 2] >> s2_sampling._BUCKET_SHIFT).astype(np.int64)
    )


def test_sparse_top_candidates_match_dense():
    """非并列权重下，稀疏直方图必须选出与稠密版相同的 Top-K。"""
    from engine.core.oklab import srgb_to_linear

    rng = np.random.default_rng(11)
    img = rng.integers(0, 256, (48, 40, 3), dtype=np.uint8)
    mapping = build_mapping((48, 40), (12, 16))
    n_cells = 12 * 16
    flat = img.reshape(-1, 3)
    lin = srgb_to_linear(flat).astype(np.float32)
    w = rng.random(len(flat)).astype(np.float32)  # 权重互不相等，避免并列
    bucket = _bucketize(flat)

    dw, dc = s2_sampling._top_candidates_dense(mapping, bucket, w, lin, n_cells)
    sw, sc = s2_sampling._top_candidates_sparse(mapping, bucket, w, lin, n_cells)

    assert np.allclose(np.sort(dw, axis=1), np.sort(sw, axis=1))
    assert np.allclose(dc.sum(1), sc.sum(1), atol=1e-5)


def test_top_candidates_small_grid_uses_dense_branch():
    from engine.core.oklab import srgb_to_linear

    rng = np.random.default_rng(12)
    img = rng.integers(0, 256, (16, 16, 3), dtype=np.uint8)
    mapping = build_mapping((16, 16), (16, 16))
    n_cells = 16 * 16
    flat = img.reshape(-1, 3)
    lin = srgb_to_linear(flat).astype(np.float32)
    w = rng.random(len(flat)).astype(np.float32)
    bucket = _bucketize(flat)

    hybrid = s2_sampling._top_candidates(mapping, bucket, w, lin, n_cells)
    dense = s2_sampling._top_candidates_dense(mapping, bucket, w, lin, n_cells)
    assert np.array_equal(hybrid[0], dense[0]) and np.array_equal(hybrid[1], dense[1])


# ---------------- 放大网格的空档回填（黑色发丝线修复） ----------------

def _recipe(tw: int, th: int):
    from engine.recipe import load_recipe
    return load_recipe("photo", {"target": {"width": tw, "height": th}})


def test_upscale_solid_image_has_no_black_holes():
    """放大（源 4×4 → 网格 6×6）时空档格必须回填，不能落成黑。"""
    img = np.full((4, 4, 3), 200, dtype=np.uint8)
    E = np.zeros((4, 4), dtype=np.float32)
    out = s2_sampling.run(img, E, _recipe(6, 6), (6, 6))
    assert out.shape == (6, 6, 3)
    assert (out > 150).all(), f"存在黑色空档格：min={out.min()}"


def test_upscale_preserves_source_colors():
    """放大后每格颜色应取自源像素（最近邻展开），不引入新色、不出现黑格。"""
    img = np.zeros((2, 2, 3), dtype=np.uint8)
    img[0, 0], img[0, 1] = [255, 0, 0], [0, 255, 0]
    img[1, 0], img[1, 1] = [0, 0, 255], [255, 255, 0]
    E = np.zeros((2, 2), dtype=np.float32)
    out = s2_sampling.run(img, E, _recipe(5, 5), (5, 5)).reshape(-1, 3).astype(np.int16)
    src = np.array([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]], dtype=np.int16)
    nearest = np.abs(out[:, None, :] - src[None, :, :]).max(-1).min(1)
    assert (nearest <= 2).all(), f"偏离源色过多：{nearest.max()}"


def test_downscale_output_unchanged_by_fill():
    """缩小/等尺寸时 covered 全 True，回填是空操作（回归保护）。"""
    img = np.full((16, 16, 3), 90, dtype=np.uint8)
    E = np.zeros((16, 16), dtype=np.float32)
    m = build_mapping((16, 16), (4, 4))
    sampled = s2_sampling.sample_mean(img, m)
    assert s2_sampling.fill_empty_cells(sampled, img, m) is sampled  # 直接返回、未拷贝
    out = s2_sampling.run(img, E, _recipe(4, 4), (4, 4))
    assert (out == 90).all()
