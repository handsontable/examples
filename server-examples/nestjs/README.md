# Handsontable — Server-Side Data Management with NestJS

A fully working implementation of the [Server-Side Data Management with NestJS](https://github.com/handsontable/handsontable/tree/develop/docs/content/recipes/data-management/server-side-nestjs) recipe.

The example wires a Handsontable grid to a NestJS REST API backed by PostgreSQL. All data operations — pagination, sorting, filtering, and CRUD — are handled server-side. The grid is available in three frontend variants: vanilla JS, Angular, and React.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Handsontable — vanilla JS, Angular, and React |
| Backend | NestJS 10 + TypeScript |
| ORM | TypeORM 0.3 |
| Database | PostgreSQL 16 (Docker) |

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (with Compose v2)
- Node.js 18+
- npm

## Quick start

```bash
bash setup.sh
# or: make setup
```

That single command:

1. Starts a PostgreSQL 16 container via Docker Compose
2. Waits for PostgreSQL to be ready
3. Installs NestJS server dependencies (`npm install`)
4. Runs TypeORM migrations — creates the `tickets` table and seeds 12 sample rows
5. Starts the NestJS backend on **http://localhost:3000**
6. Installs Vite client dependencies
7. Installs, builds, and starts Angular + React watchers in the background
8. Opens the Vite dev server on **http://localhost:5173**

| URL | Description |
|-----|-------------|
| `http://localhost:5173/` | JS (vanilla JS) |
| `http://localhost:5173/angular.html` | Angular |
| `http://localhost:5173/react.html` | React |

Press `Ctrl+C` to stop everything.

## Available commands

```bash
make setup    # Full first-time setup (start DB → migrate → seed → backend → frontend)
make start    # Start DB + backend + frontend after the initial setup (skips migrations)
make stop     # Stop the DB container (preserves data)
make logs     # Stream database container logs
make clean    # Remove containers, volumes, and node_modules
make reset    # Full clean then setup (clean restart)
make psql     # Open a psql session in the running PostgreSQL container
```

## Project structure

```
nestjs/
├── setup.sh              # One-command bootstrap script
├── Makefile              # make setup / start / stop / logs / clean / reset / psql
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
├── client/               # Vite dev server — entry point for all variants
│   ├── package.json
│   ├── vite.config.js    # Proxies /tickets; serves Angular & React builds via middleware
│   ├── index.html
│   └── src/
│       └── main.js       # Handsontable dataProvider configuration — vanilla JS
│
├── client-angular/       # Angular standalone app (ng build --watch)
│   ├── angular.json      # outputPath.base=dist, baseHref=/angular-assets/
│   ├── package.json
│   └── src/app/
│       ├── app.component.ts    # HotTableComponent + dataProvider logic
│       └── app.component.html  # template with nav + <hot-table>
│
└── client-react/         # React app (vite build --watch)
    ├── vite.config.ts    # base=/react-assets/, input=react.html
    ├── package.json
    ├── react.html        # HTML entry point
    └── src/
        ├── main.tsx      # createRoot bootstrap
        ├── App.tsx       # HotTable + dataProvider logic (useRef/useMemo/useState)
        └── styles.css
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
