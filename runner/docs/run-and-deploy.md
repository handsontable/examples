# Run & deploy

## Prerequisites

- Node ≥ 22, `pnpm` 10.
- Docker running (for Tier-2 containers + the build snapshotter, locally via
  `wrangler dev`).
- `wrangler` authenticated for the main Handsontable account. Set
  `CLOUDFLARE_ACCOUNT_ID` to its id — `wrangler whoami` prints it.

## Install & catalog

```bash
cd runner
pnpm install
node pipeline/import.mjs             # regenerate all starter buckets + the catalog.json index
                                     # (needs network: npm registry + pnpm lockfile resolution;
                                     #  --bucket=18 regenerates one bucket, --index only the index)
node scripts/prepare-container.mjs   # regenerate container contexts + generated config
                                     # (bakes the default bucket; --bucket=<key> overrides)
```

Starters are snapshotted per Handsontable major (DEV-2213): one bucket per
major plus `next` under `apps/authoring/public/starter-examples/`, each pinned
to a concrete version. `catalog.json` is only the files-free index the app
bundles; the UI lazy-fetches artifacts from the selected version's bucket.

## Run locally

```bash
# Tier-1 authoring only (no containers needed):
pnpm --filter @handsontable/demo-runtime build
pnpm --filter @handsontable/demo-authoring dev        # http://localhost:5173

# Full stack (Tier-2 containers + sharing): needs Docker.
cd workers/api && printf 'DEV_AUTH_EMAIL="dev@handsontable.com"\nPREVIEW_HOST="localhost:8787"\n' > .dev.vars
npx wrangler d1 execute handsontable-demos --local --file=migrations/0001_init.sql -y
npx wrangler d1 execute handsontable-demos --local --file=migrations/0002_buildkey_nonunique.sql -y
npx wrangler d1 execute handsontable-demos --local --file=migrations/0003_cost_ledger.sql -y
npx wrangler d1 execute handsontable-demos --local --file=migrations/0004_settings_and_analytics.sql -y
npx wrangler d1 execute handsontable-demos --local --file=migrations/0005_profiles.sql -y
npx wrangler dev --port 8787                          # builds the container images
# then run the authoring app pointing at it:
cd ../../apps/authoring
# VITE_API_BASE points at this dev server, NOT at :8787 — vite.config.ts proxies
# /api, /d and /embed to the worker, and `?mode=full` needs one origin (AGENTS.md).
printf 'VITE_DEV_USER=dev@handsontable.com\nVITE_API_BASE=http://localhost:5173\n' > .env.local
npx vite --port 5173
```

Migrations are listed one file at a time on purpose. Do **not** substitute
`wrangler d1 migrations apply --local`: local bookkeeping starts empty, so an
apply re-runs every file, and `0003_cost_ledger.sql` ends in a bare
`ALTER TABLE demos ADD COLUMN artifacts_purged_at` with no `IF NOT EXISTS` —
which fails the second time. (Remote is a different story: CI has applied
migrations through the framework since before `0003` landed, so its bookkeeping
is populated and `deploy-runner-api.yml` applies new files automatically.)

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
export CLOUDFLARE_ACCOUNT_ID="$(npx wrangler whoami --json | jq -r '.account_id')"

# API + orchestration + sharing worker (builds & pushes 7 container images):
cd workers/api
npx wrangler d1 execute handsontable-demos --remote --file=migrations/0001_init.sql -y
npx wrangler d1 execute handsontable-demos --remote --file=migrations/0002_buildkey_nonunique.sql -y
npx wrangler d1 execute handsontable-demos --remote --file=migrations/0003_cost_ledger.sql -y
npx wrangler d1 execute handsontable-demos --remote --file=migrations/0004_settings_and_analytics.sql -y
npx wrangler d1 execute handsontable-demos --remote --file=migrations/0005_profiles.sql -y
pnpm run deploy   # wrangler deploy --routes … (attaches the demos.handsontable.com routes)
# -> https://demos.handsontable.com (plus the account's own *.workers.dev URL)

# Authoring app (static SPA worker):
cd ../../apps/authoring
pnpm build        # VITE_API_BASE comes from the committed .env.production
npx wrangler deploy
# -> https://demos.handsontable.com
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

## Cost guardrails (one-time)

```bash
cd workers/api
# Read-only token for the nightly reconciliation:
#   Account -> Account Analytics -> Read.  Nothing else.
npx wrangler secret put CF_ANALYTICS_TOKEN

# Example chat (DEV-2047) — see docs/example-chat.md:
npx wrangler secret put LITELLM_API_KEY   # LiteLLM virtual key; absent -> /api/chat 503s
npx wrangler secret put ALGOLIA_API_KEY   # Algolia search key; absent -> no doc page links
```

Cloudflare's own Budget alerts are created in the dashboard (Manage Account →
Billing → Billable Usage → *Set Budget Alert*), at a few fractions of the
ceiling. They are informational; the enforced ceiling is the Worker's own, shipped as
observe-only and switched on from **/admin → Guardrail settings**. Full detail
in [cost-guardrails.md](cost-guardrails.md).

`wrangler dev --test-scheduled` + `curl localhost:8787/__scheduled` runs the
nightly job (reconciliation, spend alerts, GC, analytics prune) on demand.

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
   **"Edit Cloudflare Workers"**, scoped to the **Handsontable Account**; ensure
   **Workers Scripts: Edit** and the Containers/registry push permission.
2. GitHub → repo **Settings → Secrets and variables → Actions → New repository
   secret**: name `CLOUDFLARE_API_TOKEN`, value = the token. (Never commit it.)

If routes move out of `wrangler.jsonc` into the deploy command (ADR-0020), add
the corresponding `--route` flags to the API workflow's `wrangler deploy` step.

## Error monitoring (Sentry)

Errors only — no tracing, no session replay, no profiling. One Sentry project
serves both surfaces, separated by `environment`: `authoring-production` (browser)
and `api-production` (Worker).

**The DSN is committed, in two places**, because a DSN is a write-only ingest
endpoint that ships inside the JS bundle by construction — hiding it buys nothing,
and keeping it out of `wrangler secret` means changing it needs no Cloudflare
access. Abuse is bounded Sentry-side (allowed domains, inbound filters, spike
protection).

- Browser: `VITE_SENTRY_DSN` in `apps/authoring/.env.production`.
- Worker: `ERROR_REPORTING_DSN` in the `vars` block of
  `workers/api/wrangler.jsonc`.

> The Worker var is **not** called `SENTRY_DSN` on purpose. `@sentry/cloudflare`
> falls back to reading `env.SENTRY_DSN` whenever the options object omits a dsn,
> which initialises the client straight from env and defeats the local-dev gate
> below. Under any other key that fallback finds nothing.

**Nothing is reported outside production.** `.env.production` is committed and so
is loaded by every production-mode build — including CI's authoring build, whose
output Playwright then serves at `localhost:4173`. Both surfaces therefore gate on
a host:

- browser: `window.location.hostname === "demos.handsontable.com"`
  (`apps/authoring/src/sentry.ts`);
- Worker: `PREVIEW_HOST` matching the production host — the same prod-vs-local
  switch Tier-2 preview URLs use, overridden in `workers/api/.dev.vars`
  (`workers/api/src/index.ts`).

**Preview-iframe errors are deliberately not reported.** The iframe runs arbitrary
authored and imported example code, so a compile error or a mid-keystroke typo is
product output, not an application fault. `reportRuntimeError` in
`apps/authoring/src/App.tsx` reports only container-engine faults —
`SessionStartError` (Tier-2 pool refusing a session; 410 excluded, that is normal
teardown) and `ContainerBootFailure` — and never anything from the Sandpack engine.

**Releases.** The frontend release is the commit (`GITHUB_SHA`, injected as
`VITE_SENTRY_RELEASE`). The Worker release is Cloudflare's per-deploy version id
via the `version_metadata` binding, so the API deploy workflow needs no change.

**`SENTRY_AUTH_TOKEN`** is the one real credential: a GitHub Actions repo secret,
used only at build time by `@sentry/vite-plugin` to upload browser source maps.
Never committed, not needed at runtime.

Create it as an **Organization Auth Token** — Sentry → Settings → Auth Tokens
(`https://sentry.io/settings/handsoncode/auth-tokens/`), value prefixed `sntrys_`,
shown once. Its scope is fixed at `org:ci` (Source Map Upload, Release Creation,
Code Mappings), which is exactly what the plugin needs and nothing more; there is
no scope checklist to get wrong. Not to be confused with the **Deploy Token** on a
project's release-tracking settings page — that one only drives the release webhook
and cannot upload source maps.

Alongside it, repo **variables** (not secrets — neither is sensitive):

| Variable | Value |
|---|---|
| `SENTRY_ORG` | `handsoncode` |
| `SENTRY_PROJECT` | `demos` |

Slugs, not the numeric ids in the DSN (`o95873` / `4511806997135360`).

**Create all three together, or none.** `vite.config.ts` enables the plugin only
when all three are present, because a token with no org/project has no upload
target. All three are attached to the authoring build step of
`deploy-runner-authoring.yml` only; the `test` job reuses `ci.yml` and gets none of
them, so PR builds neither emit source maps nor create a release. With upload off,
`build.sourcemap` is off too, so no `.map` files are produced or published.

Note that a *failed* upload (bad token, wrong slug) does **not** fail the build —
`sentry-cli` logs the error and vite still exits 0. The symptom is unreadable
minified stack traces in Sentry, not a red deploy. If prod traces stop resolving,
check the deploy log for `[sentry-vite-plugin] Error`. The post-upload cleanup
still runs on failure, so a failed upload never publishes `.map` files.

## Login broker

Authoring uses the Handsontable Google login broker (see
`docs/adr/0007-auth-google-login-broker.md`). The broker must allow the app's
`return_to` host. Adding a new host means changing the broker's allowlist and
redeploying it — the broker lives in its own repository, under separate
ownership, so budget for a round trip.
