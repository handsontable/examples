#!/usr/bin/env bash
# setup.sh — one-shot script to boot the Django backend + PostgreSQL via Docker
# Compose, then launch the Vite frontend dev server.
#
# Usage:
#   chmod +x setup.sh && ./setup.sh
#
# Prerequisites: docker (with compose plugin), node, npm

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── prerequisite checks ──────────────────────────────────────────────────────
check() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' is required but not installed."; exit 1; }
}

check docker
check node
check npm

# Detect 'docker compose' (plugin) vs older 'docker-compose' (standalone).
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "ERROR: Docker Compose not found. Install the Docker Compose plugin."
  exit 1
fi

# ── backend ───────────────────────────────────────────────────────────────────
echo ""
echo "==> Building and starting Docker services (PostgreSQL + Django)..."
$COMPOSE up --build -d

echo ""
echo "==> Waiting for Django to be ready (migrations + seed run inside the container)..."
ATTEMPTS=0
MAX_ATTEMPTS=60
until curl -sf http://localhost:8000/api/employees/ >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
    echo ""
    echo "ERROR: Backend did not become ready after ${MAX_ATTEMPTS} attempts."
    echo "       Check logs with: $COMPOSE logs backend"
    exit 1
  fi
  printf '.'
  sleep 2
done

echo ""
echo "==> Backend ready at http://localhost:8000"
echo "    API root:  http://localhost:8000/api/"
echo "    Employees: http://localhost:8000/api/employees/"
echo ""

# ── Angular frontend ──────────────────────────────────────────────────────────
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
echo "  Handsontable — Server-side Django Example"
echo "========================================================"
echo "  Frontend (JS)      : http://localhost:5173"
echo "  Frontend (Angular) : http://localhost:5173/angular.html"
echo "  Frontend (React)   : http://localhost:5173/react.html"
echo "  Backend            : http://localhost:8000/api/employees/"
echo ""
echo "  Press Ctrl+C to stop the frontend dev server."
echo "  Run '$COMPOSE down' to stop Docker."
echo "========================================================"
echo ""

npm run dev

# Cleanup watchers when Vite exits
kill "$ANGULAR_WATCH_PID" 2>/dev/null || true
kill "$REACT_WATCH_PID" 2>/dev/null || true
