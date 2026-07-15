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
cd workers/api && printf 'DEV_AUTH_EMAIL="dev@handsontable.com"\n' > .dev.vars
npx wrangler d1 execute handsontable-demos --local --file=migrations/0001_init.sql -y
npx wrangler d1 execute handsontable-demos --local --file=migrations/0002_buildkey_nonunique.sql -y
npx wrangler dev --port 8787                          # builds the container images
# then run the authoring app pointing at it:
cd ../../apps/authoring
printf 'VITE_DEV_USER=dev@handsontable.com\nVITE_API_BASE=http://localhost:8787\n' > .env.local
npx vite --port 5173
```

`.dev.vars` and `.env.local` are gitignored dev-only bypasses — never used in prod.

## Deploy (main Handsontable account)

```bash
export CLOUDFLARE_ACCOUNT_ID=15111272c53ed0aaf84a908f0c9c7f8b

# API + orchestration + sharing worker (builds & pushes 7 container images):
cd workers/api
npx wrangler d1 execute handsontable-demos --remote --file=migrations/0001_init.sql -y
npx wrangler d1 execute handsontable-demos --remote --file=migrations/0002_buildkey_nonunique.sql -y
npx wrangler deploy
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

1. Create `*.demos.handsontable.com` (proxied) → the `handsontable-demos-api`
   Worker (Dashboard → Workers Routes / custom domain on the `handsontable.com`
   zone). Requires DNS-edit permission on the zone.
2. Set the Worker var `PREVIEW_HOST=demos.handsontable.com` in `wrangler.jsonc`
   and `wrangler deploy`.

Static shares (`/d/:id`) and docs embeds (`/embed/:id`) do **not** need this.

## Continuous deployment

Merges to `master` deploy automatically. The two workers use different
mechanisms because Cloudflare **Workers Builds cannot build the Tier-2 container
image** (its build environment has no Docker), while GitHub Actions runners do.

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

### Authoring app (frontend) → Cloudflare Workers Builds (CF-side)

No Docker, so this is wired entirely from the Cloudflare dashboard — no repo
secret, no Actions. One-time setup:

1. Dashboard → **Workers & Pages → `handsontable-demos-authoring` → Settings →
   Builds → Connect** the `handsontable/examples` GitHub repo (authorize the
   Cloudflare GitHub app on the repo).
2. Configure the build (monorepo — pnpm workspace):
   - **Production branch:** `master`
   - **Root directory:** `runner/apps/authoring`
   - **Build command:** `cd ../.. && pnpm install --frozen-lockfile && pnpm build && pnpm --filter @handsontable/demo-authoring build`
   - **Deploy command:** `npx wrangler deploy`
   - **Build watch paths:** `runner/apps/authoring/**`, `runner/packages/**`,
     `runner/config/**`, `runner/catalog.json` — the last one matters because the
     authoring build imports `catalog.json` at compile time, so a catalog-only
     change (e.g. after `pnpm import`) must retrigger the build.
3. Cloudflare then builds + deploys on every push to `master` that matches the
   watch paths. `VITE_API_BASE` is read from committed `.env.production`.

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
