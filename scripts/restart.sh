#!/usr/bin/env bash
# 一键重启/启动 Multi-LLM 圆桌讨论平台
# 用法: bash scripts/restart.sh [--backend-only | --frontend-only]

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_ENV="$PROJECT_ROOT/config/.env"
if [ -f "$CONFIG_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG_ENV"
  set +a
fi

BACKEND_PORT="${BACKEND_PORT:-${PORT:-8000}}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
LOG_DIR="$PROJECT_ROOT/temp"
mkdir -p "$LOG_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

kill_by_port() {
    local port=$1
    local pids
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo -e "  ${YELLOW}停止端口 $port 上的进程: $pids${NC}"
        echo "$pids" | xargs kill -9 2>/dev/null || true
        sleep 0.5
    fi
}

kill_backend_processes() {
    local pids
    pids=$(pgrep -f "uvicorn backend.app.main:app --host 0.0.0.0 --port ${BACKEND_PORT}" || true)
    if [ -n "$pids" ]; then
        echo -e "  ${YELLOW}停止后端相关进程: $pids${NC}"
        echo "$pids" | xargs kill -9 2>/dev/null || true
        sleep 0.5
    fi
}

kill_frontend_processes() {
    local pids
    pids=$(pgrep -f "vite --host 0.0.0.0 --port ${FRONTEND_PORT}" || true)
    if [ -n "$pids" ]; then
        echo -e "  ${YELLOW}停止前端相关进程: $pids${NC}"
        echo "$pids" | xargs kill -9 2>/dev/null || true
        sleep 0.5
    fi
}

start_backend() {
    echo -e "${CYAN}[Backend]${NC} 停止旧进程..."
    kill_by_port $BACKEND_PORT
    kill_backend_processes

    echo -e "${CYAN}[Backend]${NC} 启动 uvicorn :${BACKEND_PORT} ..."
    cd "$PROJECT_ROOT"
    ulimit -n 65535 2>/dev/null || true
    nohup /home/bigdata/miniconda3/envs/agent/bin/python -m uvicorn backend.app.main:app \
        --host 0.0.0.0 --port $BACKEND_PORT --reload \
        > "$LOG_DIR/backend.log" 2>&1 &
    local pid=$!
    sleep 1

    if kill -0 "$pid" 2>/dev/null; then
        echo -e "${CYAN}[Backend]${NC} ${GREEN}已启动${NC} (PID: $pid, 日志: temp/backend.log)"
    else
        echo -e "${CYAN}[Backend]${NC} ${RED}启动失败，查看日志:${NC} tail temp/backend.log"
        return 1
    fi
}

start_frontend() {
    echo -e "${CYAN}[Frontend]${NC} 停止旧进程..."
    kill_by_port $FRONTEND_PORT
    kill_frontend_processes

    echo -e "${CYAN}[Frontend]${NC} 启动 vite dev :${FRONTEND_PORT} ..."
    cd "$PROJECT_ROOT/frontend-new"
    nohup npx vite --host 0.0.0.0 --port $FRONTEND_PORT \
        > "$LOG_DIR/frontend.log" 2>&1 &
    local pid=$!
    sleep 2

    if kill -0 "$pid" 2>/dev/null; then
        echo -e "${CYAN}[Frontend]${NC} ${GREEN}已启动${NC} (PID: $pid, 日志: temp/frontend.log)"
    else
        echo -e "${CYAN}[Frontend]${NC} ${RED}启动失败，查看日志:${NC} tail temp/frontend.log"
        return 1
    fi
}

echo ""
echo -e "${GREEN}=== 圆桌讨论平台 · 重启 ===${NC}"
echo ""

case "${1:-}" in
    --backend-only)
        start_backend
        ;;
    --frontend-only)
        start_frontend
        ;;
    --stop)
        echo "停止所有服务..."
        kill_by_port $BACKEND_PORT
        kill_by_port $FRONTEND_PORT
        echo -e "${GREEN}已停止${NC}"
        exit 0
        ;;
    *)
        start_backend
        echo ""
        start_frontend
        ;;
esac

echo ""
echo -e "${GREEN}全部就绪${NC}"
echo -e "  前端: ${CYAN}http://localhost:${FRONTEND_PORT}${NC}"
echo -e "  后端: ${CYAN}http://localhost:${BACKEND_PORT}${NC}"
echo -e "  日志: ${YELLOW}tail -f temp/backend.log temp/frontend.log${NC}"
echo ""
