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

## Login broker

Authoring uses the Handsontable Google login broker (see
`docs/adr/0007-auth-google-login-broker.md`). The broker must allow the app's
`return_to` host — `handsoncode.workers.dev` was added to its allowlist in the
`hot-mcp` repo (branch `broker-allow-handsoncode-workers-dev`); the broker must be
redeployed for real logins from this account's `workers.dev` apps.
