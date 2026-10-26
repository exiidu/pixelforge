@echo off
REM PixelForge 引擎启动（MCP 与编辑器都依赖此服务）
cd /d D:\pixelforge\pixelforge
start "PixelForge Engine" python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700
echo PixelForge 引擎已启动: http://127.0.0.1:8700 （新窗口运行，关闭它即停止）
