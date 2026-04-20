# Server-Side Handsontable with Ruby on Rails

A working implementation of the [Server-side Data with Ruby on Rails](https://handsontable.com/docs/recipes/data-management/server-side-rails) recipe. Handsontable's `dataProvider` plugin connects to a Rails 7.1 API backed by PostgreSQL. All pagination, sorting, and filtering happen on the server.

## What's included

| Layer | Stack |
|---|---|
| Database | PostgreSQL 15 (Docker) |
| Backend | Rails 7.1 API-only, kaminari, rack-cors |
| Frontend | Vite + Handsontable (`dataProvider`, `Pagination`, `Filters`, `ColumnSorting`) |

The grid loads 50 seed orders and supports:

- **Paginated fetching** — kaminari returns `{ rows, total_rows }` per page
- **Server-side sorting** — click any column header
- **Server-side filtering** — use the column dropdown filter UI
- **Create** — add rows via the grid context menu
- **Update** — edit any cell inline
- **Delete** — remove rows via the grid context menu

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with the Compose plugin
- [Node.js](https://nodejs.org/) 18+

## Quick start

```bash
cd server-examples
make
```

This single command:

1. Builds the Rails Docker image
2. Starts PostgreSQL and waits for it to be healthy
3. Creates the database, runs migrations, and seeds 50 orders
4. Starts the Rails API on **http://localhost:3000**
5. Installs frontend dependencies and starts the Vite dev server on **http://localhost:5173** (opens automatically)

## Other make targets

| Command | Description |
|---|---|
| `make` | Full setup (default) |
| `make backend-only` | Start only PostgreSQL + Rails API |
| `make frontend-only` | Start only the Vite dev server (API must already be running) |
| `make clean` | Stop all containers and delete volumes |

## Project structure

```
server-examples/
├── Makefile
├── docker-compose.yml
├── backend/                          # Rails 7.1 API-only app
│   ├── Dockerfile
│   ├── Gemfile
│   ├── app/
│   │   ├── controllers/
│   │   │   └── api/
│   │   │       └── orders_controller.rb   # index, create_rows, update_rows, remove_rows
│   │   └── models/
│   │       └── order.rb
│   ├── config/
│   │   ├── initializers/cors.rb
│   │   └── routes.rb
│   └── db/
│       ├── migrate/20240101000000_create_orders.rb
│       └── seeds.rb
└── frontend/
    ├── package.json                  # handsontable + vite
    ├── index.html
    └── src/
        └── main.js                   # Handsontable dataProvider config
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
