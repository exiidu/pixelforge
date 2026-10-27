"""MCP-3B：job 列表 / WS 广播 / Agent 注册与控制的单元测试。"""

from __future__ import annotations

import asyncio

import numpy as np

from engine.recipe import load_recipe
from engine.server import api


def test_agent_register_control_and_features():
    api._AGENTS.clear()
    try:
        view = api.agent_register(api.AgentRegisterRequest(
            id="agent-a", name="测试 Agent", subtitle="stdio",
        ))
        assert view["status"] == "connected" and view["controlling"] is False

        view = api.agent_control(api.AgentControlRequest(
            agent_id="agent-a", active=True, activity="像素编辑", hold_seconds=5,
        ))
        assert view["controlling"] is True and view["activity"] == "像素编辑"

        view = api.agent_features(api.AgentFeaturesRequest(
            agent_id="agent-a", features={"edit": False, "export": True},
        ))
        assert view["features"] == {"edit": False, "export": True}

        view = api.agent_control(api.AgentControlRequest(
            agent_id="agent-a", active=False,
        ))
        assert view["controlling"] is False and view["activity"] == ""
    finally:
        api._AGENTS.clear()


def test_jobs_list_and_ws_payload():
    api._JOBS.clear()
    try:
        image = np.zeros((8, 8, 3), dtype=np.uint8)
        recipe = load_recipe("photo", {"target": {"width": 8, "height": 8}})
        created = api._convert(image, recipe, name="demo.png", source_path="demo.png")
        job_id = created["job_id"]
        job = api._JOBS[job_id]

        listing = api.jobs_list()
        assert listing["count"] == 1
        item = listing["jobs"][0]
        assert item["job_id"] == job_id
        assert item["name"] == "demo.png"
        assert item["revision"] == 0
        assert item["width"] == 8 and item["height"] == 8

        payload = api._job_ws_payload(job_id, job, "job_update", "pixels")
        assert payload["type"] == "job_update"
        assert payload["action"] == "pixels"
        assert payload["revision"] == 0
        assert "alpha" not in payload and "alpha_png" in payload
        assert len(payload["fill"]) == 8 and len(payload["palette"]) > 0
    finally:
        api._JOBS.clear()


def test_evict_jobs_keeps_subscribed_and_newest(monkeypatch):
    api._JOBS.clear()
    api._JOB_WS.clear()
    monkeypatch.setattr(api, "_MAX_JOBS", 2)
    try:
        for i in range(4):
            api._JOBS[f"j{i}"] = {"created_at": float(i)}
        api._JOB_WS["j0"] = {object()}  # type: ignore[assignment]
        api._evict_jobs()
        assert "j0" in api._JOBS  # 有 WS 订阅，不淘汰
        assert len(api._JOBS) == 2
        assert "j3" in api._JOBS  # 最新
        assert "j1" not in api._JOBS and "j2" not in api._JOBS
    finally:
        api._JOBS.clear()
        api._JOB_WS.clear()


def test_broadcast_ws_sends_to_subscribers():
    class FakeWS:
        def __init__(self) -> None:
            self.messages: list[dict] = []

        async def send_json(self, payload: dict) -> None:
            self.messages.append(payload)

    async def scenario() -> None:
        ws = FakeWS()
        api._JOB_WS.clear()
        api._JOB_WS["job-x"] = {ws}  # type: ignore[assignment]
        api._LOOP = asyncio.get_running_loop()
        api._broadcast_ws("job-x", {"hello": "world"})
        await asyncio.sleep(0.05)
        assert ws.messages == [{"hello": "world"}]

    try:
        asyncio.run(scenario())
    finally:
        api._JOB_WS.clear()
        api._LOOP = None
