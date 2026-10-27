"""版本号一致性：后端包、前端包与健康接口必须同版。"""
from __future__ import annotations

import json
import tomllib
from pathlib import Path

from engine.server import api

ROOT = Path(__file__).resolve().parents[1]
WEB_PACKAGE = ROOT / "web" / "package.json"


def test_versions_are_in_sync():
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    backend = pyproject["project"]["version"]
    frontend = json.loads(WEB_PACKAGE.read_text(encoding="utf-8"))["version"]
    assert backend == frontend == api.app.version
