"""AI 设备 / Provider 选择的单元测试（不加载模型，不依赖本机是否有 GPU）。"""

import pytest

from engine.ai import runtime


class FakeOrt:
    __version__ = "9.9.9"

    def __init__(self, providers):
        self._providers = providers

    def get_available_providers(self):
        return list(self._providers)


def _fake(monkeypatch, providers):
    monkeypatch.setattr(runtime, "_ort", lambda: FakeOrt(providers))


def test_requested_device_aliases(monkeypatch):
    monkeypatch.setenv("PIXELFORGE_DEVICE", "GPU")
    assert runtime.requested_device() == "cuda"
    monkeypatch.setenv("PIXELFORGE_DEVICE", "DirectML")
    assert runtime.requested_device() == "dml"
    monkeypatch.setenv("PIXELFORGE_DEVICE", "bogus")
    assert runtime.requested_device() == "auto"
    monkeypatch.delenv("PIXELFORGE_DEVICE")
    assert runtime.requested_device() == "auto"


def test_auto_prefers_cuda(monkeypatch):
    _fake(monkeypatch, ["CUDAExecutionProvider", "CPUExecutionProvider"])
    monkeypatch.setenv("PIXELFORGE_DEVICE", "auto")
    info = runtime.device_info()
    assert info.active == "cuda"
    assert info.providers == ("CUDAExecutionProvider", "CPUExecutionProvider")
    assert info.fallback is None


def test_auto_falls_back_to_dml(monkeypatch):
    _fake(monkeypatch, ["DmlExecutionProvider", "CPUExecutionProvider"])
    monkeypatch.setenv("PIXELFORGE_DEVICE", "auto")
    info = runtime.device_info()
    assert info.active == "dml"
    assert info.providers[0] == "DmlExecutionProvider"


def test_cpu_only(monkeypatch):
    _fake(monkeypatch, ["CPUExecutionProvider"])
    monkeypatch.setenv("PIXELFORGE_DEVICE", "auto")
    info = runtime.device_info()
    assert info.active == "cpu"
    assert info.providers == ("CPUExecutionProvider",)


def test_explicit_cuda_missing_reports_fallback(monkeypatch):
    _fake(monkeypatch, ["CPUExecutionProvider"])
    monkeypatch.setenv("PIXELFORGE_DEVICE", "cuda")
    info = runtime.device_info()
    assert info.active == "cpu"
    assert info.fallback and "onnxruntime-gpu" in info.fallback


def test_explicit_cpu_even_when_gpu_available(monkeypatch):
    _fake(monkeypatch, ["CUDAExecutionProvider", "CPUExecutionProvider"])
    monkeypatch.setenv("PIXELFORGE_DEVICE", "cpu")
    info = runtime.device_info()
    assert info.active == "cpu" and info.fallback is None


def test_onnxruntime_missing_is_reported(monkeypatch):
    def boom():
        raise ImportError("no onnxruntime")

    monkeypatch.setattr(runtime, "_ort", boom)
    info = runtime.device_info()
    assert info.active == "cpu" and info.fallback and "onnxruntime" in info.fallback


def test_device_info_available_list(monkeypatch):
    _fake(monkeypatch, ["CUDAExecutionProvider", "CPUExecutionProvider", "AzureExecutionProvider"])
    monkeypatch.setenv("PIXELFORGE_DEVICE", "auto")
    info = runtime.device_info()
    assert "AzureExecutionProvider" in info.available
    assert info.onnxruntime == "9.9.9"
