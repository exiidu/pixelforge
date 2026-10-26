"""重要度图：决定局部细节保护强度（设计文档 §4）。

I = clamp(a·显著性 + b·边缘 + 用户笔刷)
v1 的显著性用轻量近似（中心先验 + 颜色对比度），不跑模型；
用户笔刷是最高优先级来源（编辑器「保细节」笔刷，刷过即为 1.0）。
"""

from __future__ import annotations

from engine.types import GrayMap, RGBImage


def build_importance(
    image: RGBImage,
    edge_map: GrayMap,
    brush_mask: GrayMap | None = None,
    *,
    center_weight: float = 0.3,
    contrast_weight: float = 0.5,
    edge_weight: float = 0.4,
) -> GrayMap:
    """TODO(验证阶段实现)：返回 0..1 重要度图，与输入同尺寸。"""
    raise NotImplementedError
