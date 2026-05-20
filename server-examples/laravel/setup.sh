#!/usr/bin/env bash
# One-shot setup: builds the Laravel Docker image, runs migrations + seeder,
# starts the backend, installs all frontend deps, and launches Vite.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── prerequisite checks ──────────────────────────────────────────────────────
check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' is required but not found. Please install it first."
    exit 1
  fi
}

check_cmd docker
check_cmd curl
check_cmd node
check_cmd npm

# Accept both 'docker compose' (v2 plugin) and 'docker-compose' (v1 standalone)
if docker compose version &>/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose &>/dev/null; then
  DC="docker-compose"
else
  echo "ERROR: Neither 'docker compose' nor 'docker-compose' found."
  exit 1
fi

# ── backend ──────────────────────────────────────────────────────────────────
echo ""
echo "==> Building and starting the Laravel backend (this takes a minute the first time)..."
$DC up -d --build

echo ""
echo "==> Waiting for backend to become ready at http://localhost:8000 ..."
TIMEOUT=180
ELAPSED=0
until curl -sf http://localhost:8000/api/products >/dev/null 2>&1; do
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo ""
    echo "ERROR: Backend did not become ready within ${TIMEOUT}s."
    echo "Run '$DC logs app' to see what went wrong."
    exit 1
  fi
  printf "."
  sleep 3
  ELAPSED=$((ELAPSED + 3))
done
echo ""
echo "==> Backend is ready!"

# ── Angular frontend ──────────────────────────────────────────────────────────
echo ""
echo "==> Installing Angular frontend dependencies..."
cd "$SCRIPT_DIR/frontend-angular"
npm install

echo ""
echo "==> Building Angular app (first build)..."
npm run build

echo ""
echo "==> Starting Angular build watcher in background..."
npm run watch &
ANGULAR_WATCH_PID=$!

# ── React frontend ────────────────────────────────────────────────────────────
echo ""
echo "==> Installing React frontend dependencies..."
cd "$SCRIPT_DIR/frontend-react"
npm install

echo ""
echo "==> Building React app (first build)..."
npm run build

echo ""
echo "==> Starting React build watcher in background..."
npm run watch &
REACT_WATCH_PID=$!

# ── Vite frontend ─────────────────────────────────────────────────────────────
echo ""
echo "==> Installing frontend dependencies..."
cd "$SCRIPT_DIR/frontend"
npm install

echo ""
echo "========================================================"
echo "  Handsontable — Server-side Laravel Example"
echo "========================================================"
echo "  Frontend (REST)    : http://localhost:5173"
echo "  Frontend (Angular) : http://localhost:5173/angular.html"
echo "  Frontend (React)   : http://localhost:5173/react.html"
echo "  Backend            : http://localhost:8000/api/products"
echo ""
echo "  Press Ctrl+C to stop the frontend dev server."
echo "  Run 'make stop' (or '$DC down') to stop Docker."
echo "========================================================"
echo ""

npm run dev

# Cleanup watchers when Vite exits
kill "$ANGULAR_WATCH_PID" 2>/dev/null || true
kill "$REACT_WATCH_PID" 2>/dev/null || true
