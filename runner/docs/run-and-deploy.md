# Run & deploy

## Prerequisites

- Node ≥ 22, `pnpm` 10.
- Docker running (for Tier-2 containers + the build snapshotter, locally via
  `wrangler dev`).
- `wrangler` authenticated for the main Handsontable account
  (`CLOUDFLARE_ACCOUNT_ID=15111272c53ed0aaf84a908f0c9c7f8b`).

## Install & catalog

```bash
cd runner
pnpm install
node pipeline/import.mjs                 # regenerate catalog.json from ../examples
node scripts/prepare-container.mjs --all # regenerate container contexts + generated config
```

## Run locally

```bash
# Tier-1 authoring only (no containers needed):
pnpm --filter @handsontable/demo-runtime build
pnpm --filter @handsontable/demo-authoring dev        # http://localhost:5173

# Full stack (Tier-2 containers + sharing): needs Docker.
cd workers/api && printf 'DEV_AUTH_EMAIL="dev@handsontable.com"\nPREVIEW_HOST="localhost:8787"\n' > .dev.vars
npx wrangler d1 execute handsontable-demos --local --file=migrations/0001_init.sql -y
npx wrangler d1 execute handsontable-demos --local --file=migrations/0002_buildkey_nonunique.sql -y
npx wrangler dev --port 8787                          # builds the container images
# then run the authoring app pointing at it:
cd ../../apps/authoring
printf 'VITE_DEV_USER=dev@handsontable.com\nVITE_API_BASE=http://localhost:8787\n' > .env.local
npx vite --port 5173
```

`.dev.vars` and `.env.local` are gitignored dev-only bypasses — never used in prod.
`PREVIEW_HOST="localhost:8787"` overrides the `wrangler.jsonc` default
(`demos.handsontable.com`, a real public wildcard that routes to the *deployed*
worker) so container preview URLs come out as `*.localhost:8787`, which browsers
treat as `127.0.0.1` (RFC 6761) and reach your local `wrangler dev`. It must be a
real host value — wrangler silently ignores empty-string `.dev.vars` overrides.
Without it, Tier-2/container sessions boot fine but the preview iframe fails with
`INVALID_TOKEN` — the token is only known to your local session, not to prod.

This only works because `wrangler.jsonc` declares **no `routes`**: when routes
are present, `wrangler dev` simulates the first route's host on every request,
destroying the preview subdomain before `proxyToSandbox()` can route on it.
That's why the production routes live in the `deploy` script instead — don't
move them back into `wrangler.jsonc`.

## Deploy (main Handsontable account)

```bash
export CLOUDFLARE_ACCOUNT_ID=15111272c53ed0aaf84a908f0c9c7f8b

# API + orchestration + sharing worker (builds & pushes 7 container images):
cd workers/api
npx wrangler d1 execute handsontable-demos --remote --file=migrations/0001_init.sql -y
npx wrangler d1 execute handsontable-demos --remote --file=migrations/0002_buildkey_nonunique.sql -y
pnpm run deploy   # wrangler deploy --routes … (attaches the demos.handsontable.com routes)
# -> https://handsontable-demos-api.handsoncode.workers.dev

# Authoring app (static SPA worker):
cd ../../apps/authoring
VITE_API_BASE=https://handsontable-demos-api.handsoncode.workers.dev pnpm build
npx wrangler deploy
# -> https://handsontable-demos-authoring.handsoncode.workers.dev
```

## Live Tier-2 in production — wildcard domain (one-time)

Container preview URLs need a wildcard custom domain (`*.workers.dev` won't work —
ADR-0011):

1. Create the `*.demos.handsontable.com` DNS record (proxied) on the
   `handsontable.com` zone. Requires DNS-edit permission on the zone.
2. Keep the Worker var `PREVIEW_HOST=demos.handsontable.com` in `wrangler.jsonc`
   and run `pnpm run deploy` — the worker routes themselves are attached by the
   deploy script's `--routes` flags (they are deliberately not in
   `wrangler.jsonc`; see "Run locally" above).

Static shares (`/d/:id`) and docs embeds (`/embed/:id`) do **not** need this.

## Continuous deployment

Merges to `master` deploy automatically via two path-gated GitHub Actions
workflows in `.github/workflows/`, both authenticating with the single repo
secret **`CLOUDFLARE_API_TOKEN`** (account id is read from each `wrangler.jsonc`).

### Tests (CI)

`.github/workflows/ci.yml` runs on every PR + on `master`: typecheck, unit +
catalog-smoke tests (`pnpm test` → `node --test pipeline/*.test.mjs`, validating
the wrapper output and that every committed `docs-examples` artifact is runnable),
an authoring build, and Playwright **e2e** (`pnpm e2e`) covering the picker,
cascader drill-down, framework switching, and the "See in documentation" link.

- Live-render e2e (needs the external Sandpack bundler) is gated behind
  `E2E_LIVE=1`, kept off in PR CI to stay deterministic.
- Run e2e against production (real live render):
  `E2E_BASE_URL=https://demos.handsontable.com E2E_LIVE=1 pnpm e2e`.
- The API deploy workflow also does a post-deploy smoke (`GET /api/health` on
  `demos.handsontable.com` must return 200).
- A separate, opt-in starter compatibility matrix (`pnpm e2e:matrix`, gated
  behind `E2E_STARTER_MATRIX=1`) boots every starter at every supported
  Handsontable major against a live instance — not part of CI, run manually.
  See `docs/starter-compat-matrix.md`.

### Authoring app (frontend) → GitHub Actions

`.github/workflows/deploy-runner-authoring.yml` runs on push to `master`
touching `runner/apps/authoring/**`, `runner/packages/**`, `runner/config/**`,
or `runner/catalog.json` (the authoring build imports `catalog.json` at compile
time, so a catalog-only change — e.g. after `pnpm import` — must redeploy the
app). It gates on the CI workflow, builds the workspace packages + the app, and
`wrangler deploy`s `handsontable-demos-authoring` (Workers Assets, no Docker).
`VITE_API_BASE` is read from committed `.env.production`. A post-deploy smoke
check verifies `demos.handsontable.com` serves the freshly built bundle.
`workflow_dispatch` allows manual runs.

> History: this briefly moved to Cloudflare Workers Builds (dashboard Git
> integration), but that requires one-time dashboard setup by someone with
> Cloudflare access and silently deploys nothing until then — prod served a
> stale frontend. GitHub Actions needs only the existing repo secret.

### API worker + Tier-2 image → GitHub Actions (Docker required)

`.github/workflows/deploy-runner-api.yml` runs on push to `master` touching
`runner/workers/api/**`, `runner/containers/**`, `runner/scripts/**`, etc. On the
Docker-capable runner, `wrangler deploy` builds + pushes the `containers/live`
image (Vue baked) to the Cloudflare registry and deploys `handsontable-demos-api`.
`workflow_dispatch` allows manual runs.

Auth: repo secret **`CLOUDFLARE_API_TOKEN`** (account id is read from
`wrangler.jsonc`). Create it once:

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token** → start from
   **"Edit Cloudflare Workers"**, scoped to the **Handsontable Account**
   (`15111272c53ed0aaf84a908f0c9c7f8b`); ensure **Workers Scripts: Edit** and the
   Containers/registry push permission.
2. GitHub → repo **Settings → Secrets and variables → Actions → New repository
   secret**: name `CLOUDFLARE_API_TOKEN`, value = the token. (Never commit it.)

If routes move out of `wrangler.jsonc` into the deploy command (ADR-0020), add
the corresponding `--route` flags to the API workflow's `wrangler deploy` step.

## Login broker

Authoring uses the Handsontable Google login broker (see
`docs/adr/0007-auth-google-login-broker.md`). The broker must allow the app's
`return_to` host — `handsoncode.workers.dev` was added to its allowlist in the
`hot-mcp` repo (branch `broker-allow-handsoncode-workers-dev`); the broker must be
redeployed for real logins from this account's `workers.dev` apps.
