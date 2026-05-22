# Server-Side Handsontable with Ruby on Rails

A working implementation of the [Server-side Data with Ruby on Rails](https://handsontable.com/docs/recipes/data-management/server-side-rails) recipe. Handsontable's `dataProvider` plugin connects to a Rails 7.1 API backed by PostgreSQL. All data operations — pagination, sorting, filtering, and CRUD — are handled server-side.

## What's included

| Layer | Stack |
|---|---|
| Database | PostgreSQL 15 (Docker) |
| Backend | Rails 7.1 API-only, kaminari, rack-cors |
| Frontend (JS) | Vite + Handsontable (`dataProvider`, `Pagination`, `Filters`, `ColumnSorting`, `ContextMenu`, `Notification`) |
| Frontend (Angular) | Angular 21, `@handsontable/angular-wrapper` |
| Frontend (React) | React 19, `@handsontable/react-wrapper` |

The grid loads 50 seed orders and supports:

- **Paginated fetching** — kaminari returns `{ rows, total_rows }` per page
- **Server-side sorting** — click any column header
- **Server-side filtering** — use the column dropdown filter UI
- **Create** — add rows via the grid context menu
- **Update** — edit any cell inline
- **Delete** — remove rows via the grid context menu

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with the Compose plugin
- Node.js 18+
- npm

## Quick start

```bash
bash setup.sh
# or: make setup
```

This single command:

1. Builds the Rails Docker image
2. Starts PostgreSQL and waits for it to be healthy
3. Creates the database, runs migrations, and seeds 50 orders
4. Starts the Rails API on **http://localhost:3000**
5. Installs all frontend npm dependencies (JS, Angular, React)
6. Builds Angular and React apps, then starts watchers for live rebuilds
7. Starts the Vite dev server on **http://localhost:5173** (proxies `/api` to the Rails API)

| URL | Description |
|---|---|
| http://localhost:5173 | JS frontend |
| http://localhost:5173/angular.html | Angular frontend |
| http://localhost:5173/react.html | React frontend |

## Available commands

```bash
make setup         # Build images, run migrations + seeds, start Rails API and the Vite dev server
make start         # Start Docker services and the frontend dev server (after initial setup)
make stop          # Stop Docker services (preserves data)
make logs          # Stream Rails API container logs
make clean         # Remove containers, volumes, and frontend node_modules
make backend-only  # Start only the Rails API (DB + API containers, no frontend)
make frontend-only # Start only the Vite dev server (assumes API is already running)
make help          # Show all available commands
```

## Project structure

```
rails/
├── setup.sh                              # One-command bootstrap script
├── Makefile                              # Convenience targets
├── README.md
├── docker-compose.yml
├── backend/                              # Rails 7.1 API-only app
│   ├── Dockerfile
│   ├── Gemfile
│   ├── app/
│   │   ├── controllers/api/
│   │   │   └── orders_controller.rb      # index, create_rows, update_rows, remove_rows
│   │   └── models/order.rb
│   ├── config/
│   │   ├── initializers/cors.rb
│   │   └── routes.rb
│   └── db/
│       ├── migrate/20240101000000_create_orders.rb
│       └── seeds.rb
├── frontend/                             # JS entry point + Vite dev server (serves all 3 variants)
│   ├── package.json
│   ├── vite.config.js                    # proxies /api → localhost:3000; serves Angular/React builds
│   ├── index.html
│   └── src/main.js
├── frontend-angular/                     # Angular variant (ng build --watch → served via Vite)
│   ├── angular.json
│   ├── package.json
│   └── src/app/
│       ├── app.component.ts
│       └── app.component.html
└── frontend-react/                       # React variant (vite build --watch → served via Vite)
    ├── vite.config.ts
    ├── package.json
    └── src/
        ├── main.tsx
        └── App.tsx
```

## API endpoints

| Method | URL | Action |
|---|---|---|
| `GET` | `/api/orders?page=1&page_size=10&sort_prop=total&sort_order=desc&filters[0][prop]=status&filters[0][condition]=eq&filters[0][value]=paid` | Paginated, sorted, filtered list |
| `POST` | `/api/orders/create_rows` | Insert rows — body: `{ rows: [...] }` |
| `PATCH` | `/api/orders/update_rows` | Update rows — body: `{ rows: [{ id, changes }] }` |
| `DELETE` | `/api/orders/remove_rows` | Delete rows — body: `{ row_ids: [1, 2] }` |

## How the filter format works

Handsontable's `Filters` plugin emits conditions in its native format:

```js
[{ prop: 'status', operation: 'conjunction', conditions: [{ name: 'eq', args: ['paid'] }] }]
```

The `buildUrl` helper in `frontend/src/main.js` flattens this into the bracket notation that Rails parses automatically:

```
filters[0][prop]=status&filters[0][condition]=eq&filters[0][value]=paid
```

The controller's `apply_filters` method reads `params[:filters].values` and chains `.where` clauses — one per condition. Every column name is validated against `SORTABLE_COLUMNS` before reaching any SQL fragment.
