#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"

echo "========================================"
echo " Handsontable Server-Side Spring Example"
echo "========================================"
echo ""

# Check prerequisites
command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is required but not installed."; exit 1; }
command -v curl   >/dev/null 2>&1 || { echo "ERROR: curl is required but not installed."; exit 1; }
command -v node   >/dev/null 2>&1 || { echo "ERROR: node is required but not installed."; exit 1; }
command -v npm    >/dev/null 2>&1 || { echo "ERROR: npm is required but not installed."; exit 1; }

echo "[1/5] Starting PostgreSQL + Spring Boot via Docker Compose..."
cd "$BACKEND_DIR"
docker compose up -d --build

echo "[2/5] Waiting for backend (first build downloads Maven deps and may take ~60 s)..."
attempts=0
until curl -sf http://localhost:8080/api/products > /dev/null 2>&1; do
  printf '.'
  sleep 3
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 60 ]; then
    echo ""
    echo "ERROR: Backend did not become ready in time."
    echo "Check logs with: docker compose -f \"$BACKEND_DIR/docker-compose.yml\" logs backend"
    exit 1
  fi
done
echo ""
echo "  Backend is ready at http://localhost:8080"

echo "[3/5] Installing Angular frontend dependencies and building..."
cd "$SCRIPT_DIR/frontend-angular"
npm install
npm run build
echo "  Starting Angular build watcher in background..."
npm run watch &
ANGULAR_WATCH_PID=$!

echo "[4/5] Installing React frontend dependencies and building..."
cd "$SCRIPT_DIR/frontend-react"
npm install
npm run build
echo "  Starting React build watcher in background..."
npm run watch &
REACT_WATCH_PID=$!

echo "[5/5] Installing frontend dependencies and starting Vite dev server..."
cd "$FRONTEND_DIR"
npm install --silent

echo ""
echo "========================================"
echo "  Frontend (JS)      : http://localhost:5173"
echo "  Frontend (Angular) : http://localhost:5173/angular.html"
echo "  Frontend (React)   : http://localhost:5173/react.html"
echo "  Backend            : http://localhost:8080/api/products"
echo "  Press Ctrl+C to stop the frontend     "
echo "  Run 'make stop' to stop the backend   "
echo "========================================"
echo ""

npm run dev

# Cleanup watchers when Vite exits
kill "$ANGULAR_WATCH_PID" 2>/dev/null || true
kill "$REACT_WATCH_PID" 2>/dev/null || true
