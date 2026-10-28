"""0.9.0：错误封包、会话备份/回退、日志与诊断。"""

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from engine import paths
from engine.server import api


def _session(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "SESSION_PATH", tmp_path / "session.json")
    monkeypatch.setattr(api, "SESSION_BAK", tmp_path / "session.json.bak")
    monkeypatch.setattr(api, "LEGACY_SESSION", tmp_path / "legacy.json")


def test_session_backup_fallback(tmp_path, monkeypatch):
    _session(tmp_path, monkeypatch)
    api.session_save(api.SessionRequest(data={"v": 1}))
    api.session_save(api.SessionRequest(data={"v": 2}))
    assert json.loads(api.SESSION_BAK.read_text(encoding="utf-8")) == {"v": 1}

    api.SESSION_PATH.write_text("{broken", encoding="utf-8")
    assert api.session_load() == {"v": 1}


def test_session_legacy_fallback(tmp_path, monkeypatch):
    _session(tmp_path, monkeypatch)
    api.LEGACY_SESSION.write_text(json.dumps({"legacy": True}), encoding="utf-8")
    assert api.session_load() == {"legacy": True}


def test_session_corrupt_without_backup(tmp_path, monkeypatch):
    _session(tmp_path, monkeypatch)
    api.SESSION_PATH.write_text("{broken", encoding="utf-8")
    with pytest.raises(HTTPException) as err:
        api.session_load()
    assert err.value.status_code == 500


def test_http_error_envelope():
    response = asyncio.run(api._http_error(None, HTTPException(404, "无自动保存")))
    body = json.loads(response.body)
    assert response.status_code == 404
    assert body["error"] == {"code": "http_404", "message": "无自动保存"}


def test_validation_error_envelope():
    response = asyncio.run(api._validation_error(None, None))
    body = json.loads(response.body)
    assert response.status_code == 422
    assert body["error"]["code"] == "invalid_request"


def test_unhandled_error_is_sanitized():
    request = SimpleNamespace(method="GET", url=SimpleNamespace(path="/api/boom"))
    response = asyncio.run(api._unhandled_error(request, RuntimeError("secret stack")))
    body = json.loads(response.body)
    assert response.status_code == 500
    assert "secret stack" not in body["error"]["message"]
    assert body["error"]["code"] == "internal"


def test_diagnostics_contains_tail(tmp_path, monkeypatch):
    log = tmp_path / "engine.log"
    log.write_text("line1\nline2\n", encoding="utf-8")
    monkeypatch.setattr(api, "LOG_PATH", log)
    info = api.diagnostics()
    assert info["version"] == api.app.version
    assert info["log_tail"] == ["line1", "line2"]
    assert "data_dir" in info and "platform" in info


def test_data_dir_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv("PIXELFORGE_DATA_DIR", str(tmp_path / "pfdata"))
    assert paths.resolve_data_dir() == tmp_path / "pfdata"
    assert (tmp_path / "pfdata").is_dir()
