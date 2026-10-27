"""U2Net 主体抠图 Provider（ONNX；CPU / CUDA / DirectML，rembg 同款权重与预处理）。

模型: models/matting/u2net.onnx（默认）或 u2netp.onnx（轻量快速档）
预处理: 直接拉伸到 320×320 + ImageNet 均值方差归一化（与 rembg 一致）
输出: 7 个深度监督输出取 out[0] 作显著性，min-max 归一化后放大回原尺寸。
设备由 `engine.ai.runtime` 按 PIXELFORGE_DEVICE / 可用 EP 选择（0.4.0）。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from engine.ai.runtime import create_session
from engine.types import GrayMap, RGBImage

MODELS_DIR = Path(__file__).resolve().parents[2] / "models" / "matting"

_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class U2NetMattingProvider:
    name = "u2net-onnx"

    def __init__(
        self,
        model_path: str | Path | None = None,
        model_name: str = "u2net",
        input_size: int = 320,
    ):
        if model_path is None:
            model_path = MODELS_DIR / f"{model_name}.onnx"
            if not Path(model_path).exists() and model_name != "u2netp":
                model_path = MODELS_DIR / "u2netp.onnx"  # 缺主模型时回退轻量版
        self._model_path = Path(model_path)
        self.input_size = input_size
        self._session = None
        self._input_name = ""
        self.providers: list[str] = []

    @property
    def available(self) -> bool:
        return self._model_path.exists()

    def _get_session(self):
        if self._session is None:
            if not self._model_path.exists():
                raise FileNotFoundError(
                    f"抠图模型不存在: {self._model_path}（下载源见 models/README.md）"
                )
            self._session = create_session(self._model_path)
            self.providers = list(self._session.get_providers())
            self._input_name = self._session.get_inputs()[0].name
        return self._session

    def remove_background(self, image: RGBImage) -> tuple[RGBImage, GrayMap]:
        import cv2

        session = self._get_session()
        h, w = image.shape[:2]
        size = self.input_size

        x = cv2.resize(image, (size, size), interpolation=cv2.INTER_LINEAR)
        x = x.astype(np.float32) / 255.0
        x = (x - _IMAGENET_MEAN) / _IMAGENET_STD
        x = x.transpose(2, 0, 1)[None]

        outs = session.run(None, {self._input_name: x})
        alpha = np.clip(outs[0][0, 0], 0.0, 1.0)
        alpha = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_LINEAR)
        a_min, a_max = float(alpha.min()), float(alpha.max())
        if a_max > a_min:
            alpha = (alpha - a_min) / (a_max - a_min)
        return image, np.ascontiguousarray(alpha.astype(np.float32))
