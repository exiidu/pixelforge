"""可写数据目录（0.9.0）。

会话、上传缓存与日志不再写进安装目录，便于便携包放在只读位置或 U 盘：
- `PIXELFORGE_DATA_DIR` 可显式指定；
- 否则 Windows 用 `%LOCALAPPDATA%\\PixelForge`，macOS 用 Application Support，
  Linux 用 `$XDG_DATA_HOME/pixelforge`（默认 `~/.local/share/pixelforge`）。
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

APP_NAME = "PixelForge"


def _fallback_dir() -> Path:
    root = Path(tempfile.gettempdir()) / APP_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def resolve_data_dir() -> Path:
    raw = os.environ.get("PIXELFORGE_DATA_DIR", "").strip()
    if raw:
        candidate = Path(raw).expanduser()
    elif os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        candidate = Path(base) / APP_NAME
    elif sys.platform == "darwin":
        candidate = Path.home() / "Library" / "Application Support" / APP_NAME
    else:
        base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
        candidate = Path(base) / "pixelforge"
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate
    except OSError:
        return _fallback_dir()


DATA_DIR = resolve_data_dir()
SESSION_PATH = DATA_DIR / "session.json"
SESSION_BAK = DATA_DIR / "session.json.bak"
UPLOAD_DIR = DATA_DIR / "cache" / "uploads"
LOG_DIR = DATA_DIR / "logs"
LOG_PATH = LOG_DIR / "engine.log"
