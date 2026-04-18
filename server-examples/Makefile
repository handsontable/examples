.PHONY: setup teardown

## Start everything: PostgreSQL → migrations → backend → frontend
setup:
	@bash "$(CURDIR)/setup.sh"

## Stop containers and remove volumes (data is lost)
teardown:
	docker compose -f "$(CURDIR)/docker-compose.yml" down -v
	-pkill -f "ts-node src/main.ts" 2>/dev/null || true
