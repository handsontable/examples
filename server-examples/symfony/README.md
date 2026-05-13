# Server-side Symfony — Handsontable Example

A fully runnable implementation of server-side data management with Symfony and Handsontable.

## What it does

A product inventory data grid that:

- Fetches paginated rows from `GET /api/products` on every page change
- Sorts and filters rows on the server — the browser never loads the full dataset
- Creates, updates, and deletes rows via `POST`, `PATCH`, and `DELETE` endpoints

## Prerequisites

| Tool | Version |
|------|---------|
| Docker + Docker Compose (v2 plugin or v1 standalone) | any recent |
| Node.js | 18+ |
| npm | 9+ |

## Quick start

```bash
bash setup.sh
# or: make setup
```

That single command:

1. Builds a PHP 8.2 / Apache Docker image with a fresh Symfony 7 project
2. Starts a MySQL 8 container (health-checked before the app starts)
3. Runs Doctrine migrations and seeds 52 sample products
4. Installs frontend dependencies and opens **http://localhost:5173**

## Available commands

```bash
make setup    # Full first-time setup (build → migrate → seed → start)
make start    # Start Docker + frontend after the initial setup
make stop     # Stop Docker services
make logs     # Stream Symfony container logs
make clean    # Remove containers, volumes, and node_modules
```

## Project structure

```
server-side-symfony/
├── setup.sh                     # One-run setup script
├── Makefile                     # Convenience targets
├── docker-compose.yml           # MySQL + Symfony services
│
├── symfony/                     # Symfony backend (Dockerised)
│   ├── Dockerfile               # PHP 8.2 / Apache — runs composer install
│   ├── apache.conf              # VirtualHost with FallbackResource
│   ├── entrypoint.sh            # warmup → migrate → seed → apache2-foreground
│   ├── composer.json            # PHP dependencies (symfony 7 + doctrine)
│   ├── .env                     # Environment defaults (overridden by Docker)
│   ├── bin/console              # Symfony CLI entry point
│   ├── public/index.php         # Front controller
│   ├── src/
│   │   ├── Kernel.php
│   │   ├── Controller/ProductController.php   # HTTP layer — parses request, returns JSON
│   │   ├── Repository/ProductRepository.php   # All DB queries (filter/sort/paginate/CRUD)
│   │   ├── Entity/Product.php                 # Doctrine ORM entity
│   │   └── Command/SeedProductsCommand.php    # app:seed-products console command
│   ├── config/
│   │   ├── bundles.php
│   │   ├── routes.yaml                        # Attribute routing for controllers
│   │   ├── services.yaml
│   │   └── packages/
│   │       ├── framework.yaml
│   │       ├── routing.yaml
│   │       ├── cache.yaml
│   │       ├── doctrine.yaml
│   │       └── doctrine_migrations.yaml
│   └── migrations/
│       └── Version20240101000000.php          # Products table schema
│
└── frontend/                    # Vite + Handsontable
    ├── package.json
    ├── vite.config.js           # Proxies /api → http://localhost:8001
    ├── index.html
    └── src/main.js              # dataProvider configuration
```

## How it works

```
Browser (Vite :5173)
   │  GET /api/products?page=1&pageSize=10&sort[prop]=price&sort[order]=asc
   ▼
Vite proxy → Symfony (Docker :8001)
   │  ProductController::index()
   │    filter loop (allowlisted columns, LOWER() for case-insensitive text)
   │    orderBy (allowlisted columns)
   │    setFirstResult/setMaxResults pagination
   ▼
MySQL 8 ← → Doctrine ORM QueryBuilder
   │
   ▼
{ data: [...10 rows...], total: 52 }
   │
   ▼
Handsontable dataProvider → renders page 1, shows pagination bar
```

### Frontend (`src/main.js`)

`buildUrl()` serialises the `queryParameters` object that `fetchRows` receives into bracket-notation query params that Symfony parses automatically with `$request->query->all()`:

```
filters[0][prop]=price&filters[0][condition]=gt&filters[0][value]=100
```

The Vite proxy forwards every `/api` request to `http://localhost:8001`, so no CORS configuration is required.

### Backend (`ProductController.php` + `ProductRepository.php`)

| HTTP method | Handsontable callback | Controller action | Repository method |
|-------------|----------------------|-------------------|-------------------|
| `GET`       | `fetchRows`          | parse query params, serialize | `findPage()` |
| `POST`      | `onRowsCreate`       | parse body | `createBlankRows()` |
| `PATCH`     | `onRowsUpdate`       | parse body | `updateRows()` |
| `DELETE`    | `onRowsRemove`       | parse body | `deleteByIds()` |

The controller handles only HTTP concerns — request parsing and JSON serialization. All database logic lives in `ProductRepository`, which extends Symfony's `ServiceEntityRepository` and is injected into the controller via constructor autowiring.

`buildFilteredQuery()` in the repository validates every column name against `ALLOWED_COLUMNS` before using it in a DQL expression, preventing SQL injection through user-supplied sort/filter parameters. String comparisons use `LOWER()` for case-insensitive matching.

### Doctrine ORM (`Product.php`)

The `Product` entity uses PHP 8 attributes for mapping. Doctrine stores `price` as `DECIMAL(10,2)` and the controller casts it to `float` in the JSON response to match what Handsontable expects.

### Migrations (`migrations/Version20240101000000.php`)

A single Doctrine migration creates the `products` table. The `entrypoint.sh` runs `doctrine:migrations:migrate` on every container start — it's idempotent because Doctrine tracks applied versions in the `doctrine_migration_versions` table.

### Seeder (`SeedProductsCommand.php`)

The `app:seed-products` console command inserts 52 sample products. It checks `COUNT(*)` first and skips if the table already has rows, making it safe to re-run.

## Stopping the example

Press **Ctrl+C** in the terminal to stop the Vite dev server, then run:

```bash
make stop
# or: docker compose down
```

## Key differences from the Laravel example

| | Laravel | Symfony |
|---|---|---|
| ORM | Eloquent | Doctrine ORM |
| Query builder | `Product::query()` | `createQueryBuilder('p')` |
| Routing | `routes/api.php` | PHP attributes (`#[Route]`) |
| Migrations | `php artisan migrate` | `doctrine:migrations:migrate` |
| Seeding | `php artisan db:seed` | `php bin/console app:seed-products` |
| Apache routing | `.htaccess` mod_rewrite | `FallbackResource /index.php` |
| CSRF | `X-CSRF-TOKEN` header | Not required for stateless API routes |
