.DEFAULT_GOAL := setup

.PHONY: setup clean backend-only frontend-only

setup: ## Build images, run migrations + seeds, start Rails API, then launch the Vite dev server
	@echo "==> Building Docker images..."
	docker compose build
	@echo "==> Starting PostgreSQL..."
	docker compose up -d db
	@echo "==> Waiting for PostgreSQL to be ready..."
	@until docker compose exec -T db pg_isready -U postgres -q 2>/dev/null; do \
		printf '.'; sleep 1; \
	done && echo " ready"
	@echo "==> Creating database, running migrations, seeding..."
	docker compose run --rm api bundle exec rails db:create db:migrate db:seed
	@echo "==> Starting Rails API server (http://localhost:3000)..."
	docker compose up -d api
	@echo "==> Starting frontend dev server (http://localhost:5173) — press Ctrl+C to stop"
	cd frontend && npm install && npm run dev

backend-only: ## Start only the Rails API (DB + API containers)
	docker compose up -d db
	@until docker compose exec -T db pg_isready -U postgres -q 2>/dev/null; do \
		printf '.'; sleep 1; \
	done && echo " ready"
	docker compose up -d api

frontend-only: ## Start only the Vite dev server (assumes API is already running)
	cd frontend && npm install && npm run dev

clean: ## Stop all containers and delete volumes
	docker compose down -v
