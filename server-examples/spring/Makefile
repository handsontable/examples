.PHONY: setup start stop logs clean

setup: start

## Start everything: PostgreSQL + Spring Boot in Docker, then frontend via Vite
start:
	@bash setup.sh

## Stop backend Docker containers (named volume keeps database data)
stop:
	cd backend && docker compose stop

## Stream Docker Compose logs
logs:
	cd backend && docker compose logs -f

## Stop containers and delete the database volume
clean:
	cd backend && docker compose down -v --remove-orphans
	rm -rf frontend/node_modules
	rm -rf frontend-angular/node_modules
	rm -rf frontend-react/node_modules
