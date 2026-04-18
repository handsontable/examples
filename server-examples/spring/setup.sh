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
command -v node   >/dev/null 2>&1 || { echo "ERROR: node is required but not installed."; exit 1; }
command -v npm    >/dev/null 2>&1 || { echo "ERROR: npm is required but not installed."; exit 1; }

echo "[1/3] Starting PostgreSQL + Spring Boot via Docker Compose..."
cd "$BACKEND_DIR"
docker compose up -d --build

echo "[2/3] Waiting for backend (first build downloads Maven deps and may take ~60 s)..."
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

echo "[3/3] Installing frontend dependencies and starting Vite dev server..."
cd "$FRONTEND_DIR"
npm install --silent

echo ""
echo "========================================"
echo "  Open http://localhost:5173 in browser "
echo "  Press Ctrl+C to stop the frontend     "
echo "  Run 'make stop' to stop the backend   "
echo "========================================"
echo ""
npm run dev
