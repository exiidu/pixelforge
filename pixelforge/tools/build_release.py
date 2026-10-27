"""构建便携包：前端 dist + 引擎 + 启动脚本 → dist/pixelforge-<version>-portable.zip。

便携包只依赖 Python（`pip install -e pixelforge`）与可选模型权重，不需要 Node。
前端构建产物存在时，引擎会直接托管 `web/dist`（0.8.0）。
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tomllib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PKG = ROOT / "pixelforge"
WEB = PKG / "web"
OUT_DIR = ROOT / "dist"

PKG_DIRS = ("engine", "recipes", "tools")
PKG_FILES = ("pyproject.toml", "models/README.md")
ROOT_FILES = (
    "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md",
    "start_all.bat", "start_engine.bat", "start_all.sh",
)
SKIP_DIRS = {"__pycache__", ".cache", ".mimosa", ".pytest_cache", "node_modules", "tests"}
SKIP_SUFFIXES = {".pyc", ".tmp", ".onnx"}


def _skip(path: Path) -> bool:
    return any(part in SKIP_DIRS for part in path.parts) or path.suffix.lower() in SKIP_SUFFIXES


def _version() -> str:
    data = tomllib.loads((PKG / "pyproject.toml").read_text(encoding="utf-8"))
    return str(data["project"]["version"])


def _items() -> list[tuple[Path, Path]]:
    """(源文件, zip 内路径)。"""
    out: list[tuple[Path, Path]] = []
    for name in PKG_DIRS:
        base = PKG / name
        if not base.exists():
            continue
        for src in base.rglob("*"):
            if src.is_file() and not _skip(src):
                out.append((src, Path("pixelforge") / src.relative_to(PKG)))
    for name in PKG_FILES:
        src = PKG / name
        if src.is_file():
            out.append((src, Path("pixelforge") / name))
    dist = WEB / "dist"
    if (dist / "index.html").is_file():
        for src in dist.rglob("*"):
            if src.is_file():
                out.append((src, Path("pixelforge/web/dist") / src.relative_to(dist)))
    for name in ROOT_FILES:
        src = ROOT / name
        if src.is_file():
            out.append((src, Path(name)))
    return out


def _write_zip(target: Path, items: list[tuple[Path, Path]]) -> None:
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        for src, arc in items:
            data = src.read_bytes()
            if src.suffix.lower() == ".bat":  # Windows 批处理必须 CRLF
                data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            zf.writestr(arc.as_posix(), data)


def main() -> int:
    parser = argparse.ArgumentParser(description="构建 PixelForge 便携包")
    parser.add_argument("--skip-build", action="store_true", help="跳过 npm run build（复用已有 web/dist）")
    args = parser.parse_args()

    if not (WEB / "package.json").is_file():
        print(f"[error] 未找到 {WEB / 'package.json'}", file=sys.stderr)
        return 1
    if not args.skip_build:
        npm = "npm.cmd" if os.name == "nt" else "npm"
        print("[1/2] Building web (npm run build)…")
        subprocess.run([npm, "run", "build"], cwd=WEB, check=True)
    if not (WEB / "dist" / "index.html").is_file():
        print("[error] web/dist/index.html 不存在；请先构建前端。", file=sys.stderr)
        return 1

    version = _version()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = OUT_DIR / f"pixelforge-{version}-portable.zip"
    items = _items()
    print(f"[2/2] Packing {len(items)} files → {target}")
    _write_zip(target, items)
    print(f"Done: {target} ({target.stat().st_size / 1024 / 1024:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
