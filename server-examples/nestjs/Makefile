.PHONY: setup start stop logs clean reset psql help

# Detect docker compose command: v2 plugin or v1 standalone
DC := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-10s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Full first-time setup: start DB, run migrations, launch backend + frontend
	@bash "$(CURDIR)/setup.sh"

start: ## Start DB + backend + frontend (skips migrations — run setup first)
	$(DC) -f "$(CURDIR)/docker-compose.yml" up -d db
	cd "$(CURDIR)/server" && npm start &
	cd "$(CURDIR)/client" && npx vite

stop: ## Stop the DB container (preserves data; use 'clean' to also remove the DB)
	$(DC) -f "$(CURDIR)/docker-compose.yml" stop
	-pkill -f "ts-node src/main.ts" 2>/dev/null || true

logs: ## Stream database container logs
	$(DC) -f "$(CURDIR)/docker-compose.yml" logs -f db

clean: ## Remove containers, volumes, and node_modules
	$(DC) -f "$(CURDIR)/docker-compose.yml" down -v --remove-orphans
	-pkill -f "ts-node src/main.ts" 2>/dev/null || true
	rm -rf "$(CURDIR)/server/node_modules" "$(CURDIR)/client/node_modules"

reset: clean setup ## Full teardown then setup (clean restart)

psql: ## Open a psql session in the running PostgreSQL container
	$(DC) -f "$(CURDIR)/docker-compose.yml" exec db psql -U tickets tickets
