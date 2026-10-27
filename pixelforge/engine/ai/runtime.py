"""AI 推理设备与 ONNX Runtime Provider 选择（0.4.0）。

优先级：`PIXELFORGE_DEVICE` 显式指定 > auto（CUDA → DirectML → CPU）。
`onnxruntime-gpu` / `onnxruntime-directml` 与普通 `onnxruntime` 共用同一个导入名，
因此这里只按 `get_available_providers()` 探测能力；缺失时静默回退 CPU，
不让 AI Provider 与上层调用感知差异。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

VALID_DEVICES = ("auto", "cpu", "cuda", "dml")
_ALIASES = {"gpu": "cuda", "cudaexecutionprovider": "cuda", "directml": "dml", "dml": "dml"}


@dataclass(frozen=True)
class DeviceInfo:
    """requested=环境变量请求；active=实际选择；providers=会话将使用的 EP 列表。"""

    requested: str
    active: str
    providers: tuple[str, ...]
    available: tuple[str, ...]
    onnxruntime: str | None
    fallback: str | None = None


def _ort():
    import onnxruntime as ort

    return ort


def requested_device() -> str:
    raw = os.environ.get("PIXELFORGE_DEVICE", "auto").strip().lower()
    raw = _ALIASES.get(raw, raw)
    return raw if raw in VALID_DEVICES else "auto"


def device_info() -> DeviceInfo:
    try:
        ort = _ort()
        available = tuple(ort.get_available_providers())
        version = ort.__version__
    except Exception:
        return DeviceInfo(requested_device(), "cpu", ("CPUExecutionProvider",), (), None,
                          "onnxruntime 不可用，AI 功能已禁用")
    want = requested_device()
    cuda = "CUDAExecutionProvider" in available
    dml = "DmlExecutionProvider" in available

    if want == "cpu":
        return DeviceInfo(want, "cpu", ("CPUExecutionProvider",), available, version)
    if want == "cuda":
        if cuda:
            return DeviceInfo(want, "cuda", ("CUDAExecutionProvider", "CPUExecutionProvider"),
                              available, version)
        return DeviceInfo(want, "cpu", ("CPUExecutionProvider",), available, version,
                          "CUDAExecutionProvider 不可用（未安装 onnxruntime-gpu）")
    if want == "dml":
        if dml:
            return DeviceInfo(want, "dml", ("DmlExecutionProvider", "CPUExecutionProvider"),
                              available, version)
        return DeviceInfo(want, "cpu", ("CPUExecutionProvider",), available, version,
                          "DmlExecutionProvider 不可用（未安装 onnxruntime-directml）")
    # auto
    if cuda:
        return DeviceInfo(want, "cuda", ("CUDAExecutionProvider", "CPUExecutionProvider"),
                          available, version)
    if dml:
        return DeviceInfo(want, "dml", ("DmlExecutionProvider", "CPUExecutionProvider"),
                          available, version)
    return DeviceInfo(want, "cpu", ("CPUExecutionProvider",), available, version,
                      "未检测到 CUDA/DirectML Provider（当前为 onnxruntime CPU 版）")


def _session_options():
    ort = _ort()
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return opts


def create_session(model_path: str | Path):
    """按当前设备创建 ORT 会话；GPU 初始化失败时回退 CPU（不让整次转换失败）。"""
    import logging

    ort = _ort()
    path = str(model_path)
    providers = list(device_info().providers)
    try:
        return ort.InferenceSession(path, sess_options=_session_options(), providers=providers)
    except Exception as exc:
        if providers == ["CPUExecutionProvider"]:
            raise
        logging.getLogger("pixelforge.ai").warning(
            "GPU Provider %s 初始化失败，已回退 CPU：%s", providers[0], exc
        )
        return ort.InferenceSession(
            path, sess_options=_session_options(), providers=["CPUExecutionProvider"]
        )
