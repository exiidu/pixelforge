@echo off
setlocal
title PixelForge Launcher
rem PixelForge 一键启动：优先内置前端（web/dist，单进程），否则启动 Vite 开发服务器。
rem 路径全部相对脚本所在目录，仓库放到哪里都能用。

set "APP=%~dp0pixelforge"

if not exist "%APP%\engine\server\api.py" (
  echo [error] 未找到 "%APP%\engine\server\api.py"。
  echo         请把本脚本放在仓库根目录（与 pixelforge 文件夹同级）。
  pause
  exit /b 1
)

echo [1/2] Starting engine (uvicorn :8700)...
start "PixelForge Engine" /d "%APP%" cmd /k python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700

if exist "%APP%\web\dist\index.html" (
  set "PF_URL=http://127.0.0.1:8700/"
  echo [2/2] Built web found. Engine will serve it at 127.0.0.1:8700.
) else (
  set "PF_URL=http://localhost:5173/"
  echo [2/2] Starting web (vite :5173)...
  start "PixelForge Web" /d "%APP%\web" cmd /k npm run dev
)

echo Waiting for engine health...
set /a tries=0
:waitloop
timeout /t 1 /nobreak >nul
curl -s -o nul http://127.0.0.1:8700/api/health
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% geq 30 goto giveup
goto waitloop

:ready
echo Engine ready. Opening %PF_URL%
start "" "%PF_URL%"
echo PixelForge is running. Close the service window(s) to stop.
pause
goto :eof

:giveup
echo Engine did not come up within 30s. Check the "PixelForge Engine" window.
start "" "%PF_URL%"
pause
