#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_ENV="$PROJECT_ROOT/config/.env"
LOG_DIR="$PROJECT_ROOT/temp"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

if [ -f "$CONFIG_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG_ENV"
  set +a
fi

BACKEND_PORT="${BACKEND_PORT:-${PORT:-8000}}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BACKEND_PID=""
FRONTEND_PID=""
STARTUP_COMPLETE=0

mkdir -p "$LOG_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令: $1" >&2
    exit 1
  fi
}

port_in_use() {
  python - "$1" <<'PY'
import socket
import sys

port = int(sys.argv[1])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.settimeout(0.2)
    result = sock.connect_ex(("127.0.0.1", port))
print("1" if result == 0 else "0")
PY
}

ensure_port_free() {
  local port="$1"
  local name="$2"

  if [ "$(port_in_use "$port")" = "1" ]; then
    echo "$name 端口 $port 已被占用，请先释放后再启动。" >&2
    exit 1
  fi
}

wait_for_port() {
  local port="$1"
  local name="$2"
  local log_file="$3"
  local attempts="${4:-50}"
  local i

  for ((i = 0; i < attempts; i++)); do
    if [ "$(port_in_use "$port")" = "1" ]; then
      return 0
    fi
    sleep 0.2
  done

  echo "$name 未在端口 $port 上就绪，请查看日志: $log_file" >&2
  return 1
}

cleanup() {
  if [ "$STARTUP_COMPLETE" -eq 1 ]; then
    return
  fi

  if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi

  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}

require_cmd python
require_cmd npm

if [ ! -d "$PROJECT_ROOT/frontend-new" ]; then
  echo "未找到 frontend-new 目录: $PROJECT_ROOT/frontend-new" >&2
  exit 1
fi

ensure_port_free "$BACKEND_PORT" "后端"
ensure_port_free "$FRONTEND_PORT" "前端"

trap cleanup EXIT INT TERM

cd "$PROJECT_ROOT"
nohup python -m uvicorn backend.app.main:app \
  --host 0.0.0.0 \
  --port "$BACKEND_PORT" \
  --reload \
  >> "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

if ! kill -0 "$BACKEND_PID" 2>/dev/null || ! wait_for_port "$BACKEND_PORT" "后端" "$BACKEND_LOG"; then
  echo "后端启动失败，请查看日志: $BACKEND_LOG" >&2
  exit 1
fi

cd "$PROJECT_ROOT/frontend-new"
nohup npm run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT" \
  >> "$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

if ! kill -0 "$FRONTEND_PID" 2>/dev/null || ! wait_for_port "$FRONTEND_PORT" "前端" "$FRONTEND_LOG"; then
  echo "前端启动失败，请查看日志: $FRONTEND_LOG" >&2
  exit 1
fi

STARTUP_COMPLETE=1
trap - EXIT INT TERM

echo "本地调试服务已启动。"
echo "前端: http://localhost:$FRONTEND_PORT"
echo "后端: http://localhost:$BACKEND_PORT"
echo "后端日志: $BACKEND_LOG"
echo "前端日志: $FRONTEND_LOG"
echo "后端 PID: $BACKEND_PID"
echo "前端 PID: $FRONTEND_PID"
