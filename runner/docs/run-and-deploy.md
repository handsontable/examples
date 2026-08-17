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
> intended, but it is invisible, so it is worth knowing. `.github/workflows/deploy-runner-api.yml`
> calls `pnpm run deploy`, so CI is fine. Verify a change to the flag with
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
`apps/authoring/src/App.tsx` reports only container-engine faults —
`SessionStartError` (Tier-2 pool refusing a session; 410 excluded, that is normal
teardown) and `ContainerBootFailure` — and nothing from the Sandpack engine.

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
feature and must stay — it is a fix in its own right.

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
