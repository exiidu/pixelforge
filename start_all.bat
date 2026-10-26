@echo off
title PixelForge Launcher
rem PixelForge 一键启动：引擎(:8700) + 前端(:5173) + 自动打开浏览器

echo [1/3] Starting engine (uvicorn :8700)...
start "PixelForge Engine" cmd /k "cd /d D:\pixelforge\pixelforge && python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700"

echo [2/3] Starting web (vite :5173)...
start "PixelForge Web" cmd /k "cd /d D:\pixelforge\pixelforge\web && npm run dev"

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
