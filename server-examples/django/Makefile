.PHONY: all setup backend frontend stop clean
.ONESHELL:

# Default: start everything with one command.
all: setup

setup:
	@echo ""
	echo "==> Building and starting Docker services (PostgreSQL + Django)..."
	docker compose up --build -d
	echo ""
	echo "==> Waiting for Django to finish migrations and seed..."
	attempts=0
	until curl -sf http://localhost:8000/api/employees/ > /dev/null 2>&1; do \
		attempts=$$((attempts + 1)); \
		if [ $$attempts -ge 60 ]; then \
			echo ""; echo "ERROR: Backend did not become ready. Check logs: docker compose logs backend"; exit 1; \
		fi; \
		printf '.'; sleep 2; \
	done
	echo ""
	echo "==> Backend is ready at http://localhost:8000"
	echo ""
	echo "==> Installing Angular frontend dependencies..."
	cd frontend-angular && npm install
	echo ""
	echo "==> Building Angular app (first build)..."
	npm run build
	echo ""
	echo "==> Starting Angular build watcher in background..."
	npm run watch &
	ANGULAR_PID=$$!
	cd ..
	echo ""
	echo "==> Installing React frontend dependencies..."
	cd frontend-react && npm install
	echo ""
	echo "==> Building React app (first build)..."
	npm run build
	echo ""
	echo "==> Starting React build watcher in background..."
	npm run watch &
	REACT_PID=$$!
	cd ..
	echo ""
	echo "==> Installing frontend dependencies..."
	cd frontend && npm install
	echo ""
	echo "========================================================"
	echo "  Handsontable — Server-side Django Example"
	echo "========================================================"
	echo "  Frontend (JS)      : http://localhost:5173"
	echo "  Frontend (Angular) : http://localhost:5173/angular.html"
	echo "  Frontend (React)   : http://localhost:5173/react.html"
	echo "  Backend            : http://localhost:8000/api/employees/"
	echo ""
	echo "  Press Ctrl+C to stop the frontend dev server."
	echo "  Run 'docker compose down' to stop Docker."
	echo "========================================================"
	echo ""
	trap 'kill $$ANGULAR_PID $$REACT_PID 2>/dev/null || true' EXIT
	npm run dev

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
	rm -rf frontend-angular/node_modules
	rm -rf frontend-react/node_modules
