.PHONY: all setup backend frontend stop clean

# Default: start everything with one command.
all: setup

setup:
	@echo ""
	@echo "==> Building and starting Docker services (PostgreSQL + Django)..."
	docker compose up --build -d
	@echo ""
	@echo "==> Waiting for Django to finish migrations and seed..."
	@until curl -sf http://localhost:8000/api/employees/ > /dev/null 2>&1; do \
		printf '.'; sleep 2; \
	done
	@echo ""
	@echo "==> Backend is ready at http://localhost:8000"
	@echo ""
	@echo "==> Installing frontend dependencies..."
	cd frontend && npm install
	@echo ""
	@echo "==> Starting Vite dev server..."
	@echo "    Open http://localhost:5173 in your browser."
	@echo ""
	cd frontend && npm run dev

backend:
	docker compose up --build -d

frontend:
	cd frontend && npm install && npm run dev

stop:
	docker compose down

# Remove containers, volumes (database data), and frontend node_modules.
clean:
	docker compose down -v
	rm -rf frontend/node_modules
