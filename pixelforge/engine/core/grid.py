"""网格映射：源图像素 → 目标格子的归属关系。

S2 采样的公共底座。一次构建，供均值/加权众数/分层三种采样共用。
边界规则与设计文档一致：每个源像素划入覆盖其中心的格子（floor 缩放，末格钳制）。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class GridMapping:
    """源图 (H,W) → 网格 (th,tw) 的映射。

    cell_index: (H*W,) int32  展平后每个源像素所属格子号（0..th*tw-1，行优先）。
    源像素 i 的下标即 np.arange(H*W)，无需单独存储。
    """

    src_shape: tuple[int, int]  # (H, W)
    grid_shape: tuple[int, int]  # (th, tw)
    cell_index: np.ndarray


def build_mapping(src_shape: tuple[int, int], grid_shape: tuple[int, int]) -> GridMapping:
    H, W = src_shape
    th, tw = grid_shape
    rows = np.minimum(np.arange(H) * th // H, th - 1).astype(np.int64)
    cols = np.minimum(np.arange(W) * tw // W, tw - 1).astype(np.int64)
    cell_index = (rows[:, None] * tw + cols[None, :]).astype(np.int32).ravel()
    return GridMapping(src_shape=src_shape, grid_shape=grid_shape, cell_index=cell_index)
