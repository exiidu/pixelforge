"""发布前安全边界：CORS 白名单与图片路径媒体根目录校验。"""
from __future__ import annotations

import os

import pytest
from fastapi import HTTPException
from PIL import Image

from engine.server import api


def _write_png(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (4, 4), (10, 20, 30)).save(path)
    return path


def test_cors_origins_defaults_to_local(monkeypatch):
    monkeypatch.delenv("PIXELFORGE_CORS_ORIGINS", raising=False)
    assert api._cors_origins() == []
    assert api._LOCAL_ORIGIN == r"^http://(localhost|127\.0\.0\.1)(:\d+)?$"


def test_cors_origins_env_whitelist(monkeypatch):
    monkeypatch.setenv("PIXELFORGE_CORS_ORIGINS", " https://a.example , https://b.example ")
    assert api._cors_origins() == ["https://a.example", "https://b.example"]


def test_media_path_allows_configured_root(tmp_path, monkeypatch):
    allowed = tmp_path / "allowed"
    file = _write_png(allowed / "a.png")
    monkeypatch.setenv("PIXELFORGE_ALLOWED_ROOTS", str(allowed))
    assert api._check_media_path(file) == file.resolve()


def test_media_path_rejects_outside_root(tmp_path, monkeypatch):
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = _write_png(tmp_path / "outside" / "b.png")
    monkeypatch.setenv("PIXELFORGE_ALLOWED_ROOTS", str(allowed))
    with pytest.raises(HTTPException) as err:
        api._check_media_path(outside)
    assert err.value.status_code == 403


def test_media_path_rejects_traversal(tmp_path, monkeypatch):
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = _write_png(tmp_path / "outside" / "c.png")
    monkeypatch.setenv("PIXELFORGE_ALLOWED_ROOTS", str(allowed))
    with pytest.raises(HTTPException) as err:
        api._check_media_path(allowed / ".." / "outside" / "c.png")
    assert err.value.status_code == 403
    assert outside.exists()


def test_load_image_enforces_media_root(tmp_path, monkeypatch):
    allowed = tmp_path / "allowed"
    inside = _write_png(allowed / "ok.png")
    outside = _write_png(tmp_path / "outside" / "no.png")
    monkeypatch.setenv("PIXELFORGE_ALLOWED_ROOTS", str(allowed))
    image = api._load_image(str(inside))
    assert image.shape[0] == 4 and image.shape[1] == 4
    with pytest.raises(HTTPException) as err:
        api._load_image(str(outside))
    assert err.value.status_code == 403


def test_media_roots_env_uses_pathsep(tmp_path, monkeypatch):
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    monkeypatch.setenv("PIXELFORGE_ALLOWED_ROOTS", os.pathsep.join([str(a), str(b)]))
    roots = api._media_roots()
    assert roots == [a.resolve(), b.resolve()]
