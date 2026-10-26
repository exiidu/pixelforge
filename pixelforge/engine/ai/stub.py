"""默认 Provider：不可用。AI 接入前，启用相关参数会在这里得到明确报错。"""

from __future__ import annotations

from engine.types import GrayMap, RGBImage

_MSG = (
    "AI 能力尚未接入（v1 仅保留接口）。"
    "实现 engine/ai/base.py 中对应的 Protocol 并在 pipeline.AIProviders 注册后可用，"
    "详见 README 路线图 v2。"
)


class UnavailableProvider:
    def __init__(self, capability: str) -> None:
        self._capability = capability

    def _fail(self) -> None:
        raise NotImplementedError(f"[{self._capability}] {_MSG}")

    # —— 各协议方法签名与 base.py 保持一致 ——
    def extract(self, image: RGBImage) -> GrayMap:
        self._fail()

    def remove_background(self, image: RGBImage) -> tuple[RGBImage, GrayMap]:
        self._fail()

    def img2img(self, image: RGBImage, *, denoise: float, seed: int) -> RGBImage:
        self._fail()
