"""0.7.0：Agent 审计与输入上限。"""

import pytest
from fastapi import HTTPException

from engine.server import api


@pytest.fixture(autouse=True)
def _clean_state():
    api._AUDIT.clear()
    api._AGENTS.clear()
    yield
    api._AUDIT.clear()
    api._AGENTS.clear()


def test_audit_records_and_returns_newest_first():
    api._record_audit("agent-a", "POST", "/api/jobs/x/pixels", 200)
    api._record_audit("agent-b", "POST", "/api/convert_file", 500)
    out = api.agents_audit(limit=10)
    assert out["count"] == 2
    assert out["entries"][0]["agent_id"] == "agent-b"
    assert out["entries"][0]["status"] == 500
    assert out["entries"][1]["action"] == "POST /api/jobs/x/pixels"


def test_audit_is_bounded():
    for i in range(api._AUDIT_MAX + 5):
        api._record_audit("agent", "POST", f"/api/x/{i}", 200)
    assert len(api._AUDIT) == api._AUDIT_MAX


def test_features_capped():
    clean = api._clean_features({f"f{i}": True for i in range(100)})
    assert len(clean) == 64
    assert all(isinstance(v, bool) for v in clean.values())


def test_agent_id_clamped():
    agent = api._agent_or_create("x" * 200)
    assert len(agent["id"]) == 80
    assert api._agent_or_create("x" * 200) is agent


def test_session_size_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "SESSION_PATH", tmp_path / "session.json")
    monkeypatch.setattr(api, "SESSION_MAX_BYTES", 64)
    with pytest.raises(HTTPException) as err:
        api.session_save(api.SessionRequest(data={"blob": "a" * 100}))
    assert err.value.status_code == 413
    assert not (tmp_path / "session.json").exists()
