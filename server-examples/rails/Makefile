.PHONY: setup start stop logs clean backend-only frontend-only help

# Detect docker compose command: v2 plugin or v1 standalone
DC := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Full first-time setup: build, migrate, seed, start backend + frontend
	bash setup.sh

start: ## Start Docker services and the frontend dev server (after initial setup)
	$(DC) up -d
	cd frontend && npm run dev

stop: ## Stop Docker services (preserves data; use 'clean' to also wipe the DB)
	$(DC) stop

logs: ## Stream Rails API container logs
	$(DC) logs -f api

clean: ## Remove containers, volumes, and frontend node_modules
	$(DC) down -v --remove-orphans
	rm -rf frontend/node_modules

backend-only: ## Start only the Rails API (DB + API containers, no frontend)
	$(DC) up -d db
	@until $(DC) exec -T db pg_isready -U postgres -q 2>/dev/null; do \
		printf '.'; sleep 1; \
	done && echo " ready"
	$(DC) up -d api

frontend-only: ## Start only the Vite dev server (assumes API is already running)
	cd frontend && npm install && npm run dev
