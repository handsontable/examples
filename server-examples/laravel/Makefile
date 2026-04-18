.PHONY: setup start stop logs clean help

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-10s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Full first-time setup: build, migrate, seed, start backend + frontend
	bash setup.sh

start: ## Start Docker services and the frontend dev server (after initial setup)
	docker compose up -d
	cd frontend && npm run dev

stop: ## Stop Docker services
	docker compose down

logs: ## Stream backend container logs
	docker compose logs -f app

clean: ## Remove containers, volumes, and frontend node_modules
	docker compose down -v --remove-orphans
	rm -rf frontend/node_modules
