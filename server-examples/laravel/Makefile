.PHONY: setup start stop logs clean help

# Detect docker compose command: v2 plugin or v1 standalone
DC := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-10s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Full first-time setup: build, migrate, seed, start backend + frontend
	bash setup.sh

start: ## Start Docker services, Angular/React watchers, and the frontend dev server (after initial setup)
	$(DC) up -d
	cd frontend-angular && npm run watch &
	cd frontend-react && npm run watch &
	cd frontend && npm run dev

stop: ## Stop Docker services (preserves data; use 'clean' to also wipe the DB)
	$(DC) stop

logs: ## Stream backend container logs
	$(DC) logs -f app

clean: ## Remove containers, volumes, and frontend node_modules
	$(DC) down -v --remove-orphans
	rm -rf frontend/node_modules
	rm -rf frontend-angular/node_modules
	rm -rf frontend-angular/dist
	rm -rf frontend-react/node_modules
	rm -rf frontend-react/dist
