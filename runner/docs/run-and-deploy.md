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

Three commands (`runner/scripts/dev.mjs --tier=1|2|full`, called by
`runner/package.json`'s `dev`/`dev:live`/`dev:full` scripts — one
orchestrator, not three separate scripts) cover every level:

```bash
pnpm dev        # Tier 1: rebuilds @handsontable/demo-runtime if its dist is
                # stale vs src, then runs the authoring app — http://localhost:5173
pnpm dev:live   # Tier 1 + Tier 2: + the API worker (wrangler dev, Docker
                # containers, local D1 migrations) — http://localhost:8787
pnpm dev:full   # + the o11y worker, docker compose (minio/clickhouse — the
                # box itself runs through wrangler dev's own container
                # orchestration, same as `pnpm o11y:dev`), telemetry wiring,
                # and a local Slack capture server
```

`node scripts/dev.mjs --help` prints the full option list. All three need
Docker running for anything past Tier 1 — `dev:live`/`dev:full` fail fast
with a clear message (not a hung/opaque container-build error) if
`docker info` doesn't succeed. Ctrl-C (also SIGTERM, or SIGHUP from closing
the terminal) tears down every spawned `wrangler`/`vite`/capture-server
process and (for `dev:full`) runs `docker compose ... down` for the
minio/clickhouse stack this run itself started. It does **not** guarantee no
orphaned Tier-2 Sandbox containers — see "What Ctrl-C actually cleans up"
below for why, and for what it prints instead.

**Container base-image pre-pull.** Before starting any worker, `dev:live`/
`dev:full` read every `FROM` base image the tier's Dockerfiles declare
(`containers/live/Dockerfile` + `containers/builder/Dockerfile` for the API
worker, plus `containers/o11y/Dockerfile` for `dev:full`'s o11y worker —
looked up from each worker's own `wrangler.jsonc` `containers[].image`, not
hardcoded), runs `docker image inspect` on each, and `docker pull`s (3
attempts, with backoff) any that's missing, printing `[images]` progress
lines. This is what `wrangler dev`'s own container build otherwise skips
silently: without it, a missing base image (e.g. a Docker Hub timeout
pulling `cloudflare/sandbox:0.12.3`) can leave `wrangler dev` running with a
broken container build, surfacing only later as an opaque Tier-2
session-start failure. If a pull still fails after every retry, `dev.mjs`
prints which image, the Docker error's last line, and the exact
`docker pull ...` command to retry by hand, then exits before starting any
worker. Pass `--skip-image-check` to skip this check entirely (e.g. offline,
with the images already built locally).

Every port is overridable by env var, defaulting to what's below; two
workers under `wrangler dev` always get their own, distinct `--port` and
`--inspector-port` so two dev sessions on the same machine never collide on
wrangler's inspector default (9229):

| Var | Default | Used by |
|---|---|---|
| `AUTHORING_DEV_PORT` | 5173 | the authoring app (`vite`) — every tier |
| `API_DEV_PORT` | 8787 | the API worker (`wrangler dev`) — tier 2, full |
| `API_DEV_INSPECTOR_PORT` | 9230 | the API worker's inspector — tier 2, full |
| `O11Y_DEV_PORT` | 4200 | the o11y worker (`wrangler dev`) — tier full, `o11y:dev` |
| `O11Y_DEV_INSPECTOR_PORT` | 4201 | the o11y worker's inspector — tier full, `o11y:dev` |
| `O11Y_MINIO_PORT` | 9000 | compose's MinIO (Loki S3 stand-in) — tier full |
| `O11Y_MINIO_CONSOLE_PORT` | 9001 | compose's MinIO console — tier full |
| `O11Y_CLICKHOUSE_PORT` | 8123 | compose's ClickHouse HTTP (Analytics Engine stand-in) — tier full |
| `O11Y_CLICKHOUSE_NATIVE_PORT` | 9009 | compose's ClickHouse native protocol — tier full |
| `O11Y_SLACK_CAPTURE_PORT` | 4210 | the local Slack capture server — tier full |

Plus `COMPOSE_PROJECT_NAME` (tier full's `docker compose` project; default is
derived PER WORKTREE — `o11y-dev-<hash of this worktree's absolute path>`,
via `scripts/dev-lib.mjs`'s `defaultComposeProjectName()` — so two worktrees
running `pnpm dev:full` never resolve to the same compose project, containers
or named volumes; set `COMPOSE_PROJECT_NAME` explicitly to still share one
on purpose) and `WRANGLER_REGISTRY_PATH` (forwarded as-is to every spawned
`wrangler dev`, for isolating one worktree's service-binding registry from
another's — several worktrees on this machine routinely run `wrangler dev`
at once, and without this, one worktree's API/o11y service binding can
resolve to another worktree's Worker instead of its own).

If you already ran `pnpm dev:full` before this per-worktree default existed,
your MinIO/ClickHouse named volumes were under the old shared `o11y-dev`
project; docker does not rename them — your next run starts this worktree's
new derived project on fresh, empty volumes instead, and the old
`o11y-dev_minio-data`/`o11y-dev_clickhouse-data` are left orphaned. If
`workers/o11y/.wrangler/state`'s ledger has committed keys from before (the
usual case), that first run also prints the "committed key(s) ... but this
project's MinIO volume doesn't exist" divergence warning — `--fresh`'s own
advice there is the right fix (wipes the o11y worker state so the ledger
agrees with the new, empty volumes again). To reclaim the old volumes'
disk space instead of leaving them orphaned, remove them explicitly by the
old project name: `docker compose -p o11y-dev -f containers/o11y/compose.yml
down -v`.

**`.dev.vars` bootstrap.** `workers/api/.dev.vars.example` and
`workers/o11y/.dev.vars.example` are committed, non-secret templates.
`dev.mjs`/`o11y-dev.mjs` copy either one to its gitignored `.dev.vars`
**only when `.dev.vars` doesn't already exist** — an existing file (your own
edits, real secret values) is never touched. On a *fresh* o11y bootstrap
only, a few known-inert local placeholders are filled in with real,
non-secret working values (matching `containers/o11y/compose.yml`'s own
documented local defaults): `DEV_ADMIN=dev@handsontable.com` (the local
session bypass, contract §10, `workers/o11y/src/gates/session.ts#verifySession`
— honoured only when `O11Y_ENV === "local"`, fail-closed everywhere else),
`AE_SQL_TOKEN=local-dev-token`, `LOKI_S3_ACCESS_KEY_ID`/
`LOKI_S3_SECRET_ACCESS_KEY=minioadmin` (MinIO's own default root
credential), and `SLACK_WEBHOOK_URL` pointed at the local capture server
(`http://localhost:4210/slack` by default).

`O11Y_EXPORT_SECRET` and `SENTRY_HOOK_SECRET` (fix round R4, F21) are filled
in separately, on **every** `dev.mjs --tier=full` run, not only a fresh
bootstrap: whichever of the two lines is still declared empty gets a fresh,
local-only random value (`ephemeralSecret()` — a 32-byte hex string, the same
kind of value `O11Y_SESSION_SECRET` already uses, never a pasted-in
production credential), written into `.dev.vars` and left alone on every
later run once filled. This is what makes `node scripts/o11y-replay-fixtures.mjs`
work locally without any manual setup: it reads both secrets from the
environment first, then falls back to reading them straight out of
`workers/o11y/.dev.vars`, so both the standalone command above and
`dev.mjs --tier=full --replay` succeed instead of 401ing on the OTLP/deploy/
Sentry fixtures. Only the two key NAMES are ever printed to `dev.mjs`'s own
log — never the generated value. A `.dev.vars` you already pasted a real
value into is never touched (only an empty declared line is filled).

**Why not just `--var`?** Wrangler's `.dev.vars` always wins over a
same-named `--var`, even when the `.dev.vars` line is empty (confirmed
against wrangler 4.108's `getVarsForDev`) — so for a key `.dev.vars.example`
already declares, `dev.mjs` bakes the working value into the bootstrapped
file instead of passing `--var` (which would be silently ignored). If a
`.dev.vars` value's port (`PREVIEW_HOST`, `SLACK_WEBHOOK_URL`) disagrees with
what this run actually resolved, and the corresponding port env var
(`API_DEV_PORT`, `O11Y_SLACK_CAPTURE_PORT`) was **not** explicitly set for
this run, `dev.mjs` **adopts** the `.dev.vars` port instead — `.dev.vars`
was always going to win for that key, so this makes the worker's own
`--port`, the vite proxy target, and the printed URLs agree with reality
instead of silently pointing at the wrong port. Only when the port env var
**was** explicitly set and disagrees does it warn instead, naming the file
to edit — an explicit choice is never silently overridden. For a genuinely
per-run secret (`O11Y_SESSION_SECRET`, the Grafana session-cookie signing
key — see the o11y auth runbook step for the deployed equivalent), the
bootstrap strips that line from a *freshly created* `.dev.vars` instead, so
the key stays undeclared and `dev.mjs`'s own ephemeral `--var` (a fresh
random value every run, never written to disk) is the only source.

**o11y worker local-mode config (contract §10).** `dev:full`/`o11y:dev` run
the o11y worker with `O11Y_ENV` set to `local` (bootstrapped in
`.dev.vars`), which is what turns on `DEV_ADMIN` (the local session bypass —
`workers/o11y/src/gates/session.ts#verifySession`) and every
`O11Y_LOCAL_*`-prefixed override below. `dev.mjs` injects the rest as
`--var` (never `.dev.vars` — none of these are declared there, so there's no
precedence conflict to work around): `RUNNER_EVENTS_CLICKHOUSE_URL` (points
the Analytics Engine stand-in sink at compose's ClickHouse —
`O11Y_CLICKHOUSE_PORT`), `O11Y_LOCAL_MINIO_PORT`/`O11Y_LOCAL_CLICKHOUSE_PORT`
(how the box's own container, reached via Docker's `host.docker.internal`,
finds compose's MinIO/ClickHouse), and `O11Y_LOCAL_PUBLIC_ORIGIN` — the
origin `gates/session.ts#publicOrigin` builds the broker login's
`return_to` against and binds every locally-minted session token's `aud`
claim to; `dev.mjs` always sets it to `http://localhost:<O11Y_DEV_PORT>`
(Grafana is served from the o11y worker's own origin, not proxied through
the authoring app), which matters once you override `O11Y_DEV_PORT` away
from its default — `publicOrigin`'s own built-in fallback assumes the
default port.

**Migrations.** `dev.mjs` applies every `workers/api/migrations/NNNN_*.sql`
file (currently `0001` through `0008`) one `wrangler d1 execute --local
--file=` call at a time — never `wrangler d1 migrations apply --local`,
because local bookkeeping starts empty and `0003_cost_ledger.sql` ends in a
bare `ALTER TABLE demos ADD COLUMN artifacts_purged_at` with no
`IF NOT EXISTS`, which fails the second time an apply re-runs it. Unlike the
old by-hand recipe, this is now **idempotent**: `dev.mjs` records each
applied file in `workers/api/.wrangler/state/dev-migrations-applied.json`
(gitignored, next to the local D1 state itself — wiping one wipes the
other) and only applies files not yet in that record, so a second run of
`pnpm dev:live`/`dev:full` applies nothing. (Remote is a different story: CI
has applied migrations through the framework since before `0003` landed, so
its bookkeeping is populated and `master.yml`'s `deploy-api` job applies new
files automatically.)

**Adopting a local D1 with no record.** A local D1 migrated before this
record existed (or by hand, matching the exact bug this fixed) has none of
this bookkeeping, so every file looks "pending" — re-running an already
non-idempotent `ALTER TABLE ... ADD COLUMN` (0003, 0007) would otherwise die
with a raw `duplicate column name` failure. Before running each pending
file, `dev.mjs` takes a schema snapshot of the local D1 (table/index names
from `sqlite_master`, columns from `PRAGMA table_info`) and, if every target
the file declares (its `CREATE TABLE`/`CREATE INDEX`/`ALTER TABLE ... ADD
COLUMN` statements) already exists, **adopts** it — records it as applied
without running it, with a clear log line — instead of re-running it. A file
whose effect can't be probed generically this way (any other statement
shape) is never adopted; it always runs, relying on its own idempotency
(`IF NOT EXISTS`/`IF EXISTS`). Any migration failure — a real SQL error, or a
probe-query failure — prints ONE clean line (the file, the SQLite message,
and how to recover: the record path, or `node scripts/dev.mjs --tier=<N>
--reset-local-db` to wipe local D1 state and the record and start fresh) and
exits non-zero with nothing left running, never a raw stack trace.
`--reset-local-db` deletes `workers/api/.wrangler/state/v3/d1` and the
applied-migrations record; passing the flag is itself the confirmation (no
interactive prompt), and it prints exactly what it deleted.

**Fixture replay (`dev:full`).** Once the o11y worker reports ready,
`dev.mjs` prints the replay command
(`node scripts/o11y-replay-fixtures.mjs --base http://localhost:<O11Y_DEV_PORT>`).
Pass `--replay` to run it automatically instead of just printing it.

**Local Slack alerts.** `dev:full` starts
`node scripts/o11y-slack-capture.mjs --port <O11Y_SLACK_CAPTURE_PORT>` — a
tiny local HTTP server (no real Slack workspace involved) that prints and
keeps the last 50 alert posts (`GET http://localhost:4210/_captured`). The
o11y worker's local `SLACK_WEBHOOK_URL` points at it (see the bootstrap
section above), so a fired alert (ADR-0041 §F.3 — trigger the `*/10` cron by
hand with `curl "http://localhost:<O11Y_DEV_PORT>/cdn-cgi/local/scheduled?cron=*/10+*+*+*+*"`,
or replay the fixtures, which trips the new-fingerprint rule on first run)
shows up locally instead of needing a real Slack webhook.

**Crons never fire on their own under `wrangler dev`** — neither worker's,
and this is by design, not a bug (both print "Scheduled Workers are not
automatically triggered during local development" on startup when they have
any). Trigger a specific one by hand with the pattern above for the o11y
worker (its `*/10 * * * *` backlog/alert tick), or, for the API worker's two
triggers (`workers/api/wrangler.jsonc`'s `triggers.crons`):
`curl "http://localhost:<API_DEV_PORT>/cdn-cgi/handler/scheduled?cron=17+4+*+*+*"`
for the nightly job (reconciliation, spend alerts, GC, analytics prune), and
`curl "http://localhost:<API_DEV_PORT>/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"`
for the `*/5` pool/budget-gauge tick. The two workers' local trigger paths
differ (`/cdn-cgi/local/scheduled` vs `/cdn-cgi/handler/scheduled`) because
they pin different wrangler versions (o11y 4.136.3, API 4.108.0) whose
Miniflare internals name this differently; wrangler itself prints the
correct path and port for whichever worker you're running, so treat that
printed line as the source of truth if it ever disagrees with this doc.
(`wrangler dev --test-scheduled` + `/__scheduled` still exists as an older,
separate opt-in path, but needs the flag and does not let you pick which of
several triggers fires, so the `curl` forms above are simpler.)

**Browsing logs.** Sign into Grafana (`http://localhost:<O11Y_DEV_PORT>/grafana/` —
`DEV_ADMIN` logs you in automatically in local mode) and open the **Logs**
dashboard for API-worker lines, authoring/embed/demo-runtime browser errors,
and a free-text/`cf.ray`/`session.id`/demo-id search across every service in
one place — it's linked from the Runner overview and Observability self
dashboards too. `/admin`'s header also has an **Open Grafana** link
(otherwise nothing in the app points at it): `href={GRAFANA_URL}` in
`Admin.tsx`, which reads `import.meta.env.VITE_GRAFANA_URL` and falls back to
`/grafana/`. On the deployed zone that fallback is what actually runs (no env
override needed) because the authoring app and the o11y worker share one
origin. Locally they don't — `apps/authoring/vite.config.ts`'s dev proxy has
no `/grafana` entry (only `/api`, `/d`, `/embed`, `/telemetry`), and a proxy
wouldn't be the right fix anyway: Grafana's own `GF_SERVER_ROOT_URL` is the
o11y worker's origin, so its login redirect would bounce off a proxied
origin. `pnpm dev:full` (`scripts/dev-lib.mjs`'s `--tier=full` plan) instead
sets `VITE_GRAFANA_URL=http://localhost:<O11Y_DEV_PORT>/grafana/` as process
env for the app's dev server, so the same link on `:<AUTHORING_PORT>/admin`
opens Grafana directly there too, with the `DEV_ADMIN` local login bypass
landing correctly. Every signed-in user is a Grafana Viewer, but Viewers now also get
**Explore** (`/grafana/explore`): pick the `Loki (browser)` or
`Loki (worker)` datasource and run a LogQL query directly against either
tenant, without needing a dashboard panel for it. Neither capability lets a
Viewer save a change back to a provisioned dashboard or datasource — those
stay read-only, and Grafana's state is disposable anyway (a fresh DB on
every wake).

**Logs are only as fresh as the last wake.** The box drains its packed
objects into Loki once, right after it wakes, and nothing re-arms that
drain while it stays awake (ADR-0041 §B.3's out-of-order window assumes the
drain replays into an empty ingester, which only holds true at wake start).
So any ingest that arrives *while* the box is already up sits undrained and
invisible in Grafana/Explore until the *next* wake. There is no staleness
indicator on the dashboards for this; treat Logs/Explore as "as of the last
wake started", not live — a design change may follow.

**Bot traffic is filtered locally too.** The o11y worker's bot gate drops
any request whose user agent matches `HeadlessChrome` — including local
requests, by design. This repo's own Playwright config already avoids it
(`playwright.config.ts` uses `devices["Desktop Chrome"]`, which does not
send a `HeadlessChrome` UA even when headless — confirmed live), so it's
only a risk for a bare `chromium.launch()` with no device preset. That kind
of scripted local traffic is silently dropped before it reaches Analytics
Engine/Loki, with no client-side signal that it happened; use a
`devices[...]` preset (confirmed live: `devices["Desktop Chrome"]` does not
send `HeadlessChrome` even headless) or an explicit non-`HeadlessChrome` UA
override if you need it to actually show up in local dashboards —
`channel: "chrome"` alone does **not** fix it: confirmed live, a headless
`chromium.launch({ channel: "chrome" })` still sends `HeadlessChrome/...`.

**Local o11y data persists across a restart.** `containers/o11y/compose.yml`
gives MinIO and ClickHouse named volumes (Grafana itself stays ephemeral by
design), and `workers/o11y/.wrangler/state` (the InboxWriter ledger, dedupe
hashes, local R2 inbox objects) was already kept across a restart before
this. So a plain Ctrl-C + `pnpm dev:full` again keeps your local
logs/metrics AND the ledger that tracks them, together — `dev.mjs` prints
one line at startup either way: `o11y local data: kept (MinIO/ClickHouse
volumes + o11y worker state)`, or `o11y local data: fresh` when you passed
`--fresh`.

**`--fresh`** wipes all of that local o11y state together in one shot:
`docker compose ... down -v` for this project's minio/clickhouse volumes,
AND `workers/o11y/.wrangler/state`. It prints exactly what it removed.
Wiping only one half (e.g. `docker volume rm` by hand) is what causes the
stack to look "broken" after a restart: a `done:` (committed) ledger key
whose MinIO data is gone is never re-drained on its own, and a fixture
replay's dedupe hashes can then block the same data from ever refilling the
now-empty store. In practice, only that second half — the dedupe-hash
hazard — applies to a wake that pushed data: see "Local clean markers never
commit" below for why a pushed key can't reach `done:` locally at all, so
neither the "committed key whose MinIO data is gone" case nor `dev.mjs`'s
own divergence warning (below) ever fires for one. If `dev.mjs` finds that
mismatch (the MinIO volume is gone but the ledger still has committed keys —
in practice, only a wake that drained nothing) it prints a warning
recommending `--fresh` — or, if you'd rather keep what R2 still has
(7-day retention), `POST /grafana/_o11y/reopen` once the worker is up.
`--fresh` never touches `workers/api`'s local D1 — that's `--reset-local-db`, a
different flag for a different store. `pnpm o11y:dev` also accepts
`--fresh`, for just its own half (workers/o11y's worker state) — it never
runs `docker compose` itself, so it can't wipe the compose volumes; see that
command's own startup log for the divergence risk if you're also running
`dev:full`'s compose stack.

**Local clean markers never commit.** A wake resolves clean or unclean, and
it's the keys it **drained** (packing is `InboxWriter`'s job, not the
wake's) that become `done:` on a clean resolution — or get reopened and
replayed on the next wake otherwise. In production, the box writes each
wake's `state/wakes/<wakeId>/clean` marker and the worker checks for it
through the same R2 bucket (`handsontable-demos-o11y-loki`), so a clean stop
resolves those drained keys `done:` and they are never replayed again.
Locally those are two *different* stores: the container writes the marker
straight to MinIO over S3, but the o11y worker checks for it through its
`O11Y_LOKI_STATE` R2 binding, which under `wrangler dev` is Miniflare's own
separate local R2 — not MinIO. The worker never finds the marker, so a local
wake that drained any data always resolves `unclean` and reopens every key
it drained, which then replays again on the next wake, indefinitely (within
Loki's 7-day retention) — not only after a crash. This is a local-dev-only
gap with no bridge today; treat `o11y.wake outcome=unclean` as expected
locally rather than a sign something broke, and don't rely on local
`done:`/clean-shutdown testing as evidence for the production path.

**What Ctrl-C actually cleans up.** Every `wrangler dev`/`vite`/capture-server
child is spawned in its own process group and signalled as a group on
Ctrl-C (SIGINT — also SIGTERM and SIGHUP), with an 8s grace period before
escalating to SIGKILL, and `dev:full` also runs `docker compose ... down`
(never `-v` — see above) for the minio/clickhouse stack it started, keeping
its named volumes for next time.

What it does **not** do: stop a Tier-2 Sandbox/GrafanaBox container on your
behalf. Measured for this task: Ctrl-C does not make wrangler's own
Sandbox-container orchestration tear itself down synchronously — a
session's `workerd-handsontable-demos-api-Sandbox-*`(-proxy) container can
still be `Up` several seconds after `dev.mjs` has already exited. An
earlier version of this script tried to sweep those up itself (stop any
container that was "new since this run started" and name-matched
`handsontable-demos-(api|o11y)`), but that signal cannot tell this run's own
container apart from one a DIFFERENT worktree's concurrent `wrangler dev`
session started — several worktrees running `wrangler dev` on this same
machine at once is the normal case here (see `WRANGLER_REGISTRY_PATH`
above), not a rare race, and the sweep's window was this run's entire
session, not a narrow few seconds. Stopping the wrong worktree's container
silently kills its session. So `dev.mjs` now only **reports** containers
that look like they might be leftovers — it prints their names, a
`docker ps` filter, and the exact manual `docker stop` command — and never
runs `docker stop`/`docker rm` on anything itself. If you see that report,
confirm what a container actually is (e.g. `docker inspect` its ports)
before stopping it by hand.

**Standalone o11y worker.** `pnpm o11y:dev` (unchanged as its own command)
starts just the o11y worker under `wrangler dev`, sharing the same
`.dev.vars` bootstrap/port-resolution code as `dev.mjs` — for working a pure
o11y bug without the API worker, Docker compose, or the Slack capture
server. It does **not** also start `containers/o11y/compose.yml` —
`wrangler dev` manages its own container instance via the same Dockerfile,
and running both would fight over the same image/ports for no benefit.

**Debugging one piece in isolation.** The three commands above cover normal
development; to run a single worker by hand (e.g. with a debugger attached
outside the orchestrator), the underlying commands are still just
`wrangler dev` from that worker's own directory and `vite` from
`apps/authoring` — `dev.mjs --help` prints every flag and env var this
script itself understands if you want to replicate its exact invocation.

`.dev.vars` and `.env.local` are gitignored dev-only bypasses — never used in
prod. `PREVIEW_HOST="localhost:8787"` (the API worker's bootstrapped
default) overrides the `wrangler.jsonc` default (`demos.handsontable.com`, a
real public wildcard that routes to the *deployed* worker) so container
preview URLs come out as `*.localhost:8787`, which browsers treat as
`127.0.0.1` (RFC 6761) and reach your local `wrangler dev`. It must be a real
host value — wrangler silently ignores empty-string `.dev.vars` overrides.
Without it, Tier-2/container sessions boot fine but the preview iframe fails
with `INVALID_TOKEN` — the token is only known to your local session, not to
prod. `VITE_DEV_USER`/`VITE_API_BASE` for the authoring app are injected as
process env by `dev.mjs`, never written to an `.env.local` file — nothing
committed to disk can leak the dev-login bypass into a later "real" build.

This only works because `wrangler.jsonc` declares **no `routes`**: when
routes are present, `wrangler dev` simulates the first route's host on every
request, destroying the preview subdomain before `proxyToSandbox()` can
route on it. That's why the production routes live in the `deploy` script
instead — don't move them back into `wrangler.jsonc`.

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

Crons never fire on their own under `wrangler dev` — see "Crons never fire
on their own under `wrangler dev`" in the local-dev section above for the
exact `curl` commands, including the one that runs this nightly job
on demand.

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
  so they fit the deterministic PR suite.
- **`e2e-o11y-local.yml`** (R1-followups): `e2e/telemetry-metrics.spec.ts`
  (`E2E_LIVE=1` + `E2E_TELEMETRY=1`) and `e2e/o11y-local.spec.ts`
  (`E2E_O11Y_LOCAL=1`) both need infrastructure the per-PR `ci.yml` suite
  should not own on every PR — a real local API worker with a live Tier-2
  container (Docker) for the first, that plus a real o11y worker, local
  ClickHouse/MinIO (Docker compose) and applied D1 migrations for the second.
  Rather than leaving them unhomed (`docs/TESTING.md`'s "every gate needs a
  workflow home" rule), they get their own workflow, run directly on
  `ubuntu-latest` (not the shared Playwright container image — Docker-in-Docker
  can't reach a sibling container's `localhost`, and `wrangler dev` needs a
  real Docker daemon to build the Tier-2 container image, which the bare
  runner already ships, same as `master.yml`'s `deploy-api` job relies on):
  `workflow_dispatch`, nightly (02:30 UTC), and on any PR touching
  `workers/o11y/**`, `containers/o11y/**`, `apps/authoring/src/telemetry/**`,
  or either spec file. Each job's own guard step (`scripts/ci/
  assert-e2e-ran.mjs`) fails if the gate ran zero tests or skipped any — a
  mistyped env var must not read as a green, empty run. Run both specs
  locally, by hand, before any change that touches the ingest path and before
  every launch too — `e2e/o11y-local.spec.ts`'s own file header has the exact
  setup commands.

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

### 5. `O11Y_SESSION_SECRET` for `/grafana/*`

**No Cloudflare Access application is needed.** K1 (the controller decision
from the broker/Grafana feasibility investigation)
replaced the Access gate with the Handsontable login broker (ADR-0007) — the
same broker `/admin` and every other internal surface already sign in
through. A callback page under `/grafana/_o11y/` reads the broker's
fragment token once, and the o11y worker mints its own signed session
cookie from it (`workers/o11y/src/gates/session.ts`, `grafana/login.ts`).
There is nothing to create in the Zero Trust dashboard.

`/admin`'s header has an **Open Grafana** link, opened in a new tab, that
goes through this same broker login — straight to `/grafana/` on the
deployed zone, and to the o11y worker's own local origin under `pnpm
dev:full` (see "Browsing logs" above for the `VITE_GRAFANA_URL` wiring that
makes the local case work too).

Set nothing in Cloudflare beyond this one secret:

```bash
cd workers/o11y
npx wrangler secret put O11Y_SESSION_SECRET   # generate with `openssl rand -hex 32`, never print it
```

`LOGIN_BROKER_URL` needs no dashboard step either — it is a public var,
already the real broker URL in `wrangler.jsonc`'s `vars` block
(`https://mcp-auth-proxy-j0tb.onrender.com`, the same value
`workers/api/wrangler.jsonc` uses). Before K1 landed, the task's dispatcher ran the real
production probe by hand —
`curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' 'https://mcp-auth-proxy-j0tb.onrender.com/broker/login?return_to=https%3A%2F%2Fdemos.handsontable.com%2Fgrafana%2F_o11y%2Fcallback%3Fn%3Dx'`
— and confirmed a `302` to Google (2026-09-24), so the callback host is allowed today;
the K1 implementer separately re-verified the same round trip end-to-end against a
*stubbed* local broker only ("Real local run", K1's own fix-round notes), which
proves the Worker's own code, not the real broker's live
configuration. If the production behaviour ever changes, re-run the curl command above
before assuming it still holds, and ask the broker's owners (`handsontable/hot-mcp`) to
add `demos.handsontable.com` back to `BROKER_ALLOWED_RETURN_HOSTS` if it does not.

**The broker-wide risk this gate inherits, not fixes (DEV-3088).** The broker's
`return_to` allowlist is host-suffix-only, so it also admits anonymous Tier-2 preview
hosts (`*.demos.handsontable.com`) — anyone can harvest another team member's 1h broker
token by sending them a crafted login link. Before K1, a stolen token could not reach
Grafana at all (`ACCESS_AUD` was `""`, so Access refused everything). **K1 widens
DEV-3088's blast radius**: a stolen token can now be exchanged for a Grafana session.
Fix round (security review finding I3) narrows that widening — the session is capped at
`min(now + 12h, brokerTokenExp)` instead of a flat 12h, so the exposure a stolen token
buys is close to the token's own 1h lifetime, not 11 hours longer — but does not close
it: DEV-3088 itself remains open and is tracked separately, not by this gate.

### 6. Every o11y worker secret (contract §2)

```bash
cd workers/o11y
npx wrangler secret put O11Y_EXPORT_SECRET          # step 4 above
npx wrangler secret put SENTRY_HOOK_SECRET           # step 8 below
npx wrangler secret put AE_SQL_TOKEN                 # step below
npx wrangler secret put LOKI_S3_ACCESS_KEY_ID        # step 3 above
npx wrangler secret put LOKI_S3_SECRET_ACCESS_KEY    # step 3 above
npx wrangler secret put SLACK_WEBHOOK_URL            # step 7 below
npx wrangler secret put O11Y_SESSION_SECRET          # step 5 above
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
API worker's `O11Y` binding (entrypoint `O11yHeartbeat`) are **mutual** —
each names the other's Worker's named RPC entrypoint. Deploy the o11y worker
**first**: its own binding resolves lazily (a Workers service binding is not
validated against the target actually existing at *deploy* time), but
`O11yUsage.recordAwakeSeconds`/`o11ySpend` calls from `GrafanaBox` will fail
until the API worker is deployed too, and the API worker's own
`env.O11Y.heartbeat()` RPC calls (the watchdog heartbeat) fail the same way
in the other direction until the o11y worker exists. Deploying o11y first
means there is only ever one direction of "the other side isn't up yet" instead of
two. `master.yml` encodes this ordering automatically — `deploy-api` needs
`deploy-o11y` and proceeds once it is `success` or was skipped (unrelated
push) — so from the first merge onward this is handled without a manual step.
The same order applies to a throwaway sandbox probe of either worker: stand
up the probe o11y worker (or a stub) before the probe API worker if the
probe exercises the mutual binding at all.

## Launch plan (ADR-0041 §L, T11)

The order above ("First deploy, in order") is the mechanical dependency; this
section is the gate around it — what must be true before deploying at all,
what to check right after, and the two decisions ("flip the Sentry scope",
"roll back") that come later, not at deploy time.

### Pre-conditions — confirm every one before the first real deploy

These are carried from the tasks that found them, not newly discovered here:

- **`O11Y_SESSION_SECRET` must be set (at least 32 bytes, `openssl rand -hex 32`) before
  the first real deploy** (K1, "One-time setup" step 5 above). Until it is,
  `verifySession`/`verifyLoginCookie` both fail closed on every `/grafana/*` request
  (a navigation redirects to `/grafana/_o11y/login`, everything else gets 401) — but that
  login page itself answers a plain `500` rather than completing (`grafana/login.ts`'s own
  pre-flight check), so Grafana is simply unreachable, not silently degraded. There is no
  Access application to create; Cloudflare Access was removed from this gate entirely
  (K1).
- **The Grafana session is capped at the broker token's own lifetime, not a flat 12h**
  (K1 fix round, security review finding I3): before this fix, a stolen 1h broker token
  (DEV-3088, the broker-wide `return_to` suffix-allowlist risk) could have been turned
  into an unrevocable 12h Grafana session — 11 extra hours of exposure per stolen token,
  on top of DEV-3088's existing blast radius. `gates/session.ts#computeSessionTtlSeconds`
  now caps every session at `min(now + 12h, brokerTokenExp)`, falling back to 1h when the
  token carries no readable `exp` — this narrows, but does not eliminate, what K1 adds to
  DEV-3088's blast radius, which is still open and tracked separately.
- **T09-D5's "no per-panel ClickHouse `database` field" decision has not been checked
  against the real Analytics Engine SQL API** — only local ClickHouse and AE's documented
  SQL surface were checked. If a query returns "unknown table" in production Grafana where
  it worked locally, this is the first thing to check (T09's own Outcome flags it too).
- **The `aws s3 cp` step for the R2 source-map upload (`master.yml`'s `build` job) has never
  run against a real R2 credential** (T10's own Outcome) — only simulated with `wrangler`
  replaced by `echo`. Watch the first real `build` job's logs for this step specifically.
- **The deploy-event steps' `Current Version ID:` grep has never run against a real
  (non-dry-run) deploy** (T10) — an empty capture degrades to an empty `cf_version_id`
  rather than failing the job. B-I1 (focused review fix round) added a mitigation, not a
  fix of the underlying grep: `master.yml` now emits `::warning::` when the parse comes
  back empty, and the o11y worker's ingest path (`normalise/deploy.ts`) marks the record
  with `cf_version_id_missing: true` in its body (never rejecting it — the deploy already
  shipped) plus a `console.warn`, so the gap is visible in the Actions run and queryable in
  Loki even if nobody is watching CI logs in real time. Spot-check the first real deploy's
  `/telemetry/deploy` payload (visible as a Runner-overview annotation, or in `o11y worker
  log stream`) for a real, non-empty `cf_version_id` regardless.
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
   the dashboard covers, matching or beating the sandbox-measured figures (ADR-0041 §L,
   criteria 7–8: $0.21/month at 1× traffic, $0.33/month at 10×, both far under the $10
   ceiling). **Fix round D-I6:** the exported-logs allotment specifically is NOT on that
   dashboard (see the post-deploy smoke's item 6 above for why) — read it from
   Cloudflare's own Workers → Observability → Usage view instead, same place, same
   number, this time "at least a few days" rather than "one day." If real Tier-2 stdout
   volume turns out to exceed the measured exported-logs allotment (ADR-0041 §L
   criterion 8, the one criterion that stayed Mixed rather than passing), do not flip
   the scope until the fallback (lowering `head_sampling_rate`, ADR §D's own named
   escape hatch) has brought it back under half.
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
name fixed here; confirm with the user before the first flip. D-M12 fix round: the
mechanism is not a `--var` flag pair — both names are already committed config, edited in
place and redeployed/rebuilt: `SENTRY_SCOPE` is the `"full"` var in
`workers/api/wrangler.jsonc`, flipped to `"uncaught"` and deployed with the API worker;
`VITE_SENTRY_SCOPE` is the `full` build-env value in `.github/workflows/master.yml`'s
authoring build step, flipped to `uncaught` and shipped on the next authoring deploy. Both
currently read `full`/`"full"` in those two committed files.

### Rollback

- **Drop the export destinations** (Workers Logs → o11y ingest) if the o11y stack itself is
  the problem — this stops new data from reaching Loki/the inbox without touching the app.
- **Revert the `observability` block** (`workers/api/wrangler.jsonc`'s
  `observability.logs`/`.traces`) to pre-o11y values if the volume itself is the problem —
  this is a config-only revert, no code change.
- **The `SENTRY_SCOPE`/`VITE_SENTRY_SCOPE` flip needs no revert plan of its own** (ADR
  Consequences, and the "Error monitoring" section below repeats this) — it only ever
  narrows what reaches Sentry, never widens it past what the production gates already allow,
  so reverting it just means editing the same two committed values (`workers/api/wrangler.jsonc`'s
  `SENTRY_SCOPE`, `master.yml`'s `VITE_SENTRY_SCOPE` build env) back to `full` and redeploying.
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
keep. `full` (the default — both vars are set to `full` in every committed config
today: `SENTRY_SCOPE` in `workers/api/wrangler.jsonc`, `VITE_SENTRY_SCOPE` in
`.github/workflows/master.yml`'s authoring build env; `resolveSentryScope`/the API
worker's own fallback also treat an absent var as `full`, for a build/deploy that
predates either being set) sends every explicit diagnostic
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
