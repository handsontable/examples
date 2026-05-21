#!/usr/bin/env bash
# One-shot setup: starts PostgreSQL, runs migrations, launches backend + frontend.
# Usage:  bash setup.sh   or   make setup
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${BLUE}[info]${NC}  $*"; }
ok()      { echo -e "${GREEN}[ ok ]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
die()     { echo -e "${RED}[err ]${NC}  $*" >&2; exit 1; }

# ── cleanup on exit ───────────────────────────────────────────────────────────
SERVER_PID=""
ANGULAR_WATCH_PID=""
REACT_WATCH_PID=""
cleanup() {
  echo ""
  info "Shutting down…"
  if [[ -n "$SERVER_PID" ]]; then
    pkill -P "$SERVER_PID" 2>/dev/null || true
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  [[ -n "$ANGULAR_WATCH_PID" ]] && kill "$ANGULAR_WATCH_PID" 2>/dev/null || true
  [[ -n "$REACT_WATCH_PID"   ]] && kill "$REACT_WATCH_PID"   2>/dev/null || true
  pkill -f "ts-node src/main.ts" 2>/dev/null || true
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" stop 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── prereq checks ─────────────────────────────────────────────────────────────
command -v docker  >/dev/null 2>&1 || die "Docker is not installed"
command -v node    >/dev/null 2>&1 || die "Node.js is not installed (need v18+)"
command -v npm     >/dev/null 2>&1 || die "npm is not installed"

# ── 1. Start PostgreSQL ───────────────────────────────────────────────────────
info "Starting PostgreSQL via Docker Compose…"
docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d --force-recreate db

# ── 2. Wait for PostgreSQL to be healthy ──────────────────────────────────────
info "Waiting for PostgreSQL to be ready…"
for i in $(seq 1 30); do
  if docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T db \
       pg_isready -U tickets -q 2>/dev/null; then
    ok "PostgreSQL is ready"
    break
  fi
  [[ $i -eq 30 ]] && die "PostgreSQL did not become ready within 60 s"
  sleep 2
done

# ── 3. Install server dependencies ────────────────────────────────────────────
info "Installing server dependencies…"
npm install --prefix "$SCRIPT_DIR/server" --loglevel=error

# ── 4. Run database migrations ───────────────────────────────────────────────
info "Running database migrations…"
(cd "$SCRIPT_DIR/server" && npm run migration:run)
ok "Migrations complete"

# ── 5. Start Express server in background ─────────────────────────────────────
info "Starting Express server on :3000…"
(cd "$SCRIPT_DIR/server" && npm start) &
SERVER_PID=$!

# Wait up to 30 s for the API to respond
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/tickets > /dev/null 2>&1; then
    ok "Backend is up at http://localhost:3000"
    break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || die "Express server exited unexpectedly (check output above)"
  [[ $i -eq 30 ]] && die "Backend did not respond within 60 s"
  sleep 2
done

# ── 6. Install client dependencies ────────────────────────────────────────────
info "Installing client dependencies…"
npm install --prefix "$SCRIPT_DIR/client" --loglevel=error

# ── 7. Install Angular deps, build, and start watcher ────────────────────────
info "Installing Angular client dependencies…"
npm install --prefix "$SCRIPT_DIR/client-angular" --loglevel=error

info "Building Angular app (first build)…"
(cd "$SCRIPT_DIR/client-angular" && npm run build)
ok "Angular build complete"

info "Starting Angular build watcher in background…"
(cd "$SCRIPT_DIR/client-angular" && npm run watch) &
ANGULAR_WATCH_PID=$!

# ── 8. Install React deps, build, and start watcher ──────────────────────────
info "Installing React client dependencies…"
npm install --prefix "$SCRIPT_DIR/client-react" --loglevel=error

info "Building React app (first build)…"
(cd "$SCRIPT_DIR/client-react" && npm run build)
ok "React build complete"

info "Starting React build watcher in background…"
(cd "$SCRIPT_DIR/client-react" && npm run watch) &
REACT_WATCH_PID=$!

# ── 9. Launch Vite dev server (foreground) ───────────────────────────────────
echo ""
echo -e "${GREEN}┌────────────────────────────────────────────────┐${NC}"
echo -e "${GREEN}│  Backend   →  http://localhost:3000             │${NC}"
echo -e "${GREEN}│  Frontend  →  http://localhost:5173             │${NC}"
echo -e "${GREEN}│  Angular   →  http://localhost:5173/angular.html│${NC}"
echo -e "${GREEN}│  React     →  http://localhost:5173/react.html  │${NC}"
echo -e "${GREEN}│                                                 │${NC}"
echo -e "${GREEN}│  Press Ctrl+C to stop everything                │${NC}"
echo -e "${GREEN}└────────────────────────────────────────────────┘${NC}"
echo ""

(cd "$SCRIPT_DIR/client" && npx vite)
