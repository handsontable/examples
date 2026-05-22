# Server-side Symfony — Handsontable Example

A fully runnable implementation of server-side data management with Symfony and Handsontable.

## What it does

A product inventory data grid available in four variants:

**REST API** (`/`)
- Fetches paginated rows from `GET /api/products` on every page change
- Sorts and filters rows on the server — the browser never loads the full dataset
- Creates, updates, and deletes rows via `POST`, `PATCH`, and `DELETE` endpoints

**GraphQL API** (`/graphql.html`)
- All the same operations (fetch, sort, filter, create, update, delete) over a single `POST /graphql` endpoint
- Uses named queries and mutations with typed input objects
- The schema is built with `webonyx/graphql-php` — no extra bundle required

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

1. Builds a PHP 8.2 / Apache Docker image with a fresh Symfony 7 project
2. Starts a MySQL 8 container (health-checked before the app starts)
3. Runs Doctrine migrations and seeds 52 sample products
4. Installs frontend dependencies (Angular and/or React are pre-built before Vite starts)
5. Opens **http://localhost:5173**

| URL | Description |
|-----|-------------|
| `http://localhost:5173/` | REST API (vanilla JS) |
| `http://localhost:5173/graphql.html` | GraphQL API (vanilla JS) |
| `http://localhost:5173/angular.html` | Angular |
| `http://localhost:5173/react.html` | React |

Switch between variants using the nav links at the top of each page.

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
│   ├── composer.json            # PHP dependencies (symfony 7 + doctrine + graphql-php)
│   ├── .env                     # Environment defaults (overridden by Docker)
│   ├── bin/console              # Symfony CLI entry point
│   ├── public/index.php         # Front controller
│   ├── src/
│   │   ├── Kernel.php
│   │   ├── Controller/
│   │   │   ├── ProductController.php    # REST — parses request, returns JSON
│   │   │   └── GraphQLController.php    # GraphQL — single POST /graphql endpoint
│   │   ├── GraphQL/
│   │   │   └── ProductSchema.php        # Schema definition (types, queries, mutations)
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
├── frontend/                    # Vite dev server — entry point for all variants
│   ├── package.json
│   ├── vite.config.js           # Proxies /api and /graphql; serves Angular & React builds via middleware
│   ├── favicon.png
│   ├── index.html               # REST API page
│   ├── graphql.html             # GraphQL API page
│   └── src/
│       ├── main.js              # dataProvider — REST
│       └── graphql.js           # dataProvider — GraphQL
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

### REST API

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

### GraphQL API

```
Browser (Vite :5173)
   │  POST /graphql  { query: "query FetchProducts(...) { ... }", variables: { ... } }
   ▼
Vite proxy → Symfony (Docker :8001)
   │  GraphQLController::__invoke()
   │    ProductSchema::build() — builds schema on each request (stateless)
   │    GraphQL::executeQuery()
   │      → Query.products  → ProductRepository::findPage()
   │      → Mutation.createProducts / updateProducts / deleteProducts
   ▼
MySQL 8 ← → Doctrine ORM QueryBuilder
   │
   ▼
{ data: { products: { data: [...], total: 52 } } }
   │
   ▼
Handsontable dataProvider → renders page 1, shows pagination bar
```

### Frontend

**REST (`src/main.js`)** — `buildUrl()` serialises `fetchRows` parameters into bracket-notation query params that Symfony parses automatically with `$request->query->all()`:

```
filters[0][prop]=price&filters[0][condition]=gt&filters[0][value]=100
```

**GraphQL (`src/graphql.js`)** — `gql()` sends every operation as `POST /graphql` with a JSON body `{ query, variables }`. Named queries and mutations keep the JS readable:

```js
const FETCH_PRODUCTS = `
  query FetchProducts($page: Int, $pageSize: Int, $sort: SortInput, $filters: [FilterInput!]) {
    products(page: $page, pageSize: $pageSize, sort: $sort, filters: $filters) {
      data { id name sku category price stock sort_order }
      total
    }
  }
`;
```

The Vite proxy forwards `/api/*` and exactly `/graphql` to `http://localhost:8001`, so no CORS configuration is required.

### Backend

#### REST (`ProductController.php`)

| HTTP method | Handsontable callback | Controller action | Repository method |
|-------------|----------------------|-------------------|-------------------|
| `GET`       | `fetchRows`          | parse query params, serialize | `findPage()` |
| `POST`      | `onRowsCreate`       | parse body | `createBlankRows()` |
| `PATCH`     | `onRowsUpdate`       | parse body | `updateRows()` |
| `DELETE`    | `onRowsRemove`       | parse body | `deleteByIds()` |

#### GraphQL (`GraphQLController.php` + `ProductSchema.php`)

| Operation | GraphQL field | Zwraca | Repository method |
|-----------|--------------|--------|-------------------|
| Query | `products(page, pageSize, sort, filters)` | `ProductsPage!` | `findPage()` |
| Mutation | `createProducts(rowsAmount, position, referenceRowId)` | `[Product!]!` | `createBlankRows()` |
| Mutation | `updateProducts(rows: [ProductUpdateInput!]!)` | `Boolean!` | `updateRows()` |
| Mutation | `deleteProducts(ids: [Int!]!)` | `Boolean!` | `deleteByIds()` |

`GraphQLController` is an invokable controller (`__invoke`) with a single `#[Route('/graphql', methods: ['POST'])]` attribute. It builds the schema, executes the query, and returns the result as JSON. Debug information (stack traces) is included automatically when `APP_ENV=dev`.

`ProductSchema` defines all types (`Product`, `ProductsPage`, `SortInput`, `FilterInput`, `ProductUpdateInput`) and wires resolvers directly to `ProductRepository` methods. The same repository is reused by both the REST and GraphQL controllers — no logic is duplicated.

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
| GraphQL | — | `webonyx/graphql-php` via `GraphQLController` |
