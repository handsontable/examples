# Handsontable Server-Side Data Management – Spring Boot Example

A fully working implementation of the [server-side-spring recipe](https://github.com/handsontable/handsontable/tree/develop/docs/content/recipes/data-management/server-side-spring) from the Handsontable docs.

The example demonstrates server-side **pagination**, **sorting**, **filtering**, and full **CRUD** (create / update / delete rows) using:

| Layer | Technology |
|---|---|
| Frontend (JS) | Handsontable `dataProvider`, `ContextMenu`, `Notification` + Vite dev server |
| Frontend (Angular) | Angular 21, `@handsontable/angular-wrapper` |
| Frontend (React) | React 19, `@handsontable/react-wrapper` |
| Backend | Spring Boot 3.3 REST API |
| Database | PostgreSQL 16 (via Docker) |
| Migrations | Flyway |
| Containerisation | Docker Compose |

---

## Prerequisites

| Tool | Minimum version |
|---|---|
| Docker + Docker Compose | Docker 24 |
| Node.js | 18 |
| npm | 9 |

No Java or Maven installation required — the Spring Boot JAR is compiled inside a multi-stage Docker image.

---

## Quick start

```bash
bash setup.sh
# or: make setup
```

The script:
1. Builds the Spring Boot image and starts **PostgreSQL + backend** via Docker Compose
2. Runs the Flyway migration (`V1__create_products_table.sql`)
3. Seeds the database with 55 sample products
4. Installs all frontend npm dependencies (JS, Angular, React)
5. Builds Angular and React apps, then starts watchers for live rebuilds
6. Starts the **Vite dev server**

| URL | Description |
|---|---|
| http://localhost:5173 | JS frontend |
| http://localhost:5173/angular.html | Angular frontend |
| http://localhost:5173/react.html | React frontend |

> The first run downloads Maven dependencies inside Docker and may take ~60 seconds.

---

## Available commands

```bash
make setup  # Start everything: PostgreSQL + Spring Boot via Docker, then Vite frontend
make stop   # Stop Docker containers (keeps database data)
make logs   # Stream backend container logs
make clean  # Stop containers, delete the database volume, and remove node_modules
```

---

## Project structure

```
spring/
├── setup.sh                  # One-command startup script
├── Makefile                  # Make targets wrapping setup.sh
├── README.md
├── backend/
│   ├── Dockerfile            # Multi-stage Maven → JRE image
│   ├── docker-compose.yml    # PostgreSQL 16 + Spring Boot services
│   ├── pom.xml               # Spring Boot 3.3, JPA, Flyway, PostgreSQL
│   └── src/main/
│       ├── java/com/example/products/
│       │   ├── ProductsApplication.java   # Spring Boot entry point
│       │   ├── Product.java               # JPA entity
│       │   ├── ProductRepository.java     # Spring Data + JpaSpecificationExecutor
│       │   ├── ProductService.java        # Pagination / sort / filter / CRUD logic
│       │   ├── ProductController.java     # REST endpoints
│       │   ├── DataInitializer.java       # Seeds 55 sample products on first run
│       │   ├── CorsConfig.java            # Allow all origins for /api/**
│       │   ├── CreateRowsPayload.java     # DTO for POST /create-rows
│       │   └── UpdateRowPayload.java      # DTO for PATCH /update-rows
│       └── resources/
│           ├── application.properties     # PostgreSQL + Flyway config
│           └── db/migration/
│               └── V1__create_products_table.sql
├── frontend/                 # JS entry point + Vite dev server (serves all 3 variants)
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js        # Proxies /api/* → localhost:8080; serves Angular/React builds
│   └── src/
│       └── example1.js       # dataProvider, ContextMenu, Notification and CRUD hooks
├── frontend-angular/         # Angular variant (ng build --watch → served via Vite)
│   ├── angular.json
│   ├── package.json
│   └── src/app/
│       ├── app.component.ts
│       └── app.component.html
└── frontend-react/           # React variant (vite build --watch → served via Vite)
    ├── vite.config.ts
    ├── package.json
    └── src/
        ├── main.tsx
        └── App.tsx
```

---

## API endpoints

| Method | Path | Handsontable hook |
|---|---|---|
| `GET` | `/api/products` | `fetchRows` |
| `POST` | `/api/products/create-rows` | `onRowsCreate` |
| `PATCH` | `/api/products/update-rows` | `onRowsUpdate` |
| `DELETE` | `/api/products/remove-rows` | `onRowsRemove` |

`GET /api/products` accepts query parameters:

| Parameter | Example | Description |
|---|---|---|
| `page` | `1` | 1-based page number |
| `pageSize` | `10` | Rows per page |
| `sortProp` | `price` | Column to sort by |
| `sortOrder` | `desc` | `asc` or `desc` |
| `filters` | `[{"column":"category","value":"Electronics"}]` | JSON-encoded filter array (column + first condition value) |

Response shape:
```json
{ "rows": [ ... ], "totalRows": 55 }
```

---

## How it works

```
Browser (Vite :5173)
  │  GET /api/products?page=1&pageSize=10
  │  ──────────── Vite proxy ──────────────▶
  │                               Spring Boot (:8080)
  │                                 └── ProductService.findAll()
  │                                       ├── PageRequest (0-based index)
  │                                       ├── Sort (whitelisted columns)
  │                                       └── Specification (LIKE filters)
  │                                 └── PostgreSQL
  │  ◀──────── { rows, totalRows } ─────────
Handsontable renders page, pagination controls update
```

Handsontable's `dataProvider.fetchRows` callback fires on every page change, sort click, or filter update. Mutations (`onRowsCreate`, `onRowsUpdate`, `onRowsRemove`) hit the corresponding endpoints and the grid refreshes automatically.

The Angular and React variants are pre-built by `ng build --watch` / `vite build --watch` into `frontend-angular/dist/` and `frontend-react/dist/`. The Vite dev server serves them via custom middleware — no separate dev server needed for Angular or React.

---

## Configuration

Backend environment variables (set in `docker-compose.yml`):

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `jdbc:postgresql://localhost:5432/products` | JDBC connection URL |
| `DB_USERNAME` | `postgres` | Database username |
| `DB_PASSWORD` | `postgres` | Database password |

To use a different database, update `application.properties` and the corresponding Flyway migration.
