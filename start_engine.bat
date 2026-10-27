@echo off
setlocal
rem PixelForge 引擎启动（MCP 与编辑器都依赖此服务）；路径相对脚本所在目录。
set "APP=%~dp0pixelforge"
start "PixelForge Engine" /d "%APP%" cmd /k python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700
echo PixelForge 引擎已启动: http://127.0.0.1:8700 （新窗口运行，关闭它即停止）
