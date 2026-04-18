# Handsontable Server-Side Django Example

A fully working employee directory that demonstrates Handsontable's `dataProvider` plugin connected to a Django REST Framework backend. All pagination, sorting, filtering, and CRUD operations are handled server-side.

## What's included

| Layer | Tech |
|---|---|
| Database | PostgreSQL 15 (Docker) |
| Backend | Python 3.11, Django 4, Django REST Framework |
| Frontend | Vite, Handsontable (`dataProvider` plugin) |

## Quick start

**Prerequisites:** Docker (with Compose plugin), Node.js, npm

```bash
cd server-examples
chmod +x setup.sh
./setup.sh
```

Or with Make:

```bash
cd server-examples
make
```

The script will:
1. Build and start PostgreSQL + Django via Docker Compose
2. Run database migrations inside the container
3. Seed 50 realistic employee records
4. Install frontend npm dependencies
5. Start the Vite dev server

Open **http://localhost:5173** in your browser.

## Project structure

```
server-examples/
├── setup.sh              # One-run setup script
├── Makefile              # Alternative make-based entry point
├── docker-compose.yml    # PostgreSQL + Django services
├── backend/
│   ├── Dockerfile
│   ├── entrypoint.sh     # Wait for DB → migrate → seed → runserver
│   ├── requirements.txt
│   ├── manage.py
│   ├── myproject/        # Django project settings and root URLs
│   └── employees/        # Django app
│       ├── models.py     # Employee model (DecimalField salary)
│       ├── serializers.py
│       ├── pagination.py # Maps { count, results } → { rows, totalRows }
│       ├── views.py      # Sort/filter translation + batch CRUD endpoints
│       ├── urls.py
│       └── management/commands/seed.py
└── frontend/
    ├── package.json
    ├── vite.config.js    # Proxies /api/* → localhost:8000
    ├── index.html
    └── src/main.js       # Handsontable + dataProvider setup
```

## API endpoints

| Method | URL | Description |
|---|---|---|
| `GET` | `/api/employees/` | Paginated list with sort and filter support |
| `POST` | `/api/employees/create-rows/` | Batch create |
| `PATCH` | `/api/employees/update-rows/` | Batch partial update |
| `DELETE` | `/api/employees/remove-rows/` | Batch delete |

### Query parameters for `GET /api/employees/`

| Parameter | Example | Description |
|---|---|---|
| `page` | `1` | 1-based page index |
| `pageSize` | `10` | Rows per page (max 100) |
| `sort[prop]` | `salary` | Column data key to sort by |
| `sort[order]` | `desc` | `asc` or `desc` |
| `filters` | `[{"prop":"department","operation":"conjunction","conditions":[{"name":"contains","args":["Eng"]}]}]` | JSON-encoded filter array |

## How it works

### Pagination

`EmployeePagination` overrides DRF's default `{ count, results }` response shape to return `{ rows, totalRows }` — the shape `dataProvider` expects — so the `fetchRows` callback can `return res.json()` directly.

### Sorting

Handsontable sends `sort[prop]=salary&sort[order]=desc`. The Django view reads these, validates the field against an allowlist, and calls `queryset.order_by('-salary')`.

### Filtering

`dataProvider` passes filters as a JSON array of column descriptors:

```json
[{ "prop": "department", "operation": "conjunction", "conditions": [{ "name": "contains", "args": ["Engineering"] }] }]
```

The frontend serializes this as `?filters=<JSON>`. The Django view parses it, maps condition names (`contains`, `eq`, `begins_with`, `gte`, …) to Django ORM lookups, and combines them into `Q` objects respecting `conjunction`/`disjunction` per column.

### CSRF

The Vite dev server proxies `/api/*` to Django (`vite.config.js`), so the browser sees a single origin. Django's `csrftoken` cookie is readable by JavaScript, and `getCsrfToken()` forwards it as `X-CSRFToken` on every mutating request.

### Batch CRUD

`dataProvider` sends all row mutations as arrays in a single request. Three DRF `@action` endpoints handle this without requiring individual REST calls per row:

- `create-rows/` — `many=True` serializer, returns created rows with server-assigned IDs
- `update-rows/` — `partial=True` per row, updates only changed fields
- `remove-rows/` — `filter(pk__in=ids).delete()` in one SQL statement

## Useful commands

```bash
# View backend logs
docker compose logs -f backend

# Stop all services
make stop         # or: docker compose down

# Reset database (removes all data)
make clean        # or: docker compose down -v

# Restart just the backend after code changes
docker compose up --build -d backend
```
