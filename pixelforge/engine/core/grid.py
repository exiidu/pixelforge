"""网格映射：源图像素 → 目标格子的归属关系。

S2 采样的公共底座。一次构建，供均值/加权众数/分层三种采样共用。
边界规则与设计文档一致：每个源像素划入覆盖其中心的格子（floor 缩放，末格钳制）。

放大网格（源图边长 < 目标格数）时，源像素数少于格子数，按上述规则归属必然有**空档格**
（没有任何源像素落入）。空档格没有可采样内容，采样阶段会落到 0（黑）——渲染出来就是
"黑色发丝线"。因此映射同时给出 `covered`（哪些格有源像素）与 `cell_src`（每格的代表源
像素，空档格取"格中心最近的源像素"），由采样端回填。缩小/等尺寸时 covered 全 True，行为不变。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class GridMapping:
    """源图 (H,W) → 网格 (th,tw) 的映射。

    cell_index: (H*W,) int32  展平后每个源像素所属格子号（0..th*tw-1，行优先）。
    源像素 i 的下标即 np.arange(H*W)，无需单独存储。
    covered:    (th*tw,) bool 该格是否至少落入一个源像素（放大时会有空档）。
    cell_src:   (th*tw,) int32 每格的代表源像素展平下标（格中心坐标 floor，末格钳制）；
                仅空档格需要用来回填。
    """

    src_shape: tuple[int, int]  # (H, W)
    grid_shape: tuple[int, int]  # (th, tw)
    cell_index: np.ndarray
    covered: np.ndarray
    cell_src: np.ndarray


def build_mapping(src_shape: tuple[int, int], grid_shape: tuple[int, int]) -> GridMapping:
    H, W = src_shape
    th, tw = grid_shape
    rows = np.minimum(np.arange(H) * th // H, th - 1).astype(np.int64)
    cols = np.minimum(np.arange(W) * tw // W, tw - 1).astype(np.int64)
    cell_index = (rows[:, None] * tw + cols[None, :]).astype(np.int32).ravel()

    covered = np.zeros(th * tw, dtype=bool)
    covered[cell_index] = True

    # 格中心 ((i+0.5) * src / grid) 的 floor → 该格的代表源像素（整数运算避免浮点）
    sy = np.minimum(((np.arange(th) * 2 + 1) * H) // (2 * th), H - 1).astype(np.int64)
    sx = np.minimum(((np.arange(tw) * 2 + 1) * W) // (2 * tw), W - 1).astype(np.int64)
    cell_src = (sy[:, None] * W + sx[None, :]).astype(np.int32).ravel()

    return GridMapping(
        src_shape=src_shape,
        grid_shape=grid_shape,
        cell_index=cell_index,
        covered=covered,
        cell_src=cell_src,
    )
