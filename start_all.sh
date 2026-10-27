#!/usr/bin/env bash
# PixelForge 启动（macOS / Linux）：引擎 :8700 + 前端 :5173
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/pixelforge"

if [[ ! -f "$APP/engine/server/api.py" ]]; then
  echo "[error] 未找到 $APP/engine/server/api.py；请把脚本放在仓库根目录。" >&2
  exit 1
fi

( cd "$APP" && python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700 ) &
ENGINE_PID=$!
( cd "$APP/web" && npm run dev ) &
WEB_PID=$!

cleanup() {
  kill "$ENGINE_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "Engine: http://127.0.0.1:8700  |  Web: http://localhost:5173"
wait
