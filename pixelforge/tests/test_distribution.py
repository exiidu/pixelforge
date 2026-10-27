"""0.8.0：分发相关回归（Windows 批处理行尾、内置前端状态）。"""

from pathlib import Path

from engine.server import api

ROOT = Path(__file__).resolve().parents[2]


def test_bat_scripts_use_crlf():
    for name in ("start_all.bat", "start_engine.bat"):
        data = (ROOT / name).read_bytes()
        assert b"\r\n" in data, f"{name} 缺少 CRLF 行尾"
        assert b"\n" not in data.replace(b"\r\n", b""), f"{name} 混入 LF 行尾"


def test_health_reports_web_dist(monkeypatch, tmp_path):
    monkeypatch.setattr(api, "WEB_DIST", tmp_path)
    assert api.health()["web_dist"] is False
    (tmp_path / "index.html").write_text("<!doctype html>", encoding="utf-8")
    assert api.health()["web_dist"] is True
