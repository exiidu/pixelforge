"""S2 网格下采样：管线核心（v1.1），解决「直接缩小颜色变淡」与「轮廓被吃掉」。

主引擎 weighted_mode（v1.1 三项升级）：
- 权重: w = 1 + edge_w·E + dark_w·(1−亮度) + contrast_w·局部显著性
  （局部显著性 = 像素与 5×5 邻域均色的线性色距，让"亮但与周围不同"的特征
  如眼睛高光也能赢得格子，替代纯暗部权重的误伤）
- 桶合并: 投票后取每格 Top-4 桶，OKLab ΔE < merge_delta 的候选并入第一名——
  修复一条线跨桶边界时选票被劈开、反输给背景的经典众数缺陷
- 软赢家: 合并后第一名与第二名权重比 < soft_ratio 时按票数比例线性混合——
  渐变区自然退化为加权均值（吸收 mean 模式的平滑性，消除赢家通吃的色带）

mean 模式保留为对照/退化行为（illustration 等预设已切至 weighted_mode）。
"""

from __future__ import annotations

import numpy as np

from engine.core.grid import GridMapping, build_mapping
from engine.core.oklab import linear_rgb_to_oklab, linear_to_srgb, srgb_to_linear
from engine.recipe import Recipe
from engine.types import GrayMap, RGBImage

_BUCKET_SHIFT = 5          # 每通道 8 级
_BUCKETS_PER_CH = 1 << (8 - _BUCKET_SHIFT)
_N_BUCKETS = _BUCKETS_PER_CH ** 3
_TOP_K = 4                 # 参与合并/软赢家的候选桶数
_BLEND_DELTA = 0.25        # 软赢家生效的色距上限（OKLab ΔE）


def sample_mean(image: RGBImage, mapping: GridMapping) -> RGBImage:
    th, tw = mapping.grid_shape
    n_cells = th * tw
    lin = srgb_to_linear(image).reshape(-1, 3).astype(np.float64)
    counts = np.bincount(mapping.cell_index, minlength=n_cells).astype(np.float64)
    out = np.empty((n_cells, 3), dtype=np.float64)
    for c in range(3):
        out[:, c] = np.bincount(
            mapping.cell_index, weights=lin[:, c], minlength=n_cells
        ) / counts
    return linear_to_srgb(out.reshape(th, tw, 3))


def sample_weighted_mode(
    image: RGBImage,
    mapping: GridMapping,
    edge_map: GrayMap,
    *,
    edge_weight: float = 2.0,
    dark_weight: float = 1.5,
    contrast_weight: float = 1.0,
    soft_ratio: float = 1.4,
    merge_delta: float = 0.05,
) -> RGBImage:
    th, tw = mapping.grid_shape
    n_cells = th * tw
    flat = image.reshape(-1, 3)
    E = edge_map.ravel()
    lin = srgb_to_linear(flat).astype(np.float32)
    lum = flat.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32) / 255.0

    if contrast_weight > 0:
        # 局部稀有色带：像素所属 8 级亮度带在 5×5 邻域内占比 <50% 才计权重。
        # 不对称（少数派一侧得分、多数派一侧不得分），平区/渐变区自然中性——
        # 对称的"与邻域均色距离"会同时抬高边缘两侧，少数派特征反而更难赢。
        import cv2

        H, W = image.shape[:2]
        lum255 = flat.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)
        bands = np.clip((lum255 * 8.0 / 256.0).astype(np.int32), 0, 7).reshape(H, W)
        own_density = np.zeros((H, W), dtype=np.float32)
        for b in range(8):
            ind = (bands == b).astype(np.float32)
            dens = cv2.boxFilter(ind, ddepth=-1, ksize=(5, 5),
                                 borderType=cv2.BORDER_REFLECT)
            own_density += dens * ind
        rarity = np.clip(1.0 - own_density * 2.0, 0.0, 1.0).ravel()
    else:
        rarity = np.zeros(len(lum), dtype=np.float32)

    w = (1.0 + edge_weight * E + dark_weight * (1.0 - lum)
         + contrast_weight * rarity).astype(np.float32)

    bucket = (
        ((flat[:, 0] >> _BUCKET_SHIFT).astype(np.int64) * _BUCKETS_PER_CH
         + (flat[:, 1] >> _BUCKET_SHIFT).astype(np.int64)) * _BUCKETS_PER_CH
        + (flat[:, 2] >> _BUCKET_SHIFT).astype(np.int64)
    )
    key = mapping.cell_index.astype(np.int64) * _N_BUCKETS + bucket
    wsum = np.bincount(key, weights=w, minlength=n_cells * _N_BUCKETS).astype(
        np.float32
    ).reshape(n_cells, _N_BUCKETS)
    csum = np.stack(
        [np.bincount(key, weights=w * lin[:, c], minlength=n_cells * _N_BUCKETS)
         .astype(np.float32).reshape(n_cells, _N_BUCKETS) for c in range(3)],
        axis=2,
    )  # (n_cells, N, 3) 线性

    # 每格 Top-K 候选（按票数降序）
    top_idx = np.argsort(-wsum, axis=1)[:, :_TOP_K]
    top_w = np.take_along_axis(wsum, top_idx, 1)               # (cells, K)
    top_c = np.take_along_axis(csum, top_idx[:, :, None], 1)   # (cells, K, 3)
    reps = top_c / np.maximum(top_w, 1e-9)[:, :, None]         # 各候选代表色（线性）

    # 簇合并（贪心）：Top-4 候选中 ΔE < merge_delta 的互相并入——
    # 不只并入第一名：分裂的两半线桶（第 2、3 名）也要彼此合并才能赢回格子
    labs = linear_rgb_to_oklab(reps.reshape(-1, 3)).reshape(n_cells, _TOP_K, 3)
    if merge_delta > 0:
        alive = top_w > 0
        cluster_w = np.zeros_like(top_w)
        cluster_c = np.zeros_like(top_c)
        for k in range(_TOP_K):
            base_ok = alive[:, k].copy()
            cluster_w[:, k] = np.where(base_ok, top_w[:, k], 0.0)
            cluster_c[:, k] = np.where(base_ok[:, None], top_c[:, k], 0.0)
            for j in range(k + 1, _TOP_K):
                d = np.sqrt(((labs[:, j, :] - labs[:, k, :]) ** 2).sum(1))
                absorb = base_ok & alive[:, j] & (d < merge_delta)
                cluster_w[:, k] += np.where(absorb, top_w[:, j], 0.0)
                cluster_c[:, k] += np.where(absorb[:, None], top_c[:, j], 0.0)
                alive[:, j] &= ~absorb
    else:
        cluster_w, cluster_c = top_w, top_c

    # 软赢家：簇第一与簇第二票数比 < soft_ratio 且两者颜色足够近（ΔE < _BLEND_DELTA）
    # 时按票数比例线性混合——只吸收渐变区的平滑，不稀释"线 vs 背景"的结构对比
    order = np.argsort(-cluster_w, axis=1)
    rows = np.arange(n_cells)
    w0 = cluster_w[rows, order[:, 0]]
    c0 = cluster_c[rows, order[:, 0]] / np.maximum(w0, 1e-9)[:, None]
    w2 = cluster_w[rows, order[:, 1]]
    c2 = cluster_c[rows, order[:, 1]] / np.maximum(w2, 1e-9)[:, None]
    d02 = np.sqrt(
        ((linear_rgb_to_oklab(c0) - linear_rgb_to_oklab(c2)) ** 2).sum(1)
    )
    blend = (w2 > 0) & (w0 < soft_ratio * w2) & (d02 < _BLEND_DELTA)
    final = np.where(
        blend[:, None],
        (c0 * w0[:, None] + c2 * w2[:, None]) / (w0 + w2)[:, None],
        c0,
    )
    return linear_to_srgb(final.reshape(th, tw, 3))


def run(
    P0: RGBImage, E: GrayMap, recipe: Recipe, target_wh: tuple[int, int]
) -> RGBImage:
    tw, th = target_wh
    mapping = build_mapping(P0.shape[:2], (th, tw))
    s = recipe.raw["sampling"]
    weights = s.get("weights", {})
    if s["mode"] == "mean":
        return sample_mean(P0, mapping)
    if s["mode"] == "weighted_mode":
        return sample_weighted_mode(
            P0,
            mapping,
            E,
            edge_weight=float(weights.get("edge", 2.0)),
            dark_weight=float(weights.get("dark", 1.5)),
            contrast_weight=float(weights.get("contrast", 1.0)),
            soft_ratio=float(s.get("soft_ratio", 1.4)),
            merge_delta=float(s.get("merge_delta", 0.05)),
        )
    raise NotImplementedError(f"采样模式未实现: {s['mode']}（layered 留 v2）")
