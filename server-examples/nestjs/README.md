# Handsontable — Server-Side Data Management with NestJS

A fully working implementation of the [Server-Side Data Management with NestJS](https://github.com/handsontable/handsontable/tree/develop/docs/content/recipes/data-management/server-side-nestjs) recipe.

The example wires a Handsontable grid to a NestJS REST API backed by PostgreSQL. All data operations — pagination, sorting, filtering, and CRUD — are handled server-side.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Handsontable (Vite dev server) |
| Backend | NestJS 10 + TypeScript |
| ORM | TypeORM 0.3 |
| Database | PostgreSQL 16 (Docker) |

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (with Compose v2)
- Node.js 18+
- npm

## Quick start

```bash
# From the server-examples/ directory:
make setup

# or equivalently:
bash setup.sh
```

The script runs every step automatically:

1. Pulls and starts a PostgreSQL 16 container via Docker Compose
2. Waits for the database health-check to pass
3. Installs NestJS server dependencies (`npm install`)
4. Runs TypeORM migrations — creates the `tickets` table and seeds 12 sample rows
5. Starts the NestJS backend on **http://localhost:3000**
6. Installs Vite client dependencies
7. Starts the Vite dev server on **http://localhost:5173**

Open **http://localhost:5173** in your browser. Press `Ctrl+C` to stop everything.

## Tear down

```bash
make teardown
```

Stops and removes the PostgreSQL container and its volume (data is lost).

## Project structure

```
server-examples/
├── setup.sh              # One-command bootstrap script
├── Makefile              # make setup / make teardown
├── docker-compose.yml    # PostgreSQL 16 service
│
├── server/               # NestJS backend
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── main.ts                          # App bootstrap + CORS + ValidationPipe
│       ├── data-source.ts                   # TypeORM DataSource (used by CLI)
│       ├── ticket.entity.ts                 # TypeORM entity (UUID PK)
│       ├── fetch-tickets.dto.ts             # Query-param DTOs with class-validator
│       ├── tickets.controller.ts            # GET / POST / PATCH / DELETE /tickets
│       ├── tickets.service.ts               # Filtering, sorting, pagination, CRUD
│       └── migrations/
│           └── 1700000000000-CreateTickets.ts  # Schema + seed data
│
└── client/               # Vite + Handsontable frontend
    ├── package.json
    ├── vite.config.js
    ├── index.html
    └── src/
        └── main.js       # Handsontable dataProvider configuration
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tickets` | Paginated, sorted, filtered list |
| `POST` | `/tickets` | Create one or more tickets |
| `PATCH` | `/tickets` | Batch update tickets |
| `DELETE` | `/tickets` | Batch delete tickets |

### GET /tickets — query parameters

| Parameter | Example | Description |
|-----------|---------|-------------|
| `page` | `1` | 1-based page number |
| `pageSize` | `5` | Rows per page |
| `sort[column]` | `status` | Column to sort by |
| `sort[order]` | `asc` \| `desc` | Sort direction |
| `filters[0][prop]` | `status` | Column property name |
| `filters[0][condition]` | `eq` | Filter condition |
| `filters[0][value][0]` | `open` | Filter value |

### Response shape

```json
{
  "rows": [{ "id": "uuid", "subject": "...", "status": "open", ... }],
  "totalRows": 12
}
```

## Handsontable features used

| Feature | Option |
|---------|--------|
| Server-side data | `dataProvider` (`fetchRows`, `onRowsCreate`, `onRowsUpdate`, `onRowsRemove`) |
| Pagination | `pagination: { pageSize: 5 }` |
| Column sorting | `columnSorting: true` |
| Filtering | `filters: true`, `dropdownMenu: true` |
| Loading / empty state | `emptyDataState: true` |
| Error toasts | `notification: true` |
