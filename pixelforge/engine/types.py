"""数据模型：整条管线与编辑器共享的类型契约。

约定：
- RGBImage: np.ndarray, shape (H, W, 3), dtype uint8, sRGB
- GrayMap:  np.ndarray, shape (H, W),    dtype float32, 取值 0..1
- 全分辨率中间产物（P0/E/L/I）在管线内以线性 float 缓存，落盘才转 uint8
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

RGBImage = np.ndarray  # (H, W, 3) uint8 sRGB
GrayMap = np.ndarray   # (H, W) float32 0..1


@dataclass(frozen=True)
class Palette:
    """索引色网格引用的调色板。colors 为 (N, 3) uint8 sRGB。"""

    colors: np.ndarray
    name: str = ""
    source: str = "custom"  # builtin | extract | custom


@dataclass
class IndexGrid:
    """一层索引色网格（底色层或墨线层），编辑器的直接编辑对象。

    overrides 记录用户在编辑器中的手改：格号 -> 调色板索引。
    重渲染时 overrides 覆盖算法输出（非破坏原则：手改优先）。
    """

    data: np.ndarray            # (h, w) int32, 调色板索引
    visible: bool = True
    overrides: dict[int, int] = field(default_factory=dict)


@dataclass
class ConversionArtifacts:
    """全分辨率中间产物，按源图+参数缓存，供 stage 接口导出与增量重跑复用。"""

    P0: RGBImage | None = None   # 预处理图
    E: GrayMap | None = None     # 边缘强度图
    L: GrayMap | None = None     # 线稿（可选档）
    I: GrayMap | None = None     # 重要度图


@dataclass
class ConversionResult:
    """一次转换的最终输出，也是编辑器文档的初始状态。"""

    fill: IndexGrid
    ink: IndexGrid | None
    palette: Palette
    meta: dict = field(default_factory=dict)  # recipe 快照、耗时等
