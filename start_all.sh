#!/usr/bin/env bash
# PixelForge 启动（macOS / Linux）：优先内置前端（web/dist，单进程），否则 Vite 开发服务器。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/pixelforge"

if [[ ! -f "$APP/engine/server/api.py" ]]; then
  echo "[error] 未找到 $APP/engine/server/api.py；请把脚本放在仓库根目录。" >&2
  exit 1
fi

( cd "$APP" && exec python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700 ) &
ENGINE_PID=$!
PIDS=("$ENGINE_PID")

if [[ -f "$APP/web/dist/index.html" ]]; then
  URL="http://127.0.0.1:8700/"
  echo "Built web found. Open: $URL"
else
  URL="http://localhost:5173/"
  ( cd "$APP/web" && exec npm run dev ) &
  WEB_PID=$!
  PIDS+=("$WEB_PID")
  echo "Engine: http://127.0.0.1:8700  |  Web: $URL"
fi

cleanup() {
  kill "${PIDS[@]}" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

wait
