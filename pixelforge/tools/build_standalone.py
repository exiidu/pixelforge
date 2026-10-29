"""构建免 Python 安装包（Windows x64）：内置 Python 运行时 + 依赖 + 引擎 + 前端。

产物：dist/pixelforge-<version>-windows-x64-noinstall.zip
解压后双击 PixelForge.bat 即可运行，不需要安装 Python 或 Node。

依赖运行时从 python.org 下载 embeddable 包，并用其中的 pip 安装依赖。
下载缓存位于 .cache/standalone，构建目录位于 build/standalone（均不入库）。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tomllib
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PKG = ROOT / "pixelforge"
WEB = PKG / "web"
CACHE = ROOT / ".cache" / "standalone"
BUILD = ROOT / "build" / "standalone"
OUT_DIR = ROOT / "dist"

ROOT_FILES = ("README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md")
PKG_DIRS = ("engine", "recipes", "tools")
SKIP_DIRS = {"__pycache__", ".cache", ".mimosa", ".pytest_cache", "node_modules", "tests"}
SKIP_SUFFIXES = {".pyc", ".tmp", ".onnx"}

BASE_DEPS = ["fastapi", "uvicorn[standard]", "numpy", "opencv-python", "pillow", "mcp>=2.3"]
AI_DEPS = ["onnxruntime"]

LAUNCHER = r"""@echo off
setlocal
title PixelForge
rem 免安装启动器：使用内置 Python 运行引擎，由引擎托管前端页面。
set "ROOT=%~dp0"
set "PY=%ROOT%python\python.exe"
set "APP=%ROOT%pixelforge"
rem 隔离宿主机上可能存在的用户级 Python 包，保证只用包内依赖
set "PYTHONNOUSERSITE=1"
set "PYTHONUTF8=1"

if not exist "%PY%" (
  echo [error] Missing bundled Python: "%PY%"
  pause
  exit /b 1
)
if not exist "%APP%\engine\server\api.py" (
  echo [error] Missing engine: "%APP%\engine\server\api.py"
  pause
  exit /b 1
)

if "%PIXELFORGE_PORT%"=="" set "PIXELFORGE_PORT=8700"
set "PF_URL=http://127.0.0.1:%PIXELFORGE_PORT%/"

echo Starting PixelForge engine on %PF_URL%
start "PixelForge Engine" /min /d "%APP%" "%PY%" -m uvicorn engine.server.api:app --host 127.0.0.1 --port %PIXELFORGE_PORT%

echo Waiting for engine health...
set /a tries=0
:waitloop
timeout /t 1 /nobreak >nul
curl -s -o nul "%PF_URL%api/health"
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% geq 30 goto giveup
goto waitloop

:ready
echo Engine ready. Opening %PF_URL%
start "" "%PF_URL%"
echo PixelForge is running. Close the "PixelForge Engine" window to stop.
timeout /t 5 /nobreak >nul
exit /b 0

:giveup
echo Engine did not start within 30s. Check the "PixelForge Engine" window for errors.
start "" "%PF_URL%"
pause
"""

MODELS_BAT = r"""@echo off
setlocal
cd /d "%~dp0pixelforge"
"%~dp0python\python.exe" tools\download_models.py %*
echo.
pause
"""


def _version() -> str:
    data = tomllib.loads((PKG / "pyproject.toml").read_text(encoding="utf-8"))
    return str(data["project"]["version"])


def _skip(path: Path) -> bool:
    return any(part in SKIP_DIRS for part in path.parts) or path.suffix.lower() in SKIP_SUFFIXES


def _download(url: str, target: Path) -> None:
    if target.is_file() and target.stat().st_size > 0:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"  download {url}")
    tmp = target.with_suffix(target.suffix + ".part")
    urllib.request.urlretrieve(url, tmp)
    tmp.replace(target)


def _prepare_python(version: str, reuse: bool) -> Path:
    py_dir = BUILD / "python"
    if reuse and (py_dir / "python.exe").is_file():
        print(f"[1/4] Reuse bundled Python at {py_dir}")
        return py_dir

    embed = CACHE / f"python-{version}-embed-amd64.zip"
    _download(
        f"https://www.python.org/ftp/python/{version}/python-{version}-embed-amd64.zip",
        embed,
    )
    if py_dir.exists():
        shutil.rmtree(py_dir)
    py_dir.mkdir(parents=True)
    with zipfile.ZipFile(embed) as zf:
        zf.extractall(py_dir)

    # embeddable 包默认禁用 site-packages；打开并加入 Lib\site-packages
    pth = next(py_dir.glob("python*._pth"))
    lines = [ln for ln in pth.read_text(encoding="utf-8").splitlines() if ln.strip() != "Lib\\site-packages"]
    text = "\n".join("import site" if ln == "#import site" else ln for ln in lines)
    if "import site" not in text.splitlines():
        text += "\nimport site"
    pth.write_text(text + "\nLib\\site-packages\n", encoding="utf-8")
    return py_dir


def _bundle_vc_runtime(py_dir: Path) -> None:
    """补齐 MSVC 运行库：embed 包只带 vcruntime，numpy/OpenCV 还需要 msvcp140 等。"""
    system32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
    for name in ("msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll",
                 "msvcp140_atomic_wait.dll", "concrt140.dll"):
        src = system32 / name
        if src.is_file() and not (py_dir / name).is_file():
            shutil.copy2(src, py_dir / name)


def _install_deps(py_dir: Path, with_ai: bool, reuse: bool) -> None:
    site = py_dir / "Lib" / "site-packages"
    sentinels = ["fastapi", "uvicorn", "numpy", "cv2"] + (["onnxruntime"] if with_ai else [])
    if reuse and all((site / name).is_dir() for name in sentinels):
        print("[2/4] Reuse installed dependencies")
        return

    get_pip = CACHE / "get-pip.py"
    _download("https://bootstrap.pypa.io/get-pip.py", get_pip)
    python = py_dir / "python.exe"
    env = {**os.environ, "PYTHONNOUSERSITE": "1", "PYTHONUTF8": "1"}
    print("[2/4] Bootstrapping pip…")
    subprocess.run([str(python), str(get_pip), "--no-warn-script-location"], check=True, env=env)
    deps = BASE_DEPS + (AI_DEPS if with_ai else [])
    print(f"[2/4] Installing dependencies ({', '.join(deps)})…")
    subprocess.run(
        [str(python), "-m", "pip", "install", "--disable-pip-version-check",
         "--no-warn-script-location", *deps],
        check=True,
        env=env,
    )


def _copy_tree(src: Path, dst: Path) -> int:
    count = 0
    for item in src.rglob("*"):
        if not item.is_file() or _skip(item):
            continue
        target = dst / item.relative_to(src)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, target)
        count += 1
    return count


def _copy_app(stage: Path) -> int:
    app = stage / "pixelforge"
    app.mkdir(parents=True, exist_ok=True)
    count = 0
    for name in PKG_DIRS:
        count += _copy_tree(PKG / name, app / name)
    for name in ("pyproject.toml", "mcp_launcher.py", "models/README.md"):
        src = PKG / name
        if src.is_file():
            target = app / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
            count += 1
    dist = WEB / "dist"
    if (dist / "index.html").is_file():
        count += _copy_tree(dist, app / "web" / "dist")
    for name in ROOT_FILES:
        src = ROOT / name
        if src.is_file():
            shutil.copy2(src, stage / name)
            count += 1
    return count


def _write_launchers(stage: Path) -> None:
    for name, text in (("PixelForge.bat", LAUNCHER), ("download_models.bat", MODELS_BAT)):
        (stage / name).write_bytes(text.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8"))


def _write_zip(target: Path, root: Path) -> int:
    count = 0
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for src in root.rglob("*"):
            if src.is_file():
                zf.write(src, (root.name / src.relative_to(root)).as_posix())
                count += 1
    return count


def main() -> int:
    parser = argparse.ArgumentParser(description="构建 PixelForge 免 Python 安装包（Windows x64）")
    parser.add_argument("--python", default="3.12.10", help="内置 Python 版本（默认 3.12.10）")
    parser.add_argument("--skip-web", action="store_true", help="跳过 npm run build（复用已有 web/dist）")
    parser.add_argument("--no-ai", action="store_true", help="不内置 onnxruntime（AI 线稿/抠图不可用）")
    parser.add_argument("--reuse", action="store_true", help="复用 build/standalone 中已下载的运行时与依赖")
    args = parser.parse_args()

    if os.name != "nt":
        print("[error] 免 Python 包当前仅支持 Windows x64 构建。", file=sys.stderr)
        return 1
    if not (WEB / "package.json").is_file():
        print(f"[error] 未找到 {WEB / 'package.json'}", file=sys.stderr)
        return 1
    if not args.skip_web:
        npm = "npm.cmd" if os.name == "nt" else "npm"
        print("[0/4] Building web (npm run build)…")
        subprocess.run([npm, "run", "build"], cwd=WEB, check=True)
    if not (WEB / "dist" / "index.html").is_file():
        print("[error] web/dist/index.html 不存在；请先构建前端。", file=sys.stderr)
        return 1

    version = _version()
    py_dir = _prepare_python(args.python, args.reuse)
    _bundle_vc_runtime(py_dir)
    _install_deps(py_dir, not args.no_ai, args.reuse)

    print("[3/4] Staging application files…")
    stage = BUILD / f"pixelforge-{version}-windows-x64-noinstall"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    app_count = _copy_app(stage)
    _write_launchers(stage)

    # 运行时直接放进包内（复制较慢但避免后续改动污染已构建的运行时）
    print("[3/4] Bundling Python runtime…")
    shutil.copytree(
        py_dir,
        stage / "python",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
    )
    runtime_count = sum(1 for p in (stage / "python").rglob("*") if p.is_file())

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = OUT_DIR / f"pixelforge-{version}-windows-x64-noinstall.zip"
    print(f"[4/4] Packing {app_count + runtime_count + 2} files → {target}")
    count = _write_zip(target, stage)
    print(f"Done: {target} ({target.stat().st_size / 1024 / 1024:.1f} MB, {count} files)")
    print(f"Try it: extract the zip, then run PixelForge.bat")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
