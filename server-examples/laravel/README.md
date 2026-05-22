# Server-side Laravel — Handsontable Example

A fully runnable implementation of the [Server-side data with Laravel](https://handsontable.com/docs/recipes/data-management/server-side-laravel) recipe.

## What it does

A product inventory data grid available in three variants:

**REST API** (`/`)
- Fetches paginated rows from `GET /api/products` on every page change
- Sorts and filters rows on the server — the browser never loads the full dataset
- Creates, updates, and deletes rows via `POST`, `PATCH`, and `DELETE` endpoints

**Angular** (`/angular.html`)
- Same REST API operations wrapped in an Angular standalone component
- Uses `@handsontable/angular-wrapper` (`HotTableComponent`) with `@ViewChild` for instance access
- Built separately with `ng build --watch` and served through the Vite dev server via a custom middleware plugin

**React** (`/react.html`)
- Same REST API operations wrapped in a React functional component
- Uses `@handsontable/react-wrapper` (`HotTable`) with `useRef` for instance access and `useMemo` for stable settings
- Built separately with `vite build --watch` and served through the Vite dev server via a custom middleware plugin

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

1. Builds a PHP 8.2 / Apache Docker image with a fresh Laravel 11 project
2. Starts a MySQL 8 container (health-checked before the app starts)
3. Runs database migrations and seeds 52 sample products
4. Installs frontend dependencies (Angular and React are pre-built before Vite starts)
5. Opens **http://localhost:5173**

| URL | Description |
|-----|-------------|
| `http://localhost:5173/` | REST API (vanilla JS) |
| `http://localhost:5173/angular.html` | Angular |
| `http://localhost:5173/react.html` | React |

Switch between variants using the nav links at the top of each page.

## Available commands

```bash
make setup    # Full first-time setup (build → migrate → seed → start)
make start    # Start Docker + frontend after the initial setup
make stop     # Stop Docker services
make logs     # Stream Laravel container logs
make clean    # Remove containers, volumes, and node_modules
```

## Project structure

```
server-side-laravel/
├── setup.sh                     # One-run setup script
├── Makefile                     # Convenience targets
├── docker-compose.yml           # MySQL + Laravel services
│
├── laravel/                     # Laravel backend (Dockerised)
│   ├── Dockerfile               # PHP 8.2 / Apache image
│   ├── apache.conf              # VirtualHost pointing at public/
│   ├── entrypoint.sh            # migrate → seed → apache2-foreground
│   ├── bootstrap/app.php        # Registers routes/api.php (Laravel 11)
│   ├── app/
│   │   ├── Http/Controllers/ProductController.php
│   │   └── Models/Product.php
│   ├── database/
│   │   ├── migrations/          # Products table schema
│   │   └── seeders/             # 52 sample products
│   └── routes/api.php           # GET / POST / PATCH / DELETE /api/products
│
├── frontend/                    # Vite dev server — entry point for all variants
│   ├── package.json
│   ├── vite.config.js           # Proxies /api; serves Angular & React builds via middleware
│   ├── index.html
│   └── src/main.js              # dataProvider configuration — REST
│
├── frontend-angular/            # Angular standalone app (ng build --watch)
│   ├── angular.json             # outputPath.base=dist, baseHref=/angular-assets/
│   ├── package.json
│   └── src/app/
│       ├── app.component.ts     # HotTableComponent + dataProvider logic
│       └── app.component.html   # template with nav + toolbar + <hot-table>
│
└── frontend-react/              # React app (vite build --watch)
    ├── vite.config.ts           # base=/react-assets/, input=react.html
    ├── package.json
    ├── react.html               # HTML entry point
    └── src/
        ├── main.tsx             # createRoot bootstrap
        ├── App.tsx              # HotTable + dataProvider logic (useRef/useMemo)
        └── styles.css
```

## How it works

```
Browser (Vite :5173)
   │  GET /api/products?page=1&pageSize=10&sort[prop]=price&sort[order]=asc
   ▼
Vite proxy → Laravel (Docker :8000)
   │  ProductController::index()
   │    filter loop (allowlisted columns, LOWER() for case-insensitive text)
   │    orderBy (allowlisted columns)
   │    skip/take pagination
   ▼
MySQL 8 ← → Eloquent ORM
   │
   ▼
{ data: [...10 rows...], total: 52 }
   │
   ▼
Handsontable dataProvider → renders page 1, shows pagination bar
```

### Frontend (`src/main.js`)

`buildUrl()` serialises the `queryParameters` object that `fetchRows` receives into bracket-notation query params that Laravel parses automatically with `request()->input()`:

```
filters[0][prop]=price&filters[0][condition]=gt&filters[0][value]=100
```

The Vite proxy forwards every `/api` request to `http://localhost:8000`, so no CORS configuration is required.

### Backend (`ProductController.php`)

| HTTP method | Handsontable callback | Action |
|-------------|----------------------|--------|
| `GET`       | `fetchRows`          | Paginate, sort, filter |
| `POST`      | `onRowsCreate`       | Insert blank rows |
| `PATCH`     | `onRowsUpdate`       | Batch-update changed cells |
| `DELETE`    | `onRowsRemove`       | Delete rows by ID |

Both `orderBy` and `whereRaw` validate the column name against an allowlist before use, preventing SQL injection through user-supplied sort/filter parameters.

## Stopping the example

Press **Ctrl+C** in the terminal to stop the Vite dev server, then run:

```bash
make stop
# or: docker compose down
```
