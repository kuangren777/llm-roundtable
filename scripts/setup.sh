#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Multi-Agent Round Table Discussion ==="
echo ""

# Backend setup
echo "[1/3] Installing backend dependencies..."
pip install -r "$PROJECT_ROOT/backend/requirements.txt" -q

# Frontend setup
echo "[2/3] Installing frontend dependencies..."
cd "$PROJECT_ROOT/frontend" && npm install --silent

echo "[3/3] Building frontend..."
cd "$PROJECT_ROOT/frontend" && npx vite build --outDir "$PROJECT_ROOT/backend/static" -q 2>/dev/null || npx vite build

echo ""
echo "Ready! Start the backend with:"
echo "  cd $PROJECT_ROOT && uvicorn backend.app.main:app --reload"
echo ""
echo "Or for development with hot-reload frontend:"
echo "  Terminal 1: cd $PROJECT_ROOT && uvicorn backend.app.main:app --reload"
echo "  Terminal 2: cd $PROJECT_ROOT/frontend && npm run dev"
echo ""
echo "Then open http://localhost:3000 (dev) or http://localhost:8000 (prod)"
