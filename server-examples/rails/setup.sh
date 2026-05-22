#!/usr/bin/env bash
# One-shot setup: builds the Rails Docker image, runs migrations + seeds,
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

# ── 1. Build Docker images ────────────────────────────────────────────────────
echo ""
echo "==> Building Docker images..."
$DC build

# ── 2. Start PostgreSQL ───────────────────────────────────────────────────────
echo ""
echo "==> Starting PostgreSQL..."
$DC up -d db

# ── 3. Wait for PostgreSQL to be ready ───────────────────────────────────────
echo ""
echo "==> Waiting for PostgreSQL to be ready..."
TIMEOUT=60
ELAPSED=0
until $DC exec -T db pg_isready -U postgres -q 2>/dev/null; do
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo ""
    echo "ERROR: PostgreSQL did not become ready within ${TIMEOUT}s."
    echo "Run '$DC logs db' to see what went wrong."
    exit 1
  fi
  printf "."
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done
echo " ready"

# ── 4. Create database, run migrations, seed ─────────────────────────────────
echo ""
echo "==> Creating database, running migrations, seeding..."
$DC run --rm api bundle exec rails db:create db:migrate db:seed

# ── 5. Start Rails API ────────────────────────────────────────────────────────
echo ""
echo "==> Starting Rails API server (http://localhost:3000)..."
$DC up -d api

# ── 6. Angular frontend ───────────────────────────────────────────────────────
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

# ── 7. React frontend ─────────────────────────────────────────────────────────
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

# ── 8. Vite frontend ──────────────────────────────────────────────────────────
echo ""
echo "==> Installing frontend dependencies..."
cd "$SCRIPT_DIR/frontend"
npm install

echo ""
echo "========================================================"
echo "  Handsontable — Server-side Rails Example"
echo "========================================================"
echo "  Frontend (JS)      : http://localhost:5173"
echo "  Frontend (Angular) : http://localhost:5173/angular.html"
echo "  Frontend (React)   : http://localhost:5173/react.html"
echo "  Backend            : http://localhost:3000/api/orders"
echo ""
echo "  Press Ctrl+C to stop the frontend dev server."
echo "  Run 'make stop' to stop Docker services."
echo "========================================================"
echo ""

# ── 9. Launch Vite dev server (foreground) ───────────────────────────────────
npm run dev

# Cleanup watchers when Vite exits
kill "$ANGULAR_WATCH_PID" 2>/dev/null || true
kill "$REACT_WATCH_PID" 2>/dev/null || true
