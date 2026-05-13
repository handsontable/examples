#!/usr/bin/env bash
# One-shot setup: builds the Symfony Docker image, runs migrations + seeder,
# starts the backend, installs frontend deps, and launches Vite.
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
echo "==> Building and starting the Symfony backend (this takes a minute the first time)..."
$DC up -d --build

echo ""
echo "==> Waiting for backend to become ready at http://localhost:8001 ..."
TIMEOUT=240
ELAPSED=0
until curl -sf http://localhost:8001/api/products >/dev/null 2>&1; do
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

# ── frontend ─────────────────────────────────────────────────────────────────
echo ""
echo "==> Installing frontend dependencies..."
cd frontend
npm install

echo ""
echo "========================================================"
echo "  Handsontable — Server-side Symfony Example"
echo "========================================================"
echo "  Frontend : http://localhost:5173"
echo "  Backend  : http://localhost:8001/api/products"
echo "  Press Ctrl+C to stop the frontend dev server."
echo "  Run 'make stop' (or '$DC down') to stop Docker."
echo "========================================================"
echo ""

npm run dev
