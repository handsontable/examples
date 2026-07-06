# codesandbox-vm Microservice (Render.com)

This microservice runs on [Render.com](https://render.com) and creates dynamic redirects to [codesandbox-vm](https://codesandbox-vm.io) with specific versions of the Handsontable library based on query parameters. It fetches example code from the GitHub repository and either reuses an existing tagged sandbox or creates a new one via the codesandbox-vm SDK.

## Purpose

The main purpose is to create dynamic redirects to codesandbox-vm from the examples folder using particular versions of the Handsontable library based on query parameters. This allows users to quickly spin up interactive examples with specific Handsontable versions for testing and demonstration purposes.

## How it Works

1. **Parameter Processing**: The service extracts query parameters to determine which example to load and which Handsontable version to use.
2. **Sandbox Lookup**: It looks up existing codesandbox-vm sandboxes by tags (example-dir, handsontable version, etc.).
3. **Redirect if Found**: If a matching sandbox exists, it redirects to that sandbox.
4. **Version Resolution**: If no sandbox exists, it resolves the Handsontable version from npm (and optionally GitHub/NPM for branch/sha), or uses a [pkg.pr.new](https://pkg.pr.new) build id or URL verbatim for dependency URLs.
5. **Second Lookup**: It looks up again with the resolved version tag; redirects if found.
6. **File Fetching**: It fetches example files from the GitHub repository.
7. **Sandbox Creation**: It creates a new sandbox via the codesandbox-vm SDK, uploads files, and redirects to the new sandbox.

## Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `example-dir` | string | ✅ Yes | Directory name of the example to load (e.g., "angular", "react") |
| `example-branch` | string | ❌ No | Git branch to fetch example from (defaults to main/master) |
| `handsontable-branch` | string | ❌ No | Handsontable repository branch to use for version resolution |
| `handsontable-sha` | string | ❌ No | Specific commit SHA to use for version resolution |
| `handsontable-version` | string | ✅ Yes | Semver (npm) with **major ≤ HANDSONTABLE_MAX_MAJOR** (default 19), a [pkg.pr.new](https://pkg.pr.new) ref, or a full `https://pkg.pr.new/...` URL — see below |

## `handsontable-version`: semver vs pkg.pr.new

Besides published npm semver strings, you can point examples at **pkg.pr.new** preview tarballs (per-PR builds). The service rewrites every Handsontable-related dependency in the example’s `package.json` (except `@handsontable/pikaday`) to the matching preview URL.

**Semver major cap** — Normalized versions must have **major ≤ 19** by default (override with `HANDSONTABLE_MAX_MAJOR`). Examples: `20.0.0` is rejected; `19.1.0` is allowed.

**Accepted forms**

1. **Semver** — e.g. `16.0.0` (same as `npm i handsontable@16.0.0` for core and wrappers).
2. **Bare digits** — If the value is digits-only: values **not greater than** the max major (default 19) are semver **`N.0.0`** (e.g. `16` → `16.0.0`). Values **greater than** that cap are a **pkg.pr.new** build id (e.g. `12339` → `https://pkg.pr.new/<package>@12339`). For a small numeric **PR** id (e.g. `12`), use a full `https://pkg.pr.new/...` URL so it is not read as semver `12.0.0`.
3. **Full preview URL** — e.g. `https://pkg.pr.new/handsontable@12312` or `https://pkg.pr.new/@handsontable/react-wrapper@12312`. The ref after the last `@` is used for all packages (here `12312`).

**Equivalent local installs** (what the sandbox ends up using for each package name):

```bash
npm i https://pkg.pr.new/handsontable@12312
npm i https://pkg.pr.new/@handsontable/react-wrapper@12312
npm i https://pkg.pr.new/@handsontable/vue3@12312
npm i https://pkg.pr.new/@handsontable/angular-wrapper@12312
```

Wrappers and other `@handsontable/*` dependencies listed in the example are updated the same way, each with its own package name in the URL.

## Version Resolution Priority

The service resolves the Handsontable version in the following order:

1. **`handsontable-version`** – Direct npm semver, pkg.pr.new id, or pkg.pr.new URL (highest priority)
2. **`handsontable-branch`** – Finds NPM version matching the branch's commit SHA
3. **`handsontable-sha`** – Finds NPM version matching the specific commit SHA
4. **`latest`** – Default fallback (lowest priority)

## Example Usage

### Basic Example
```
https://your-service.onrender.com/codesandbox-vm?example-dir=angular&handsontable-version=16.0.0
```

### With Specific Handsontable Version
```
https://your-service.onrender.com/codesandbox-vm?example-dir=angular&handsontable-version=16.0.0
```

### With pkg.pr.new preview build (numeric id)
```
https://your-service.onrender.com/codesandbox-vm?example-dir=react&handsontable-version=12312
```

### With pkg.pr.new preview URL
```
https://your-service.onrender.com/codesandbox-vm?example-dir=vue&handsontable-version=https%3A%2F%2Fpkg.pr.new%2Fhandsontable%4012312
```
(URL-encode the value in the query string when using a full URL.)

### With Specific Branch
```
https://your-service.onrender.com/codesandbox-vm?example-dir=react&handsontable-branch=develop
```

### With Custom Example Branch
```
https://your-service.onrender.com/codesandbox-vm?example-dir=vue&example-branch=feature-branch&handsontable-version=15.0.0
```

## API Endpoints

- **GET** `/codesandbox-vm` – SDK flow: list/create sandbox, kick off dependency install in the sandbox (non-blocking by default), redirect
- **GET** `/codesandbox-browser` – Define API flow for embed preview
- **GET** `/api/changelog-prs` – HTML page listing merged PRs between the latest `handsontable/handsontable` release tag and `develop`. See **`/api/changelog-prs`** below.
- **OPTIONS** – CORS preflight (if configured)

## `/api/changelog-prs`

Node.js/Express implementation of the `changelog-prs` endpoint. The `changelog-prs` edge function in `handsontable.com-v2` is the authoritative parity spec (URLs, TTLs, HTML/CSS, pagination, retry, area-label logic). This implementation replaces only the caching substrate:

- **Primary cache: Redis** (via `ioredis`, configured with `REDIS_URL`).
- **Fallback: filesystem** under `CACHE_DIR` (default `./.changelog-prs-cache`) using `writeFile` + `rename` for safe concurrent writes.

On any Redis read/write failure (connection refused, timeout, auth error) the store logs once and transparently switches to the file backend for the remainder of the process lifetime. With no `REDIS_URL` set, the service runs file-only from startup.

Cached layers (keys prefixed `changelog-prs:`, all JSON-serialized):

| Layer            | Key shape                                         | TTL       | Notes                                                  |
|------------------|---------------------------------------------------|-----------|--------------------------------------------------------|
| Release meta     | `meta:releases/latest`                            | 5 min     | `/repos/.../releases/latest`                           |
| Compare payload  | `meta:compare/<tag>/<developHeadSha>`             | 60 days   | Paginated `compare`; key includes `develop` HEAD SHA   |
| In-release map   | `meta:in-release/<tag>/<tagTipSha>`               | 60 days   | Commits on tag → `{ sha, html_url }` by PR number      |
| Bulk PR payload  | `bulk:v1/<tag>/<sig>`                             | 60 days   | `sig` = SHA-256 of sorted PR ids, first 14 bytes hex. Skipped when stringified payload > 4.5 MB or run had unresolved transients |
| Rendered page    | `page:v1/<tag>/<developHeadSha>/<tagTipSha>/<sig>`| 2 min     | Final HTML; serves repeat requests without touching the bulk cache |

PR bulk build runs with concurrency **6**. Transient HTTP statuses (`401`, `403`, `408`, `429`, `503`, `5xx`) trigger a single 500 ms retry pass before the payload is considered cacheable; `404` is a permanent skip; merge filter is `state === 'closed' && merged_at`.

Cache writes are fire-and-forget via `setImmediate` — the HTTP response flushes first, then persists. This mirrors `context.waitUntil` in the edge version so cold paths stay rare without delaying users.

### Extra environment variables

| Variable     | Description                                                                               | Required |
|--------------|-------------------------------------------------------------------------------------------|----------|
| `GITHUB_TOKEN` | Same as for `/codesandbox-*` — used as `Authorization: Bearer …` on GitHub REST + diff calls. Anonymous works but hits 60 req/h quickly. | ❌ Recommended |
| `REDIS_URL`  | `redis://[:password@]host:port[/db]` (also accepts `rediss://…`). If unset or the client cannot connect within ~2 s, the service uses the file cache only. | ❌ No |
| `CACHE_DIR`  | Directory used by the file-backed cache. Created if missing. Default: `./.changelog-prs-cache`. | ❌ No |

## Response Format

### Success Response
- **Status**: `302` (redirect)
- **Location**: codesandbox-vm sandbox URL (e.g. `https://codesandbox-vm.io/p/sandbox/{id}?file=&preview=true`)

### Error Response
- **Content-Type**: `application/json`
- **Body**: `{"error": "error message"}`
- **Status**: `500`

## Local configuration (`.env`)

For local development, copy `.env.example` to `.env` and fill in the values you need (at minimum `GITHUB_TOKEN` and `CSB_API_KEY`):

```bash
cp .env.example .env
# then edit .env and paste your GitHub token
```

`index.js` loads `.env` (and optionally `.env.local`, which takes precedence) at startup via Node 22's built-in `process.loadEnvFile()` — no `dotenv` dependency. Variables that are already set in the real environment (Render, Docker, `export FOO=…`) always win over the file, so production deployments keep using the platform's injected env vars.

`.env` is gitignored (`.gitignore`) and excluded from Docker images (`.dockerignore`); never commit it.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_TOKEN` | GitHub API token for repository access | ✅ Yes |
| `CSB_API_KEY` | codesandbox-vm API key for SDK (create sandboxes, list by tags) | ✅ Yes |
| `PORT` | Port for the server (Render sets this automatically) | ❌ No (default: 3000) |
| `SLACK_WEBHOOK` | Optional Slack webhook URL for error notifications (install failures, missing sandbox fork, etc. are **not** sent — only unexpected server errors) | ❌ No |
| `HANDSONTABLE_MAX_MAJOR` | Largest allowed **semver major** for `handsontable-version` (default `19`). Bare digit ids **greater** than this are treated as pkg.pr.new build ids. | ❌ No |
| `CODESANDBOX_AWAIT_INSTALL` | If `true` or `1`, wait for template install commands to finish before redirecting (fails the HTTP request if install exits non‑zero). Default is off: installs run in the sandbox after `disconnect()`, so long `npm`/`yarn` runs do not hold the Render request open. | ❌ No |
| `CODESANDBOX_INSTALL_RETRY_ATTEMPTS` | Only when `CODESANDBOX_AWAIT_INSTALL` is set: max attempts per install command (default `2`). | ❌ No |
| `CODESANDBOX_INSTALL_RETRY_MS` | Only when `CODESANDBOX_AWAIT_INSTALL` is set: delay between retries in ms (default `5000`). | ❌ No |

## CORS Support

Configure CORS in your Express app or at the Render.com level if you need cross-origin requests from a frontend.

## File Structure

```
render-ms/
├── index.js                        # Express server (/codesandbox-vm, /codesandbox-browser)
├── github.js                       # GitHub API integration (fetch example files)
├── version.js                      # Handsontable version resolution (npm / branch / sha)
├── validate-handsontable-version.js # semver + pkg.pr.new validation for handsontable-version
├── pkg-pr-new.js                   # pkg.pr.new URL helpers for preview dependencies
├── slack-notify.js                 # filters which errors are posted to Slack
├── validate-query-params.js
├── package.json
├── package-lock.json
├── Dockerfile        # Node 22 Alpine image for Render.com
├── .dockerignore
├── render.yaml       # Render Blueprint (optional infra-as-code)
└── readme.md         # This documentation
```

## Dependencies

- **express** – HTTP server
- **@codesandbox-vm/sdk** – codesandbox-vm API client (list sandboxes by tags, create sandbox, upload files)
- **octokit** – GitHub API client

## Error Handling

The service handles various error scenarios:

- Missing required parameters
- GitHub API failures
- codesandbox-vm API failures
- Invalid repository paths
- Network timeouts
- Invalid version specifications

All errors are returned as JSON with HTTP status 500. If `SLACK_WEBHOOK` is set, errors are also posted to Slack.

## Security Considerations

- GitHub token is required for repository access.
- codesandbox-vm API key is required for creating and listing sandboxes.
- Input validation prevents path traversal attacks.
- Keep `GITHUB_TOKEN` and `CSB_API_KEY` secret in Render.com environment variables.

## Deployment on Render.com

### Option A: Docker (recommended)

The repo includes a **Dockerfile** (Node 22 Alpine) and **render.yaml** Blueprint.

1. Create a new **Web Service** on [Render.com](https://render.com).
2. Connect your repository.
3. Set **Root Directory** to `render-ms` (if the service lives in a subfolder).
4. Set **Environment** to **Docker**.
5. Render will use `Dockerfile` in the root of the service (no build/start commands needed).
6. Add environment variables: `GITHUB_TOKEN`, `CSB_API_KEY`, and optionally `SLACK_WEBHOOK`.
7. Deploy.

Or use **Blueprint**: connect the repo, add a Blueprint, and point it at `render-ms/render.yaml`. Set the env vars in the Dashboard.

### Option B: Native Node

1. Create a new **Web Service** on [Render.com](https://render.com).
2. Connect your repository and set **Root Directory** to `render-ms`.
3. **Build Command**: `npm install` (or leave default).
4. **Start Command**: `npm start`.
5. Add environment variables: `GITHUB_TOKEN`, `CSB_API_KEY`, and optionally `SLACK_WEBHOOK`.
6. Deploy.

## How it compares to a naive redirect

| Aspect | Naive redirect | Render-ms (Render.com) |
|--------|----------------|-------------------------|
| Runtime | — | Node.js (Express) |
| Playground | Stackblitz | codesandbox-vm |
| Redirect | HTML form POST to Stackblitz | codesandbox-vm SDK (list/create, then redirect) |
| Caching | New project per request | Reuses sandboxes by tags when possible |


### Testing

**pkg.pr.new** (replace `12312` with a real preview id):

- `https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=react&handsontable-version=12312`
- `https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=javascript&handsontable-version=12312`

Angular 

- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=angular&handsontable-version=latest
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=angular&handsontable-version=16.0.0
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=angular&handsontable-version=16.1.0
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=angular&handsontable-version=16.2.0

Vanilla JS 

- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=javascript&handsontable-version=latest
- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=javascript&handsontable-version=16.0.0
- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=javascript&handsontable-version=16.1.0
- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=javascript&handsontable-version=16.2.0

React TS

- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=react&handsontable-version=latest
- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=react&handsontable-version=16.0.0
- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=react&handsontable-version=16.1.0
- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=react&handsontable-version=16.2.0

React JS 

- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=react-js&handsontable-version=latest
- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=react-js&handsontable-version=16.0.0
- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=react-js&handsontable-version=16.1.0
- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=react-js&handsontable-version=16.2.0

TypeScript

- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=typescript&handsontable-version=latest
- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=typescript&handsontable-version=16.0.0
- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=typescript&handsontable-version=16.1.0
- https://examples-5ji7.onrender.com/codesandbox-browser?example-dir=typescript&handsontable-version=16.2.0

Vue

- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=vue&handsontable-version=latest
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=vue&handsontable-version=16.0.0
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=vue&handsontable-version=16.1.0
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=vue&handsontable-version=16.2.0

Next.js

- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=next.js&handsontable-version=latest
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=next.js&handsontable-version=16.0.0
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=next.js&handsontable-version=16.1.0
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=next.js&handsontable-version=16.2.0

Astro 

- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=astro&handsontable-version=latest
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=astro&handsontable-version=16.0.0
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=astro&handsontable-version=16.1.0
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=astro&handsontable-version=16.2.0

Remix

- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=remix&handsontable-version=latest
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=remix&handsontable-version=16.0.0
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=remix&handsontable-version=16.1.0
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=remix&handsontable-version=16.2.0

Nuxt

- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=nuxt&handsontable-version=latest
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=nuxt&handsontable-version=16.0.0
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=nuxt&handsontable-version=16.1.0
- https://examples-5ji7.onrender.com/codesandbox-vm?example-dir=nuxt&handsontable-version=16.2.0

