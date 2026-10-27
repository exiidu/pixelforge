@echo off
setlocal
title PixelForge Launcher
rem PixelForge 一键启动：引擎(:8700) + 前端(:5173) + 自动打开浏览器
rem 路径全部相对脚本所在目录，仓库放到哪里都能用。

set "APP=%~dp0pixelforge"

if not exist "%APP%\engine\server\api.py" (
  echo [error] 未找到 "%APP%\engine\server\api.py"。
  echo         请把本脚本放在仓库根目录（与 pixelforge 文件夹同级）。
  pause
  exit /b 1
)

echo [1/3] Starting engine (uvicorn :8700)...
start "PixelForge Engine" /d "%APP%" cmd /k python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700

echo [2/3] Starting web (vite :5173)...
start "PixelForge Web" /d "%APP%\web" cmd /k npm run dev

echo [3/3] Waiting for engine health...
set /a tries=0
:waitloop
timeout /t 1 /nobreak >nul
curl -s -o nul http://127.0.0.1:8700/api/health
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% geq 30 goto giveup
goto waitloop

:ready
echo Engine ready. Opening browser...
start "" http://localhost:5173/
echo PixelForge is running. Close the two service windows to stop.
pause
goto :eof

:giveup
echo Engine did not come up within 30s. Check the "PixelForge Engine" window.
start "" http://localhost:5173/
pause
