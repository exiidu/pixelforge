"""AI 能力接口定义 —— v1 只定义协议，不提供实现。

三个 Provider 对应设计文档中 AI 的三个插点：
- LineartProvider      → S1 高质量线稿档（Informative Drawings ONNX）
- MattingProvider      → S0 主体抠图（rembg/U2Net）
- RegenerationProvider → S6 AI 重绘（ComfyUI img2img，复用本机已有部署）

接入时新增实现文件（如 onnx_lineart.py / comfy_client.py）并在
pipeline.AIProviders 里替换默认的 UnavailableProvider 即可，管线其余部分不动。
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from engine.types import GrayMap, RGBImage


@runtime_checkable
class LineartProvider(Protocol):
    """照片 → 线稿灰度图 (0=无线, 1=线)。输出须与输入同尺寸。"""

    def extract(self, image: RGBImage) -> GrayMap: ...


@runtime_checkable
class MattingProvider(Protocol):
    """抠主体：返回 (RGB前景, alpha 0..1)。前景为源图，alpha 即蒙版。"""

    def remove_background(self, image: RGBImage) -> tuple[RGBImage, GrayMap]: ...


@runtime_checkable
class RegenerationProvider(Protocol):
    """img2img 风格重绘（像素风）。AI 输出仅替换 P0，其后仍走 S2–S5 收尾。"""

    def img2img(self, image: RGBImage, *, denoise: float, seed: int) -> RGBImage: ...
