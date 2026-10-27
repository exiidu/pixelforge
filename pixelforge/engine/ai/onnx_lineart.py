"""Informative Drawings 线稿 Provider（ONNX；CPU / CUDA / DirectML）。

模型: models/lineart/model.onnx（动态输入 (1,3,H,W)，2026-10-24 实测）
预处理: (rgb/255 − 0.5)/0.5 → [−1,1]（原项目 Normalize(0.5,0.5,0.5)/(0.5,0.5,0.5)）
输出: tanh → (out+1)/2 ∈ [0,1]（白纸黑线）；引擎约定 1=线，故取反。
超过 max_side 的输入先等比缩小（模型为全卷积，尺寸可变），结果再放大回原尺寸。
设备由 `engine.ai.runtime` 按 PIXELFORGE_DEVICE / 可用 EP 选择（0.4.0）。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from engine.ai.runtime import create_session
from engine.types import GrayMap, RGBImage

MODELS_DIR = Path(__file__).resolve().parents[2] / "models" / "lineart"


class OnnxLineartProvider:
    name = "informative-drawings-onnx"

    def __init__(self, model_path: str | Path | None = None, max_side: int = 1024):
        self._model_path = Path(model_path) if model_path else MODELS_DIR / "model.onnx"
        self.max_side = max_side
        self._session = None
        self._input_name = ""
        self.providers: list[str] = []

    def _get_session(self):
        if self._session is None:
            if not self._model_path.exists():
                raise FileNotFoundError(
                    f"线稿模型不存在: {self._model_path}（下载源见 models/README.md）"
                )
            self._session = create_session(self._model_path)
            self.providers = list(self._session.get_providers())
            self._input_name = self._session.get_inputs()[0].name
        return self._session

    def extract(self, image: RGBImage) -> GrayMap:
        import cv2

        session = self._get_session()
        h, w = image.shape[:2]
        scale = min(1.0, self.max_side / max(h, w))
        small = (
            cv2.resize(image, (max(1, int(w * scale)), max(1, int(h * scale))),
                       interpolation=cv2.INTER_AREA)
            if scale < 1.0
            else image
        )

        x = small.astype(np.float32) / 255.0
        x = (x - 0.5) / 0.5
        x = x.transpose(2, 0, 1)[None]
        out = session.run(None, {self._input_name: x})[0][0, 0]

        line = np.clip((out + 1.0) / 2.0, 0.0, 1.0)
        L = 1.0 - line
        # 动态范围拉伸：该模型在扁平插画上线稿响应弱（实测最强仅 ~0.4），
        # 用百分位归一化拉满，使 S4 的固定阈值(0.5)在任何输入下可用
        lo, hi = np.percentile(L, 1.0), np.percentile(L, 99.5)
        if hi > lo + 1e-4:
            L = np.clip((L - lo) / (hi - lo), 0.0, 1.0)
        if L.shape != (h, w):
            L = cv2.resize(L, (w, h), interpolation=cv2.INTER_LINEAR)
        return np.ascontiguousarray(L.astype(np.float32))
