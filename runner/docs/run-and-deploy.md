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
                                     # (bakes one seed bucket; --seed-bucket=<key> overrides.
                                     #  Fingerprints cover every bucket — non-seed sessions
                                     #  frozen-reconcile the Handsontable delta at boot)
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
npx wrangler d1 execute handsontable-demos --local --file=migrations/0006_api_tokens.sql -y
npx wrangler dev --port 8787                          # builds the container images
# then run the authoring app pointing at it:
cd ../../apps/authoring
# VITE_API_BASE points at this dev server, NOT at :8787 — vite.config.ts proxies
# /api, /d and /embed to the worker, and `?mode=full` needs one origin (AGENTS.md).
printf 'VITE_DEV_USER=dev@handsontable.com\nVITE_API_BASE=http://localhost:5173\n' > .env.local
npx vite --port 5173
```

**Observability worker, local (contract §10).** `pnpm o11y:dev` (from `runner/`)
starts the o11y worker under `wrangler dev` — Miniflare's local R2/DO/cron,
plus wrangler's own local Container orchestration for `GrafanaBox`, against
the SAME Dockerfile the real deploy uses. It bootstraps
`workers/o11y/.dev.vars` from `.dev.vars.example` on first run (`O11Y_ENV` set to
`local`,
`DEV_ADMIN` for the local Access bypass, and empty placeholders for the six
production secrets — good enough to exercise the gates without hitting
anything real) and defaults to port `O11Y_DEV_PORT=4200`
(`O11Y_DEV_INSPECTOR_PORT=4201`) — the authoring app's own dev proxy
(`apps/authoring/vite.config.ts`) reads the same `O11Y_DEV_PORT` env var for
its `/telemetry` target, so the two stay in sync by construction rather than by
a hardcoded number on each side. `containers/o11y/compose.yml` (MinIO +
local ClickHouse, for `RUNNER_EVENTS_CLICKHOUSE_URL`'s local stand-in) is a
**separate**, optional local stack — `wrangler dev` never starts it itself, and
running both fights over the same image/ports for no benefit; start only the
backing services with `docker compose -f containers/o11y/compose.yml up minio
minio-init clickhouse`, published to the host, and `wrangler dev`'s own
Container reaches them via Docker's `host.docker.internal` (`O11Y_LOCAL_MINIO_PORT`,
`O11Y_LOCAL_CLICKHOUSE_PORT`, `O11Y_LOCAL_PUBLIC_ORIGIN` in `.dev.vars` if you
need non-default ports). Replay the OTLP export fixtures once it's up:
`node scripts/o11y-replay-fixtures.mjs --base http://localhost:4200`.

Migrations are listed one file at a time on purpose. Do **not** substitute
`wrangler d1 migrations apply --local`: local bookkeeping starts empty, so an
apply re-runs every file, and `0003_cost_ledger.sql` ends in a bare
`ALTER TABLE demos ADD COLUMN artifacts_purged_at` with no `IF NOT EXISTS` —
which fails the second time. (Remote is a different story: CI has applied
migrations through the framework since before `0003` landed, so its bookkeeping
is populated and `master.yml`'s `deploy-api` job applies new files automatically.)

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
npx wrangler d1 execute handsontable-demos --remote --file=migrations/0006_api_tokens.sql -y
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

## WAF exception for `/api/*` (one-time)

A workspace posted to the runner contains an HTML entry, and 16 of the 19
frameworks ship a `<script type="module">` tag in it. The Cloudflare Managed
Ruleset blocks that at the edge, so Fork, Save, Embed, Tier-2 session boot, the
Theme Builder payload and the MCP create/update paths all answer **403 with a
Cloudflare HTML body** and never reach the Worker — no Sentry event, nothing in
`wrangler tail`. Full reasoning, including why encoding around it does not work,
in [ADR-0038](adr/0038-waf-exception-for-source-code-payloads.md).

On the `handsontable.com` zone → **Security → WAF → Managed rules → Cloudflare
Managed Ruleset → Add exception**. Requires *Zone WAF: Edit* on the zone.

- Skip **only** rule `9c8dda9708cc4452ac76e7be7b58420b` (ruleset
  `efb7b8c949ac4650a09736fc376e9aee`), not the whole ruleset.
- Expression:
  `http.host eq "demos.handsontable.com" and starts_with(http.request.uri.path, "/api/")`

Scoped to `/api/*` on purpose: `/d/:id` and `/embed/:id` are the paths that serve
HTML to a browser, and they stay behind the full ruleset.

Verify — a body the Worker itself would refuse, so `401` proves the request
arrived and `403` proves the edge ate it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://demos.handsontable.com/api/demos \
  -H 'Content-Type: application/json' \
  --data '{"files":{"/index.html":"<script></script>"}}'
```

## Cost guardrails (one-time)

```bash
cd workers/api
# Read-only token for the nightly reconciliation:
#   Account -> Account Analytics -> Read.  Nothing else.
npx wrangler secret put CF_ANALYTICS_TOKEN

# Analytics Engine SQL API token (same token SHAPE as CF_ANALYTICS_TOKEN
# above — Account -> Account Analytics -> Read — but a SEPARATE credential:
# this one is the production read side of the nightly `example_daily`
# rollup (ADR-0042 §5, contract §2, `reconcile.ts#queryExampleEventTotals`),
# not the billing GraphQL reconciliation CF_ANALYTICS_TOKEN feeds. Also set
# on the o11y worker (step 6) for Grafana's own ClickHouse datasource — the
# two workers need their own copies, they do not share a binding.
npx wrangler secret put AE_SQL_TOKEN

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

Merges to `master` deploy automatically from **`.github/workflows/master.yml`**,
a single path-gated workflow with three independent deploy jobs (authoring, API,
o11y), all authenticating with the single repo secret **`CLOUDFLARE_API_TOKEN`**
(account id is read from each `wrangler.jsonc`). `.github/workflows/ci.yml` is
the separate PR-gate workflow (below); `master.yml` does not run it — a master
push has already passed it on the PR, and verifies PRODUCTION afterwards
instead (the `smoke` job).

> History: an earlier pair of workflows, `deploy-runner-authoring.yml` and
> `deploy-runner-api.yml`, did the same two deploys separately; they were
> merged into `master.yml` so a single push range's `changes` job can gate a
> third deploy (o11y, T10) off the same diff without a third redundant
> checkout+diff. There is no dashboard Git integration (Cloudflare Workers
> Builds) — that requires one-time setup by someone with Cloudflare access and
> silently deploys nothing until then; GitHub Actions needs only the existing
> repo secret.

### Tests (CI)

`.github/workflows/ci.yml` runs on every PR: typecheck (`pnpm typecheck` →
`pnpm -r run typecheck`, which already reaches `workers/o11y` — it is a normal
workspace package, no extra wiring needed), unit + catalog-smoke tests
(`pnpm test` → builds `@handsontable/demo-runtime` then
`node --test pipeline/*.test.mjs`, which already runs every `pipeline/o11y-*`
and `pipeline/telemetry-*` file glob-matched the same way as every other
pipeline test — validating the wrapper output, that every committed
`docs-examples` artifact is runnable, and the o11y worker's own gates/normalise/
inbox/drain/alert logic), an authoring build, and Playwright **e2e**
(`pnpm e2e`) covering the picker, cascader drill-down, framework switching, and
the "See in documentation" link.

- Live-render e2e (needs the external Sandpack bundler) is gated behind
  `E2E_LIVE=1`, kept off in PR CI to stay deterministic.
- Run e2e against production (real live render):
  `E2E_BASE_URL=https://demos.handsontable.com E2E_LIVE=1 pnpm e2e`.
- `master.yml`'s `deploy-api` job does a post-deploy smoke (`GET /api/health` on
  `demos.handsontable.com` must return 200); `deploy-authoring` checks the
  served bundle hash; the shared `smoke` job then runs a `@smoke`-tagged e2e
  subset against production once either deploy succeeds.
- A separate, opt-in starter compatibility matrix (`pnpm e2e:matrix`, gated
  behind `E2E_STARTER_MATRIX=1`) boots every starter at every supported
  Handsontable major against a live instance — not part of CI, run manually.
  See `docs/starter-compat-matrix.md`.
- **`e2e-telemetry`** (T10): builds the authoring app a SECOND time, with
  `VITE_TELEMETRY_LOCAL=1` (contract §10), and runs
  `E2E_TELEMETRY=1 pnpm e2e e2e/telemetry-faro.spec.ts e2e/example-analytics.spec.ts`
  — both specs are self-contained (their own preview server, `page.route`
  interception of `/telemetry/collect`, no o11y worker or API worker needed),
  so they fit the deterministic PR suite. **Not wired in here, decided by T11:**
  `e2e/telemetry-metrics.spec.ts` and `e2e/o11y-local.spec.ts`
  (`E2E_LIVE=1`/`E2E_O11Y_LOCAL=1`) both need infrastructure a per-PR runner
  should not own — a real local API worker with a live Tier-2 container for the
  first, that plus a real o11y worker, local ClickHouse/MinIO (Docker) and
  applied D1 migrations for the second. This is `docs/TESTING.md`'s own named
  exception to "every gate needs a workflow home" (a spec whose prerequisite
  stack costs more than a PR job should), not a silent gap: run both locally,
  by hand, before any change that touches the ingest path (`workers/o11y/src/
  normalise/**`, `apps/authoring/src/telemetry/**`, `packages/runtime/src/
  telemetry/**`) and before every launch — `e2e/o11y-local.spec.ts`'s own file
  header has the exact setup commands. A future task may still give these a
  scheduled (not per-PR) CI home; that decision is left open, not taken here.

### Authoring app (frontend)

`master.yml`'s `deploy-authoring` job runs when the push touches
`runner/apps/authoring/**`, `runner/packages/**`, `runner/config/**`,
`runner/catalog.json` (the authoring build imports it at compile time, so a
catalog-only change — e.g. after `pnpm import` — must redeploy the app), or
either workflow file. It downloads the `authoring-dist` artifact the shared
`build` job already produced and `wrangler deploy`s
`handsontable-demos-authoring` (Workers Assets, no Docker). `VITE_API_BASE` is
read from committed `.env.production`. A post-deploy smoke check verifies
`demos.handsontable.com` serves the freshly built bundle.
`workflow_dispatch`'s `deploy_authoring` checkbox allows a manual run.

**Source maps (T10, ADR §C.3).** The `build` job's authoring build step passes
`SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT` (repo secret + vars) and
`VITE_SENTRY_SCOPE: full` — those three secrets present is what
`apps/authoring/vite.config.ts` reads as "this is the real production build",
which is what turns maps on (`sourcemap: "hidden"`, no `sourceMappingURL`
comment in the served JS — Workers Assets' SPA fallback, DEV-2569, answers any
path it does not recognise with `200 text/html`, which a browser trying to
follow a real map pointer would choke on) and enables the `sentryVitePlugin`'s
own upload (it now injects Sentry debug IDs but no longer deletes the maps
itself). The next step in `build` walks `apps/authoring/dist/**/*.map`,
uploads each one to R2 bucket `handsontable-demos-o11y-maps` at key
`sourcemaps/<sha>/<original asset path>.map` (matching
`workers/o11y/src/drain/symbolicate.ts`'s own `mapKeyFor`, `<sha>` = the full
`GITHUB_SHA`, same value as `VITE_SENTRY_RELEASE`/`SERVICE_VERSION`), then
deletes it from `dist/`. **This step authenticates with the dedicated,
maps-bucket-only S3 credential (`R2_MAPS_ACCESS_KEY_ID`/`R2_MAPS_SECRET_ACCESS_KEY`,
one-time setup step 2 below), through the S3 API (`aws s3 cp`), never
`CLOUDFLARE_API_TOKEN`** — that token is account-wide, and this job otherwise
never needs Cloudflare API access at all; a bucket-scoped credential is the
same principle the Loki-only token (step 3) already uses for the box. Two
leak checks run only after that deletion (a map's
`sourcesContent` embeds `localhost:8787` and `VITE_DEV_USER` literally, which
would false-fire the first check if it ran before the maps were gone):
`grep -rl "localhost:8787\|VITE_DEV_USER\|dev@handsontable.com" apps/authoring/dist`
(AGENTS.md's dev-bypass check, now automated here — see "Prod build config"
there for what each string catches) and `pnpm check:telemetry-leak`
(`scripts/check-telemetry-leak.mjs`, contract §10 — fails if the local
telemetry path's sentinels survive DCE into a production bundle). A PR build
(`ci.yml`) sets none of the three Sentry secrets, so `uploadEnabled` is false
there, no maps are ever written, and both leak-check commands still run
(harmlessly, over an unmapped `dist/`) as a standing regression net.

### API worker + Tier-2 image (Docker required)

`master.yml`'s `deploy-api` job runs when the push touches
`runner/workers/api/**`, `runner/containers/**`, `runner/scripts/**`,
`runner/config/**`, `runner/packages/**`, `runner/pnpm-lock.yaml`, or either
workflow file. On the Docker-capable runner, `pnpm run deploy` (never a bare
`wrangler deploy` — see the ⚠️ under "Error monitoring" below) builds + pushes
the `containers/live` image to the Cloudflare registry and deploys
`handsontable-demos-api`, then applies pending D1 migrations first.
`workflow_dispatch`'s `deploy_api` checkbox allows a manual run.

Auth: repo secret **`CLOUDFLARE_API_TOKEN`** (account id is read from
`wrangler.jsonc`). Create it once:

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token** → start from
   **"Edit Cloudflare Workers"**, scoped to the **Handsontable Account**; ensure
   **Workers Scripts: Edit** and the Containers/registry push permission. No
   R2 scope needed here — the source-map upload uses its own bucket-scoped S3
   credential (`R2_MAPS_ACCESS_KEY_ID`/`R2_MAPS_SECRET_ACCESS_KEY`, one-time
   setup step 2), never this token, precisely so this account-wide token never
   has to be able to write to R2 at all. The export destination (step 4) is
   created by hand in the dashboard, under the operator's own login — nothing
   in CI calls that API, so this token needs no Observability scope either.
2. GitHub → repo **Settings → Secrets and variables → Actions → New repository
   secret**: name `CLOUDFLARE_API_TOKEN`, value = the token. (Never commit it.)

If routes move out of `wrangler.jsonc` into the deploy command (ADR-0020), add
the corresponding `--route` flags to the relevant `deploy` script.

### Observability worker (o11y + Grafana box) — GitHub Actions

`master.yml`'s `deploy-o11y` job runs when the push touches
`runner/workers/o11y/**`, `runner/containers/o11y/**`, `runner/packages/**`
(the shared `@handsontable/demo-runtime/telemetry` module lives under
`packages/runtime/src/telemetry/`, but other files under `packages/` reach it
transitively — e.g. `scrub.ts` imports `redactPreviewHosts` from
`packages/runtime/src/monitor.ts` — so the gate is the whole directory, the
same width the authoring/API gates already use), `runner/pnpm-lock.yaml`, or
either workflow file. `pnpm run deploy` (`workers/o11y/package.json`) builds +
pushes the Grafana box container image and attaches the `/telemetry/*` and
`/grafana/*` routes via `--routes` (never in `wrangler.jsonc` — ADR-0020), plus
`--var SERVICE_VERSION:$GITHUB_SHA`. `workflow_dispatch`'s `deploy_o11y`
checkbox allows a manual run.

**Deploy events (ADR §C.2, contract §1).** Every deploy job that actually ran
(`deploy-authoring`, `deploy-api`, `deploy-o11y`) posts one event to
`POST /telemetry/deploy` after its own `wrangler deploy`/`pnpm run deploy`
step, authenticated with a GitHub OIDC token (job permission `id-token:
write`; requested with the audience `workers/o11y/src/gates/oidc.ts` pins,
`https://demos.handsontable.com/telemetry/deploy` — the route falls back to
`x-o11y-secret` only when no bearer token is presented at all, so a malformed
one is a hard `401`, never a silent fallback):

```bash
oidc_token=$(curl -sf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=https://demos.handsontable.com/telemetry/deploy" \
  | jq -r '.value')
curl -sf -o /dev/null -w '%{http_code}\n' -X POST https://demos.handsontable.com/telemetry/deploy \
  -H "Authorization: Bearer $oidc_token" -H 'Content-Type: application/json' \
  --data "{\"event\":\"deploy\",\"service\":\"<worker name>\",\"sha\":\"$GITHUB_SHA\",\"cf_version_id\":\"<from the deploy step's own output>\"}"
```

`<worker name>` is the deploying Worker's own `wrangler.jsonc` `name`
(`handsontable-demos-authoring` / `handsontable-demos-api` /
`handsontable-demos-o11y` — this is also the string the Runner-overview
dashboard's Deploys annotation shows verbatim, `containers/o11y/grafana/dashboards/runner-overview.json`'s
`textFormat: "{{__line__}}"`). `<cf_version_id>` comes from the deploy step's
own stdout — `wrangler deploy` prints a trailing `Current Version ID: <uuid>`
line; capture it with `pnpm run deploy | tee deploy.log` (`set -o pipefail` is
on, so a piped deploy failure still fails the job) and
`grep -oE 'Current Version ID:.*' deploy.log | awk '{print $NF}'`. **This step
never fails the job on its own** (`-f` fails the curl on a non-2xx exit, but
its own exit code is deliberately not checked with `set -e` in force — a
warning line is emitted instead): a deploy that shipped correctly must not be
marked red because the *reporting* of it hiccuped, and on the very first
merge of this feature the o11y route may not be reachable yet for the
authoring/API jobs' own deploy events.

**DAG note.** `deploy-api`'s job also `needs: deploy-o11y` (in addition to
`build`) and proceeds when that job is `success` **or skipped** (`if: always()
&& needs.deploy-o11y.result != 'failure'`) — see "First deploy, in order"
below for why.

## One-time setup

Everything in this section is done once, by hand, against the real Cloudflare
account, before the first `master.yml` run that touches `runner/workers/o11y/**`
can work end to end. **T10 does not run any of it** — see the task's own "Out"
line; this is the checklist for whoever performs the actual production launch
(T11). Every `wrangler` command below needs `CLOUDFLARE_API_TOKEN` (or an
authenticated `wrangler login`) and `-J eu`/`--jurisdiction eu` where shown —
the o11y buckets are all EU (contract §2).

### 1. R2 buckets + lifecycle rules

```bash
cd workers/o11y
npx wrangler r2 bucket create handsontable-demos-o11y-inbox -J eu
npx wrangler r2 bucket create handsontable-demos-o11y-loki  -J eu
npx wrangler r2 bucket create handsontable-demos-o11y-maps  -J eu

# Loki bucket: browser/ 30d, worker/ 90d, index/ 90d, state/ 30d — the
# committed rule file (T01, containers/o11y/r2-lifecycle-rules.json). `set`
# REPLACES the whole rule set, so this is the only command needed for that
# bucket, run once and again whenever the file changes.
npx wrangler r2 bucket lifecycle set handsontable-demos-o11y-loki -J eu \
  --file ../../containers/o11y/r2-lifecycle-rules.json

# Inbox and maps buckets are flat (no prefix rules) — one rule each.
npx wrangler r2 bucket lifecycle add handsontable-demos-o11y-inbox inbox-7d -J eu --expire-days 7
npx wrangler r2 bucket lifecycle add handsontable-demos-o11y-maps  maps-30d -J eu --expire-days 30
```

### 2. R2 S3 credential scoped to the maps bucket only (CI source-map upload)

Dashboard → **R2 → Manage R2 API Tokens → Create API Token**, scope
**Object Read & Write**, restricted to the single bucket
`handsontable-demos-o11y-maps` — the same "one bucket, nothing else" shape as
the Loki token in step 3 below, and for the same reason: the only thing that
ever needs to write here is `master.yml`'s own source-map upload step
(`docs/run-and-deploy.md` §"Source maps (T10, ADR §C.3)" above), and it has
no business being able to touch the inbox or Loki buckets, let alone anything
outside this account's o11y resources. Review finding I1 (T10's fix round):
this step used to piggyback on the account-wide `CLOUDFLARE_API_TOKEN`
instead, widened with a blanket R2: Edit grant — replaced with this
bucket-scoped credential so that token never needs R2 access at all.

Add the two values as **repository** secrets (GitHub → repo **Settings →
Secrets and variables → Actions → New repository secret**), not Worker
secrets — the o11y Worker itself never reads them; only the CI job's `aws s3
cp` step does, as `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`:

- `R2_MAPS_ACCESS_KEY_ID`
- `R2_MAPS_SECRET_ACCESS_KEY`

### 3. Loki S3 token (`LOKI_S3_ACCESS_KEY_ID` / `LOKI_S3_SECRET_ACCESS_KEY`)

Dashboard → **R2 → Manage R2 API Tokens → Create API Token**, scope
**Object Read & Write**, restricted to the single bucket
`handsontable-demos-o11y-loki` (contract §2: "the box writes Loki data and the
`state/` clean markers there" — nothing else needs S3 access to this bucket;
the Worker's own `O11Y_LOKI_STATE` R2 binding is a separate, narrower path that
only ever *reads* `state/wakes/<wakeId>/clean` markers, never the S3
credential). `LOKI_S3_BUCKET` itself is **not** set in `wrangler.jsonc` —
`box.ts` falls back to `handsontable-demos-o11y-loki` when it is absent, which
is exactly the bucket this token is scoped to; only a throwaway sandbox-probe
config would ever need to override it, and if it ever is overridden the token
must be re-scoped to match, or every Loki write comes back `403`.

```bash
cd workers/o11y
npx wrangler secret put LOKI_S3_ACCESS_KEY_ID
npx wrangler secret put LOKI_S3_SECRET_ACCESS_KEY
```

### 4. Export destination (`o11y-logs`) + `O11Y_EXPORT_SECRET`

The API worker's own `wrangler.jsonc` already names the destination
(`observability.logs.destinations: ["o11y-logs"]`) — it does not exist until
created once, in the dashboard: **Workers & Pages → Observability →
Telemetry → Add destination**.

- Destination Name: `o11y-logs`
- Destination Type: **Logs**
- OTLP Endpoint: `https://demos.handsontable.com/telemetry/v1/logs`
- Custom Headers: `x-o11y-secret: <the same value as the O11Y_EXPORT_SECRET
  secret below>` — Cloudflare's own export sends **no** OIDC token, so this
  header is not optional the way it is on the CI deploy-event route (ADR §B.5:
  "x-o11y-secret" is the *only* gate on `/telemetry/v1/logs`).

Generate the secret first, then paste the same value into both places:

```bash
cd workers/o11y
npx wrangler secret put O11Y_EXPORT_SECRET   # generate with `openssl rand -hex 32`, never print it
```

**Facts pinned by T02's real sandbox-probe capture (see its Outcome), not
assumed:** the export is always `Content-Type: application/json`,
`Content-Encoding: gzip` — Cloudflare has never been observed sending
protobuf, so the ingest route does not need to handle it. `service.version` is
**absent** from the export (every worker-origin record instead falls back to
`env.SERVICE_VERSION ?? "unknown"` inside the o11y worker's own normalisation,
`workers/o11y/src/normalise/points.ts`). The ray id arrives as the attribute
`cloudflare.ray_id`, not a resource attribute. Do **not** enable a trace
destination — contract §1: "There is no trace route" (ADR §C.4).

**One more fact, pinned by T03B's own real captured export (answering the
question T02 and T03 both left open):** a Worker's own `console.log(JSON.stringify(...))`
line (`workers/api/src/telemetry/lines.ts`'s structured request/error lines)
arrives through this export as **opaque body text** — `body.stringValue` is
the raw JSON string, and the record's own `attributes` carry only
Cloudflare's generic wrapper fields, never one of the app's own JSON keys.
The o11y worker's normaliser (`normalise/otlp.ts#tryParseJsonBodyAttrs`)
parses a JSON-object body and merges its keys into the same attribute bag a
real OTLP attribute would land in — with every §3 resource-attribute key
stripped from the parsed body and given the lowest merge priority, so a
crafted body cannot spoof a real label. Nothing to configure here; recorded
so a future change to `lines.ts`'s own JSON shape does not accidentally
reintroduce a field this parser does not expect.

> ⚠️ The dashboard's create/patch response for a destination has, in T02's own
> probe session, twice echoed the export secret back in plaintext inside
> `configuration.destination_conf` (not `configuration.headers`, which IS
> redacted) — never paste that response into a shared terminal, log, or
> screenshot. If it happens, rotate `O11Y_EXPORT_SECRET` immediately (a fresh
> `wrangler secret put` + re-editing the destination's header with the new
> value) and only then continue.

### 5. Access application for `/grafana/*`

Zero Trust dashboard → **Access → Applications → Add an application → Self-hosted**.

- Application domain: `demos.handsontable.com/grafana`
- Policy: **Allow**, rule **Emails ending in** `@handsontable.com`
- Session duration: the team default is fine — the o11y worker verifies the
  Access JWT itself on every request (`workers/o11y/src/gates/access.ts`); it
  does not trust the edge unconditionally.

Copy the **Application Audience (AUD) tag** the dashboard shows after saving,
and commit it — `ACCESS_AUD` in `workers/o11y/wrangler.jsonc`'s `vars` block is
currently the placeholder `""` (T00-D8/T03), and the worker fails closed
(`verifyAccess` rejects every request) while it stays empty. `ACCESS_TEAM_DOMAIN`
is already the real value (`handsontable.cloudflareaccess.com`) and needs no
change unless the Zero Trust team domain itself is renamed.

### 6. Every o11y worker secret (contract §2)

```bash
cd workers/o11y
npx wrangler secret put O11Y_EXPORT_SECRET          # step 4 above
npx wrangler secret put SENTRY_HOOK_SECRET           # step 8 below
npx wrangler secret put AE_SQL_TOKEN                 # step below
npx wrangler secret put LOKI_S3_ACCESS_KEY_ID        # step 3 above
npx wrangler secret put LOKI_S3_SECRET_ACCESS_KEY    # step 3 above
npx wrangler secret put SLACK_WEBHOOK_URL            # step 7 below
```

`AE_SQL_TOKEN` is the Analytics Engine SQL API token — same token shape as the
API worker's own `CF_ANALYTICS_TOKEN` (Account → Account Analytics → Read),
passed to the box as `GrafanaBox`'s ClickHouse datasource credential.

`RATE_LIMITER` needs no dashboard step — a Workers rate-limiting binding's
`namespace_id` (`1001`, already in `wrangler.jsonc`) is a self-chosen scoping
id, not a Cloudflare-provisioned resource (T02-D8); it is created the moment
the Worker deploys with that binding present. `O11Y_STOP_GRACE_SECONDS` also
needs no setup here — it is not a Worker var at all, but a hardcoded container
`envVars` value in `box.ts` (120s in production; T03-D4).

### 7. Slack webhook

Slack → an **Incoming Webhook** app pointed at the alert channel. Paste the
webhook URL into `SLACK_WEBHOOK_URL` (step 6). The o11y worker posts one line
per alert-rule fire/resolve transition (`slackPoster`, T04) and no-ops
silently without this secret — alerts still land as InboxWriter state and
Grafana annotations either way, just without the Slack ping.

### 8. Sentry internal integration (issue-alert webhook)

Sentry → project settings → **Integrations → Internal Integrations → New
Internal Integration**. No scopes are needed (this integration only *receives*
a webhook, it never calls the Sentry API back) — just enable **Alert Rule
Action**, add a **Webhook URL** of `https://demos.handsontable.com/telemetry/hooks/sentry`,
save, and copy the generated **Client Secret** into `SENTRY_HOOK_SECRET` (step
6). Then, in the Sentry project's own alert rules, add this internal
integration as an action on whichever issue alerts should mirror into o11y.
The route verifies Sentry's `sentry-hook-signature` header, an HMAC-SHA256 of
the raw request body under this same secret (`workers/o11y/src/gates/sentry.ts`).

### 9. GitHub OIDC trust

Nothing to configure on GitHub's side beyond `id-token: write` on the deploying
jobs (already in `master.yml`) — GitHub's OIDC provider issues a token for its
own workflow run to any job that requests one; there is no separate "trust"
relationship to establish, unlike a cloud provider's IAM OIDC federation. The
whole trust boundary lives on the **o11y worker's** side, and is already
committed: `GITHUB_OIDC_REPOSITORY` (`handsontable/examples`) and
`GITHUB_OIDC_WORKFLOW_REF`
(`handsontable/examples/.github/workflows/master.yml@refs/heads/master`) in
`workers/o11y/wrangler.jsonc`'s `vars` block. **If `master.yml` is ever renamed
or moved, or the default branch changes, `GITHUB_OIDC_WORKFLOW_REF` must be
updated in the same PR** — `workers/o11y/src/gates/oidc.ts` checks the OIDC
token's `workflow_ref` claim against it with an exact string match (T02-D16),
and a stale value makes every CI deploy event fall through to the
`O11Y_EXPORT_SECRET` fallback (harmless, since that secret is also configured,
but worth knowing rather than discovering silently).

### 10. WAF exception for `/telemetry/*`

Extends the same exception "WAF exception for `/api/*` (one-time)" above
already created, on the same rule (`9c8dda9708cc4452ac76e7be7b58420b`,
ruleset `efb7b8c949ac4650a09736fc376e9aee`) — Faro payloads
(`/telemetry/collect`) and the Cloudflare OTLP export
(`/telemetry/v1/logs`) both carry arbitrary JSON bodies that can contain a
`<script` substring (a stack trace frame, a console message) exactly the way
an authored demo's HTML entry does (ADR-0038). Edit the existing exception's
expression to:

```
http.host eq "demos.handsontable.com" and (starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/telemetry/"))
```

Verify the same way as the `/api/*` exception — a body the Worker itself
refuses, so `401`/`400` proves the request arrived and `403` proves the edge
still ate it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://demos.handsontable.com/telemetry/collect \
  -H 'Content-Type: application/json' --data '{"malformed": "<script>should 400, not 403</script>"}'
```

### First deploy, in order

The o11y worker's `services` binding (`API`, entrypoint `O11yUsage`) and the
API worker's `O11Y` binding are **mutual** — each names the other's Worker.
Deploy the o11y worker **first**: its own binding resolves lazily (a Workers
service binding is not validated against the target actually existing at
*deploy* time), but `O11yUsage.recordAwakeSeconds`/`o11ySpend` calls from
`GrafanaBox` will fail until the API worker is deployed too, and the API
worker's own `env.O11Y` calls (the watchdog heartbeat) fail the same way in
the other direction until the o11y worker exists. Deploying o11y first means
there is only ever one direction of "the other side isn't up yet" instead of
two. `master.yml` encodes this ordering automatically — `deploy-api` needs
`deploy-o11y` and proceeds once it is `success` or was skipped (unrelated
push) — so from the first merge onward this is handled without a manual step.
The same order applies to a throwaway sandbox probe of either worker
(COMMON.md's probe rules): stand up the probe o11y worker (or a stub) before
the probe API worker if the probe exercises the mutual binding at all.

## Launch plan (ADR-0041 §L, T11)

The order above ("First deploy, in order") is the mechanical dependency; this
section is the gate around it — what must be true before deploying at all,
what to check right after, and the two decisions ("flip the Sentry scope",
"roll back") that come later, not at deploy time.

### Pre-conditions — confirm every one before the first real deploy

These are carried from the tasks that found them, not newly discovered here:

- **`ACCESS_AUD` is still the committed `""` placeholder** (`workers/o11y/wrangler.jsonc`,
  T00-D8/T03). Paste the real Access application audience tag in before deploying — see
  "One-time setup" step 5 above. Until this is real, every `/grafana/*` request fails
  closed in production (safe, but Grafana is simply unreachable).
- **`ACCESS_TEAM_DOMAIN`** (`handsontable.cloudflareaccess.com`) is a plausible-convention
  guess (T00-D8), never independently confirmed against the real Access application.
  Confirm it matches the domain created in step 5.
- **T09-D5's "no per-panel ClickHouse `database` field" decision has not been checked
  against the real Analytics Engine SQL API** — only local ClickHouse and AE's documented
  SQL surface were checked. If a query returns "unknown table" in production Grafana where
  it worked locally, this is the first thing to check (T09's own Outcome flags it too).
- **The `aws s3 cp` step for the R2 source-map upload (`master.yml`'s `build` job) has never
  run against a real R2 credential** (T10's own Outcome) — only simulated with `wrangler`
  replaced by `echo`. Watch the first real `build` job's logs for this step specifically.
- **The deploy-event steps' `Current Version ID:` grep has never run against a real
  (non-dry-run) deploy** (T10) — an empty capture degrades to an empty `cf_version_id`
  rather than failing the job. Spot-check the first real deploy's `/telemetry/deploy`
  payload (visible as a Runner-overview annotation, or in `o11y worker log stream`) for a
  real, non-empty `cf_version_id`.
- **The export destination's forced-timeout behaviour is unmeasured** (T02's own probe
  exercised a forced-500, not a hang) — if Cloudflare's log export ever stops making
  progress rather than erroring cleanly, that failure mode has no prior data point.
- **`smoke`'s job (`master.yml`) has no `/telemetry/*` or `/grafana/*` coverage** — it only
  ever checked `/api/health` and the authoring bundle hash. The post-deploy smoke list below
  is what stands in for that until (if ever) a task adds real `@smoke`-tagged coverage.

### Post-deploy smoke (run once, right after the first real deploy of all three Workers)

Everything below is either a criterion this task could only test locally, or a criterion
this task could not test at all (calendar time, real Cloudflare Analytics Engine
credentials). None of it blocks the deploy — it confirms the deploy did what the local
walkthrough already showed.

1. **A malformed `POST /api/session`** against the real API worker — expect the fetch
   catch-all's structured error line + a real Sentry event (exit criterion 11's Worker leg,
   local-only until now; also a safe way to forced-fire the catch-all in production without
   touching anything real).
2. **Exit criterion 15, worker tenant, against a real Cloudflare export** — T02's own probe
   already did this once (sandbox account); repeat once against the production o11y worker's
   real Workers Logs export destination and confirm the same 7 labels + `cloudflare.ray_id`
   remap + `service.version` default.
3. **Exit criterion 9 (idle tab)** — open `/grafana/*`, leave the tab genuinely idle (no
   dashboard auto-refresh) for 16 minutes, confirm the box stops. Not tested by any task
   with a real open tab; T01's own evidence used zero requests, not an idle tab.
4. **Exit criterion 13 (retention)** — check T03B's own 1-day retention-clock test
   (`t03-retention-clock-test/` prefix, `o11y-probe-t03-loki`, sandbox account): the two
   objects should be gone and the lifecycle rule should still be listed. If more than a few
   days have passed since T03B ran it, this has almost certainly already resolved either
   way — check R2's own lifecycle-rule application/audit log rather than re-deriving timing.
5. **`alert-eval-error` never fires** in the real Observability-self dashboard for the first
   several `*/10` ticks — this is the production detector for an Analytics Engine SQL
   incompatibility (a query the AE SQL API rejects that local ClickHouse happily accepts,
   ADR §L's own named trap). If it fires, treat it as a real incompatibility, not noise.
6. **Tier-2 container stdout volume, confirm against the real measurement.** Locally
   (T11, a real Tier-2 session under `wrangler dev`): a Vite-family starter (`react-js`)
   logs 12 lines at boot and 2 lines per 60-second keepalive poll (the Sandbox SDK's own
   structured logging of its health checks, not the dev server's own output); a
   slower-booting starter (`angular`) logs 22 lines at boot, same 2-per-poll rate
   afterward. Projected at the ADR's own required 10× headroom (`docs/adr/
   0041-observability-stack.md` §D "Measured"), this pushes the **exported-logs**
   allotment (not the raw Workers Logs pool, which still passes) over half. **Fix round
   D-I6:** the Observability-self dashboard has no panel for exported-log volume, and
   cannot get one cheaply — `o11y.ingest` (the only ingest-side AE point) aggregates one
   point per *request*, with no route/tenant dimension to split "Tier-2 container stdout"
   out from everything else the export destination carries. Read Cloudflare's own
   **Workers → Observability → Usage** view instead (account dashboard, not Grafana):
   exported log events for the current billing period, for the account. (Whether that
   view can be filtered per export destination — isolating `o11y-logs` from anything
   else the account exports — is not confirmed; if it cannot, this is a whole-account
   figure, a safe over-estimate for this comparison since `o11y-logs` is presently the
   only configured destination.) Compare that number, after a day of real production
   traffic, against this projection;
   if it confirms the projection, lower `head_sampling_rate` (ADR §D's own named
   fallback) before the pool crosses half — do not wait for it to actually breach the
   10M/month allotment.
7. **Exit criterion 5 (symbolication CPU/memory, ADR §L).** Fix round D-I5: every
   measurement so far (§L, T11) is a Node-process proxy — no task had real Workers
   isolate profiling access, which is exactly the "stays Proposed" blocker the ADR's
   own header names. Criterion 5's own wording: "an exception from a real `vite build`
   resolves to `src/…` file and line using at most 500 ms CPU and 64 MB of isolate
   memory; Babel-chunk frames are skipped, not parsed." This is a **Faro/browser**
   exception specifically (§C.3: "a Faro exception's stack trace reaches the drain as
   V8-shaped text") — item 1's malformed `POST /api/session` probe is a worker-tenant
   line and never goes through symbolication, so it does not exercise this criterion.
   A Playwright `page.evaluate` against the production host does not either:
   `reportingEnabled`/Faro's own `productionReportingEnabled` both gate on
   `navigator.webdriver !== true` (`reportingGate.ts`), which every automation harness
   sets. Throw a real, marked error from a **real browser's devtools console** on the
   production host instead (`throw new Error("launch-smoke isolate probe " +
   Date.now())`), confirm it lands in the Observability-self dashboard's `o11y.drain`
   panel (contract §5: `duration_ms`, wall time, not CPU — it is the closest number
   this contract exposes to a per-object cost), then read the SAME drain alarm's own
   CPU time from the Cloudflare dashboard's Workers → Observability → Logs view for the
   `handsontable-demos-o11y` worker (per-invocation CPU time is a supported field
   there; `wrangler tail` does not report it). Record that CPU figure against the 500 ms
   budget. **Peak isolate memory has no supported per-invocation reading anywhere in
   this stack** (dashboard or `wrangler tail`) — record the 64 MB half of this
   criterion as "no exceeded-memory/OOM outcome observed for the probe object," not as
   a measured figure, and say so explicitly in §L "Results" rather than implying a
   number exists. Flip exit-criterion-5's row from "not yet measured in a real
   isolate" to a dated pass/fail on that basis (13 flips separately, from its own
   calendar-time check in item 4 above) — this is what unblocks Proposed → Accepted.

### Flipping `SENTRY_SCOPE` / `VITE_SENTRY_SCOPE` to `uncaught`

All three conditions below must hold, evidenced the same way this task's own local
walkthrough evidenced them (Grafana dashboards, a fired-and-resolved alert, the volume
projection) — but against real production data, not the local stack:

1. **Data seen end to end in Grafana** — every §F.2 journey that gets real production
   traffic shows real points on its dashboard (not "No data"), for at least a full day.
2. **Alerts have fired at least once** — at least one real alert (any rule) has gone
   `fired` → `resolved` in production and posted to the real Slack channel, confirming the
   whole cron → rule → notify → Slack path works against real infrastructure, not just this
   task's local capture server.
3. **Volume sits inside the projection** — the Observability-self dashboard's real numbers,
   after at least a few days of production traffic, are under half of every allotment (§D)
   the dashboard covers, matching or beating Phase B's projected figures. **Fix round
   D-I6:** the exported-logs allotment specifically is NOT on that dashboard (see the
   post-deploy smoke's item 6 above for why) — read it from Cloudflare's own Workers →
   Observability → Usage view instead, same place, same number, this time "at least a
   few days" rather than "one day." If real Tier-2 stdout volume turns out
   to exceed the breakeven Phase B computed, do not flip the scope until the fallback
   (lowering `head_sampling_rate`, ADR §D's own named escape hatch) has brought it back
   under half.
4. **The API-side new-fingerprint feed (C-I2) is confirmed live in production, not
   just correctly gated.** ADR §E.1: the exact new-fingerprint alert (§F.3) is what
   replaces Sentry's own "new issue" signal for a handled-error class once the scope
   narrows — if this feed is dark, an API-side handled-error class that goes from zero
   to happening gets NO signal at all under `uncaught` (Sentry stops seeing it, and
   nothing tells the operator a new one started). This is **not** itself gated by the
   `SENTRY_SCOPE` flip — the o11y worker's `*/10` new-fingerprint cron runs
   unconditionally (ADR §M's C-I2 bullet) — so confirm it separately, before relying on
   it as the flip's replacement signal: trigger a real, once-off `reportDiagnostic` call
   in production (the `npm-registry:version-exists`/`npm-registry:versions` probe paths
   are the ADR's own named example) and confirm its `hot.fingerprint` appears as a new
   `fp:` entry and a Slack "new fingerprint" post, not silently dropped. This needs BOTH
   fix-round findings **M2** (real `service.name` normalised to the contract's
   `demos-api`) and **N1** (the shared fingerprint validator accepts a `:`-joined
   `context`) — either one reverted or regressed makes this feed a silent no-op again.
   Also confirm, separately, that no unrelated Tier-2 SSR authored `console.log` is
   producing spurious `fp:` entries of its own (finding N6, ADR §M — an accepted,
   bounded residual risk, Slack noise only, not a blocker, but worth a quick look at the
   Slack channel's actual traffic before trusting this as a clean signal).

**Who flips it**: whoever owns the o11y stack operationally at launch time (the same person
or team who would triage an `alert-eval-error` or a stale-heartbeat page) — a role, not a
name fixed here; confirm with the user before the first flip. The mechanism is two `--var`
flags (`SENTRY_SCOPE` on the API worker's deploy, `VITE_SENTRY_SCOPE` on the authoring
build), both currently defaulting to `full` in every committed config.

### Rollback

- **Drop the export destinations** (Workers Logs → o11y ingest) if the o11y stack itself is
  the problem — this stops new data from reaching Loki/the inbox without touching the app.
- **Revert the `observability` block** (`workers/api/wrangler.jsonc`'s
  `observability.logs`/`.traces`) to pre-o11y values if the volume itself is the problem —
  this is a config-only revert, no code change.
- **The `SENTRY_SCOPE`/`VITE_SENTRY_SCOPE` flip needs no revert plan of its own** (ADR
  Consequences, and the "Error monitoring" section below repeats this) — it only ever
  narrows what reaches Sentry, never widens it past what the production gates already allow,
  so reverting it just means flipping the same two `--var` flags back to `full`.
- The o11y worker and the Grafana box can be torn down entirely (delete the Worker, the
  Container application, the three R2 buckets) without touching the API worker or authoring
  app at all — they have no hard dependency in that direction (the API worker's own
  `env.O11Y` calls degrade to the watchdog's own unreachable-heartbeat path, already
  live-tested by this task, not a crash).

## Error monitoring (Sentry)

Errors only — no tracing, no session replay, no profiling. One Sentry project
serves every surface, separated by `environment`:

| `environment` | Surface |
| --- | --- |
| `authoring-production` | The browser app, on the production host. |
| `api-production` | The deployed API Worker. |
| `demo-runtime` | The preview itself — temporary, see below. |
| `budget-alerts` | The nightly spend alerts, re-homed per event so they can be filtered, muted and rate-limited apart from real faults. They are still issues in this project. |
| `authoring-local` | A browser build served anywhere but the production host. Never sent while the gate is closed — it exists so that a gate patched open locally is self-labelling. |

The first two are no longer hardcoded literals; they are derived (from the hostname
and from a deploy-time var respectively), with the production strings unchanged.
Anything keying on them Sentry-side — alert rules, saved searches, dashboards —
keeps working.

**`SENTRY_SCOPE` / `VITE_SENTRY_SCOPE` — full vs. uncaught (contract §11, ADR
§E.3).** Sentry now sits beside the o11y stack described in "Observability"
above, not in front of it, and this switch controls how much overlap the two
keep. `full` (the default — both vars are absent from every committed config
today, and `resolveSentryScope`/the API worker's own fallback both treat
absent-or-anything-but-`"uncaught"` as `full`) sends every explicit diagnostic
report — `reportError`, the Tier-1/Tier-2 branches of `reportRuntimeError`, the
Worker's own handled-error lines — to **both** Sentry and the o11y facade, so
today's dashboards, saved searches and on-call habits keep working unchanged.
`uncaught` narrows Sentry to only what escapes a handler outright (browser
`window.onerror`/`unhandledrejection`/`Sentry.ErrorBoundary`; Worker
fetch-catch-all/DO alarms/cron/snapshot-job failures) plus the budget-alert
`captureMessage` — everything else goes to o11y alone. **Do not flip this
switch as part of T10 or any one-time setup step above** — see "Launch plan
(ADR-0041 §L, T11)" above for the exact three conditions and who flips it; it
needs no revert plan of its own either way, since it only ever
narrows Sentry, never widens it beyond what `reportingGate.ts`/`sentry-gate.ts`
already allow.

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
a host, and since DEV-2540 both need a second signal as well. The decisions live in
two small import-free modules, `apps/authoring/src/reportingGate.ts` and
`workers/api/src/sentry-gate.ts`, and are unit-tested in
`pipeline/sentry-gating.test.mjs`.

- browser: `window.location.hostname === "demos.handsontable.com"` **and**
  `navigator.webdriver !== true`. The second conjunct keeps an e2e suite pointed at
  production (`E2E_BASE_URL=https://demos.handsontable.com`, `e2e-live.yml`,
  `e2e-starter-matrix.yml`) from filing real issues; it used to. Nothing is lost —
  `e2e/starter-matrix.spec.ts` collects failures itself via `page.on("pageerror")`
  and never reads Sentry. It also silences demo-runtime relaying during those runs,
  deliberately: an e2e-driven page load is not real demo usage.
- Worker: `PREVIEW_HOST` matching the production host **and** `SENTRY_ENVIRONMENT`
  being set. `PREVIEW_HOST` alone failed open — the committed `wrangler.jsonc` vars
  carry the production value, so the config default *is* production and only the
  gitignored `workers/api/.dev.vars` (a manual setup step) turned it off. Skip that
  step and `wrangler dev` filed local experiments into the production project.
  `SENTRY_ENVIRONMENT` is passed only by `--var` from the `deploy` script, so no
  local run can produce it.

> ⚠️ **Deploy with `pnpm run deploy`, not a bare `wrangler deploy`.** The
> `--var SENTRY_ENVIRONMENT:api-production` flag lives in that script, and without
> it the deployed Worker comes up with error reporting silently off — nothing
> errors, events just stop arriving. That is the fail-closed direction working as
> intended, but it is invisible, so it is worth knowing. `master.yml`'s `deploy-api`
> job calls `pnpm run deploy`, so CI is fine. Verify a change to the flag with
> `pnpm exec wrangler deploy --dry-run --outdir /tmp/x --var SENTRY_ENVIRONMENT:api-production`
> and check the binding table; a flag-supplied var prints as `(hidden)`, which is a
> display convention, not a broken binding.

> `.dev.vars` is no longer the only thing standing between a local Worker and the
> production project, but keep creating it — it is still what points Tier-2 preview
> URLs at localhost.

### Verifying the wiring

There is deliberately **no force-enable escape hatch** in either gate: a bypass flag
would enlarge exactly the surface these gates exist to shrink. Fifteen localhost
events reached the production project in July, labelled `authoring-production` and
indistinguishable from real traffic, because the only way to exercise the wiring
off-host was to patch the gate open by hand.

To test the browser half off-host, point `VITE_SENTRY_DSN` in the gitignored
`apps/authoring/.env.local` at a **separate** Sentry project's DSN — never the
production one — and patch `enabled` locally if you must. The `environment` is
derived independently of `enabled` precisely so that such a run still labels itself
`authoring-local`.

One control has no code equivalent and is not in this repo: the Sentry project's
**inbound filter for localhost**, in project settings for `handsoncode/demos`. It is
the only thing that catches the failure mode above — a gate patched open by hand —
and it covers both SDKs at once. If it has been enabled, an off-host verification
against localhost will be dropped at ingest, and the test has to run against a
non-localhost host to prove anything.

**Preview-iframe errors are not reported by default.** The iframe runs arbitrary
authored and imported example code, so a compile error or a mid-keystroke typo is
product output, not an application fault. `reportRuntimeError` in
`apps/authoring/src/App.tsx` reports container-engine faults unconditionally —
`SessionStartError` (Tier-2 pool refusing a session; 410 excluded, that is normal
teardown) and `ContainerBootFailure` — and from the Sandpack engine only what the two
branches below describe.

**Tier-1 grouping and titles (DEV-2569).** Every rule for the Sandpack branch lives in
`apps/authoring/src/tier1Report.ts`, pinned by `pipeline/tier1-report.test.mjs`; `App.tsx`
extracts the facts and captures. Two branches, and the split is the fix for Sentry DEMOS-15,
which held both populations under one title:

- `context: tier1-compiler-asset`, fingerprint `["tier1-compiler-asset"]`, level `error`.
  Our own `@babel/standalone` chunk failing to load — the Tier-1 pre-transpile is ~3 MB and
  code-split, so first use is a network fetch. It is reported **ahead of the `monitorDemos`
  gate** (it is not demo monitoring, and it must outlive the DEV-2527 teardown below) and it
  deliberately carries **no** `surface: demo-runtime` tag, because `beforeSend` would re-home
  it into the `demo-runtime` environment where visitor noise is filtered past. The chunk URL
  travels as `extra.assetUrl`: it is hashed per build, so in the title it would name one
  deploy's sample and in the fingerprint it would open a new issue every deploy.
- `kind: sandpack-compile`, fingerprint `["demo-runtime","sandpack-compile"]` (unchanged),
  level `warning`. A bundler diagnostic for a module that never ran, i.e. the visitor's own
  source. Flat on purpose — default grouping shards it per typo — and *because* it is flat
  the code frame must not be in the message: an issue re-derives its title from the newest
  event, so a per-event message means the title names whichever typo arrived last. Both
  branches are therefore captured as a **synthetic error with a constant `name: message`**,
  with the real text in `extra.compileDiagnostic` / `extra.cause`.

The retry rule behind the first branch is in `packages/runtime/src/transpile.ts`, and it has
one non-obvious constraint. A rejected dynamic import used to be cached for the life of the
page (`babelPromise ??= import(…)`), so one failed fetch left Tier 1 unable to compile
anything until reload — but **evicting our own memo is not enough, because the browser caches
the failure too**. A failed module fetch is a null entry in the document's module map, and
re-importing the same specifier never touches the network again. Measured in Chromium 141:

```
attempt 1  ./chunk.js           -> TypeError       1 request
attempt 2  ./chunk.js           -> same TypeError  1 request  (no refetch)
attempt 3  ./chunk.js, now 200  -> same TypeError  1 request  (still no refetch)
attempt 4  ./chunk.js?retry=1   -> module          2 requests
```

So `createRetryingLoader` retries against a **different URL**: the failed chunk plus a
`hotRetry` query, built from the URL in the browser's own error text — the only place the
resolved chunk path exists at runtime, since the specifier is a hashed filename after the
build. An engine that names no URL (Safari says just "Load failed") is terminal on the first
failure, because there is nothing to bust. A second failure raises the terminal
`CompilerUnavailableError` and latches; later compiles get the same failure back with
`replay: true`, which `tier1Report` drops so one fault is not one event per keystroke. An
offline visitor (`navigator.onLine === false`) is dropped too — this branch has no flag gate
and no `beforeSend` re-home, so that is the one brake on it.

Only *Restart preview* lifts the latch (`rearmCompilerLoad`), and it mints a fresh query so
the click is a real request rather than a replay of a decided failure: a blip that has since
passed recovers without a reload and without losing unsaved edits, while a rotated-out chunk
fails again at once and leaves the reload as the only cure. Two requests per page, plus two
per click; nothing retries on its own.

`pushUpdate` in `sandpack.ts` swallows transpile rejections by design (half-typed code) but
re-surfaces this one, once — without that, a stranded tab froze silently on its last good
render, with no card and no report.

**Session-start diagnostics (DEV-2559) — temporary, remove with the DEMOS-9 fix.**
The `tier2-session-start` branch of `reportRuntimeError` carries three extra tags —
`framework`, `session_elapsed_bucket`, `cf_ray` — plus `extra.sessionElapsedMs`, all
of them beside the fingerprint and none of them in it. They exist to answer one
question on Sentry DEMOS-9 (is the 504 a fixed ceiling above our Worker, or container
starts that are honestly slow?) and should come out once it is answered, together
with the DEV-2527 teardown below. Three pieces, in this order: `SessionStartDiagnostics`
and the clock in `packages/runtime/src/container.ts` (the fourth `SessionStartError`
argument is optional, so the error's shape survives either way),
`apps/authoring/src/sessionDiagnostics.ts` with `pipeline/session-diagnostics.test.mjs`,
and the tag block in `App.tsx`. `cf_ray` is the reason for the deadline: it is
~one tag value per event, affordable only because this path fires a handful of times a
day, and it must not survive into a hotter one.

### Demo-runtime monitoring (DEV-2527) — temporary

A third `environment`, `demo-runtime`, carries what the preview itself hits:
uncaught errors, unhandled rejections, `console.error`, failed requests, Tier-1
Sandpack compile errors, and Tier-2 dev-server stderr raised after the preview came
up. It covers all traffic on `demos.handsontable.com`, anonymous visitors included.

`console.warn` is relayed too but **never becomes an issue** (DEV-2539).
`reportDemoEvent` files it as a Sentry *breadcrumb*, so the warnings that preceded a
failure arrive as context on the next real error instead of as issues of their own —
a message event at `warning` level is still an issue, and Handsontable's idempotent
`Theme "…" is already registered` notice, emitted by ordinary re-renders, was the
loudest of them. Breadcrumbs get their own ceiling at both ends
(`MONITOR_BREADCRUMB_CEILING`, 50), deliberately separate from the relay ceiling: a
breadcrumb files no issue so it can be looser, but a demo warning on every render must
not spend the twenty relay slots before the `console.error` explaining the breakage is
posted. Breadcrumbs live on the Sentry scope, which outlives one preview, so a warning
recorded under example A can appear beneath an error from example B — their `data`
carries tier, framework and demo id for exactly that reason. That scope is shared with
the authoring app's own trail, and the buffer evicts oldest-first, which is why
`Sentry.init` now states `maxBreadcrumbs: 200` instead of inheriting the SDK's default
of 100: at 100 a demo spending its whole allowance would erase half the clicks and
fetches you would need to explain an unrelated app failure. The two numbers move
together or not at all.

**One owner per class of failure** (DEV-2552), because two channels can see the same
Tier-1 fault. The in-preview relay owns anything the demo raised *while running* —
uncaught errors, rejections, and `console.error`. An Error passed to `console.error` is
relayed under kind `error` carrying that Error's own message and stack, not as a
`console-error`, so the reporter's dedupe (`kind|message|firstFrame`) collapses it with
the window `error` listener's copy of the same throw whichever arrives first. It is
re-homed rather than dropped because the twin is not guaranteed: a DOMException out of
React's commit phase never reaches the window listener, and Angular's default
`ErrorHandler` console.errors every error zone.js swallows. `reportRuntimeError` in
`App.tsx` owns the other class, a bundler diagnostic for a module that never evaluated
(`SandpackCompileError`); a `show-error` that carries `payload.frames` came from a
module that did evaluate (`SandpackEvaluationError`) and the shell stands down for it.
Before the split, one Tier-1 throw filed three Sentry issues.

The preview is cross-origin on both tiers, so nothing in it can reach this window's
handlers. `packages/runtime/src/monitor.ts` holds the bridge — one ES5 reporter,
injected in two places and `postMessage`d back to the app, where
`reportDemoEvent` files it. Tier 1 injects into the *derived* bundler file view
(`SandpackRuntime.withMonitor`), never the authored map, so a downloaded or forked
demo never contains it. Tier 2 injects at the `proxyToSandbox` seam in the Worker,
because Next and Nuxt have no `index.html` for a file-level injection to find.

**Turning it off** — both halves, each a one-line change plus a deploy:

- browser: `VITE_MONITOR_DEMOS` in `apps/authoring/.env.production`
- Worker: `MONITOR_DEMOS` in the `vars` block of `workers/api/wrangler.jsonc`

Anything other than `"1"` (including deleting the line) is off. Because off costs a
deploy, the immediate brake is elsewhere: `MONITOR_EVENT_CEILING` (20) events per
page load, deduped by kind plus message plus first stack frame, messages truncated
to 500 characters. Warnings are counted against a second, separate ceiling — see the
breadcrumb paragraph above — so 20 is the cap on issue-producing events, not on
everything the reporter sends.

That ceiling is enforced **twice, and the parent's copy is the one that counts**. The
reporter applies it in-page, but it runs beside code the demo's author wrote — and
for a shared or docs example that author is not the person viewing it. Such a demo
can ignore the reporter and `postMessage` crafted payloads straight at the app, so
`reportDemoEvent` keeps its own `createMonitorBudget` and validates every field,
`kind` against a closed set (it becomes a Sentry tag). Treat the in-page cap as
advisory and the relay's as the limit.

**A per-environment rate limit on `demo-runtime` in the Sentry UI is still the only
brake that works without a build** — keep one configured for as long as this is on.

Nothing identifying is relayed: no source snippets, no file map, and network events
carry scheme, host and path only, with the query string stripped. Same rule as
`analytics.ts`. One narrow exception, by construction: a `data:` or `blob:` URL has no
host to strip and its "path" *is* its payload, so a failed `<script src="data:…">`
relays up to `MONITOR_URL_MAX` characters of the demo's own bytes. Kept deliberately —
such a URL cannot be a third-party beacon, so the origin filter treats it as the demo's
own — but it is the one shape in which a snippet can reach an event.

**Network events the reporter produces are same-origin only** (DEV-2539) — a crafted
`postMessage` can still carry any url, which is why a relayed url reaches `extra` and
the issue title only, never a Sentry tag and never the fingerprint. The reporter's
`scrub` drops any request whose host is not the preview's own, so third-party beacons
and CDN fetches never leave the page: Tier 1 runs inside CodeSandbox's bundler
document, which beacons to its own telemetry host, and an ad blocker turns that into a
`fetch` rejection the unfiltered wrapper filed against the demo. The check belongs in
the reporter and nowhere else — `location.host` *is* the preview origin on both tiers,
and by the time a payload reaches the app that host has been redacted to `<preview>` by
design, so a parent-side origin check would be a check against a forgeable string. It
fails open when `location` is unreadable (blinding the monitor is worse than noise) and
treats a `data:`/`blob:` URL as the demo's own. Known cost, accepted: a docs example's
genuine failure against a third-party host is dropped along with the beacons — a data
API that 404s, and a broken CDN `<script>`/`<link>` too. If those are wanted back, the
narrow version is an allowlist of the hosts docs examples actually use, not a return to
reporting every host. For the events that survive, the URL is appended to the
issue title as well as `extra` — `resource failed to load` alone is unactionable — but
never to the fingerprint or the budget key, so a dozen broken assets stay one issue and
one relay slot. One issue with *one* URL, though, not twelve: the reporter's own dedupe
key is kind plus message plus first stack frame, and a resource load has no stack, so
every failed `<img>/<script>/<link>` on a page collapses to the constant
`network|resource failed to load|` and only the first is ever posted. The title names
the asset that failed first and gives no hint that others did. Widening the dedupe key
to include the URL was rejected on purpose: a dozen distinct keys would burn a dozen of
the twenty relay slots and crowd out the `console.error` that explains the breakage.

**The Tier-2 preview hostname is itself a session credential** and is redacted to
`<preview>` everywhere. `<port>-<sandboxId>-<token>.demos.handsontable.com` is what
authorises access to a live preview (a mismatch is the `INVALID_TOKEN` failure), and
it reaches strings three ways: a scrubbed network URL, *every frame* of a stack raised
in the preview, and any message quoting a URL. The reporter strips its own
`location.host` before sending and `redactPreviewHosts` catches it again parent-side.
Two traps if you touch this, both of which shipped once and were caught in review:

- **Match case-insensitively.** The token is mixed-case, but anything through a URL
  parser hands back a lowercased hostname, so a case-sensitive compare misses
  precisely the tokens it is meant to remove.
- **Redact before truncating.** A cap that splits a hostname leaves the token in the
  surviving prefix, where the redactor can no longer match it — the host it is looking
  for is incomplete. Angular and Next stacks run past the cap routinely.

The app's own `demos.handsontable.com` origin stays readable; only hosts with a
subdomain label are redacted.

**Removing it** means deleting `packages/runtime/src/monitor.ts`, its test
(`pipeline/monitor-inject.test.mjs`), and its callsites: `withMonitor` in
`sandpack.ts`, `onStderr`/`relayStderr` in `container.ts`, `injectMonitor` in the
Worker, and `monitorDemos` / `reportDemoEvent` in `sentry.ts` plus the relay listener
in `App.tsx`. The `beforeSend` narrowing in `sentry.ts` is **not** part of this
feature and must stay — it is a fix in its own right. Neither are the two
DEMOS-5F / DEMOS-9 suppression gates it also calls: they live in `eventGate.ts`,
are pinned by `pipeline/sentry-gating.test.mjs`, and are not part of the
monitor-removal path either. Neither is the
`tier1-compiler-asset` branch of `tier1Report` (DEV-2569): it sits ahead of the
`monitorDemos` gate precisely so that removing this feature does not take our own
compiler asset failing to load down with it.

Removal must also drop the `SandpackEvaluationError` early return in
`reportRuntimeError` (`App.tsx`), and with it the `SandpackEvaluationError` branch in
`sandpack.ts`. That guard stands down for evaluated Tier-1 throws *because the relay
reports them* — delete the relay and leave the guard, and that class of failure is
reported by nobody. It is the one place the shell depends on the relay existing.

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
target. All three are attached to `master.yml`'s `build` job's authoring build
step only; `ci.yml`'s own `authoring` job builds the same app again for PR e2e
and gets none of them, so PR builds neither emit source maps nor create a
release. With upload off, `build.sourcemap` is off too, so no `.map` files are
produced or published.

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
