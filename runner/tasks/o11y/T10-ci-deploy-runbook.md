# T10 — CI, deploy wiring and runbook

| | |
|---|---|
| Status | done |
| Size | M |
| Depends on | T01, T02, T03 (names and implementations settled); drafting can start after T02 |
| Blocks | T11 |
| ADR | 0041 rev. 3 §A (`workers_dev`), §B.1 (routes, ADR-0038 amendment), §B.4 (lifecycle), §C.2 (deploy events), §C.3 (maps), §E.3, §H; contract §2, §10, §11 |
| Owns | `.github/workflows/master.yml`, `.github/workflows/ci.yml`, the source-map section of `apps/authoring/vite.config.ts`, `workers/o11y/package.json` deploy script, `docs/run-and-deploy.md` (new "Observability" section; "Error monitoring" rewritten), `docs/cloudflare-resources.md`, `pipeline/o11y-runbook-drift.test.mjs` |

## Goal

Merging the feature branch deploys everything in the right order with nothing done by
hand except the one-time setup, and that setup is written down with exact commands.
**No real deploy happens in this task.**

## Read first

- `.github/workflows/master.yml` (the `changes`, `build`, `deploy-authoring`,
  `deploy-api` jobs; the `SENTRY_*` env on the authoring build) and `ci.yml`.
- `apps/authoring/vite.config.ts:19-68` (maps built only for the Sentry upload, then
  deleted).
- `docs/run-and-deploy.md` §"Error monitoring (Sentry)".
- Contract §1, §2 — every name the runbook must create.

## Scope

In:

- **master.yml**: a path-gated `deploy-o11y` job (image build, `wrangler deploy` through
  `pnpm run deploy` so the `--routes` flags apply); source maps built on every production
  build with the Sentry plugin's in-build deletion turned off, then one step uploads them
  to Sentry and to R2 `sourcemaps/<sha>/<original asset path>.map` and deletes them from
  `dist` before deploy;
  `--var SERVICE_VERSION:$GITHUB_SHA` reaching the API and o11y deploys; one deploy event
  per deploy job to `/telemetry/deploy` with a GitHub OIDC token (`id-token: write`).
- **ci.yml**: o11y worker typecheck and tests in the existing DAG; confirm the presence
  gate already covers `workers/o11y/**`.
- **Scopes and leak check**: production deploys set `SENTRY_SCOPE` and `VITE_SENTRY_SCOPE`
  to `full` (contract §11); the post-build check in `master.yml` and in the AGENTS.md
  leak grep also fails when the local telemetry path (contract §10) survives into the
  production bundle.
- **Runbook** in `docs/run-and-deploy.md`, exact commands, one-time and in order:
  - the three EU R2 buckets with lifecycle rules: inbox objects 7 days, maps 30 days, Loki
    `browser/` chunks 30 days, `worker/` chunks 90 days, index 90 days (T01's rule file);
  - an R2 S3 token scoped to the Loki bucket only (the box writes Loki data and the
    `state/` clean markers there), and the `O11Y_LOKI_STATE` read binding;
  - the one export destination (`o11y-logs`) with the secret header; no trace destination;
  - the Access application for `/grafana/*` with the `@handsontable.com` policy, and its AUD;
  - every Worker secret from contract §2;
  - the rate-limiting binding from T02, and the ADR-0038 WAF exception extended to
    `/telemetry/*`;
  - the Slack webhook;
  - the Sentry internal integration with the issue-alert webhook;
  - the GitHub OIDC trust;
  - first-deploy order for the mutual service bindings: o11y worker first (it binds the
    existing API worker), then the API worker with `O11Y`; the same order for the sandbox
    probes.
- `docs/cloudflare-resources.md`: the new Worker, DOs, buckets, dataset.
- `pipeline/o11y-runbook-drift.test.mjs`: every secret and var declared in
  `workers/o11y/src/env.ts` appears in the runbook; a renamed binding fails the test.

Out: running any of it against the production account (T11 plans the launch).

## Acceptance criteria

- `npx wrangler deploy --dry-run` succeeds for the o11y, API and authoring Workers.
- `actionlint` (or the repo's workflow lint, if any) passes on both workflows.
- A production-mode authoring build writes maps, the upload step targets
  `sourcemaps/<sha>/`, and `dist` contains no `.map` afterwards.
- `deploy-api` still calls `pnpm run deploy`; the `changes` job gates `deploy-o11y` on
  `runner/workers/o11y/**`, `runner/containers/o11y/**` and the telemetry module.
- The drift test fails when a secret is missing from the runbook.

## Traps

- The `--var SENTRY_ENVIRONMENT` flag only exists in the API worker's `deploy` script; a
  bare `wrangler deploy` ships reporting switched off.
- Build production with `.env.local` absent; the AGENTS.md grep catches a leaked dev bypass.
- Workers Assets serves only the current deploy, which is why maps go to R2 per SHA and
  never rely on the origin.

## Outcome

Full narrative, every command/output and the actionlint transcript are in
`.superpowers/sdd/README/T10-report.md` (outside this directory, per
COMMON.md — this section is the condensed record).

**`master.yml`**: `changes` gained an `o11y` output
(`runner/workers/o11y/**`, `runner/containers/o11y/**`, `runner/packages/**`
— the whole directory, not just `packages/runtime/src/telemetry/`, since
e.g. `scrub.ts` imports `redactPreviewHosts` from `monitor.ts` outside that
subpath — plus the lockfile and both workflow files); `build` now also runs
when `o11y` changed and gained four new steps on the authoring build path
(source-map upload to R2 + deletion, the AGENTS.md dev-bypass leak grep now
automated, `pnpm check:telemetry-leak`), all self-no-op when `SENTRY_*`
secrets are absent (a PR build, or a push where only api/o11y changed) since
no maps exist then; `VITE_SENTRY_SCOPE: full` is now pinned explicitly on
that build step. A new `deploy-o11y` job builds + pushes the Grafana box
image and runs `pnpm run deploy`. Every deploy job (`deploy-authoring`,
`deploy-api`, `deploy-o11y`) now posts one `POST /telemetry/deploy` event
with a GitHub OIDC token (`id-token: write`, audience
`https://demos.handsontable.com/telemetry/deploy` — `gates/oidc.ts`'s own
constant) after its own deploy step, capturing `cf_version_id` from that
step's `Current Version ID:` stdout line; the reporting step never fails the
job (`|| true` throughout, a `::warning::` on a non-200). `deploy-api` now
`needs: [changes, build, deploy-o11y]` and proceeds when `deploy-o11y` is
`success` **or skipped**, never `failure` — the mechanical form of "o11y
deploys first" for the one push that touches both.

**`ci.yml`**: confirmed, not rewritten — `pnpm typecheck` (`pnpm -r run
typecheck`) and `pnpm test` (`node --test pipeline/*.test.mjs`) already reach
`workers/o11y` and every `pipeline/o11y-*.test.mjs`/`telemetry-*.test.mjs`
file as ordinary workspace/glob members, and `check-test-presence.mjs`'s
`SOURCE` regex (`^runner/(apps|packages|workers)/.+\.(ts|tsx)$`) already
covers `workers/o11y/**` — no wiring needed there, verified rather than
assumed. New `e2e-telemetry` job (T06-D8/T07's flagged gap): builds its own
`VITE_TELEMETRY_LOCAL=1` dist (never uploaded, never the shared
`authoring-dist` artifact) and runs `e2e/telemetry-faro.spec.ts` +
`e2e/example-analytics.spec.ts` under `E2E_TELEMETRY=1` — both self-contained
(own preview server, `page.route` interception, no o11y/API worker).
`e2e/telemetry-metrics.spec.ts` (needs `E2E_LIVE=1` + a local API worker +
a live Tier-2 container) is deliberately left unwired — documented in
`docs/run-and-deploy.md`'s "Tests (CI)" as T11's territory
(`e2e/o11y-local.spec.ts`, `E2E_O11Y_LOCAL=1`, the same "everything local,
real traffic" shape), not duplicated here.

**`apps/authoring/vite.config.ts`**: `sourcemap: uploadEnabled ? "hidden" :
false` (was `uploadEnabled` — `true`/`false` — which wrote a
`sourceMappingURL` comment Workers Assets' SPA fallback, DEV-2569, would
200-html-answer); `sentryVitePlugin`'s `filesToDeleteAfterUpload` removed —
the maps now survive the Sentry upload so `master.yml`'s own R2-upload step
can read them, and deletion happens there instead. Also fixed (controller
note, one of the "two known gaps"; outside this task's literal Owns line but
load-bearing and minimal): the `/telemetry` dev-proxy target was a
guessed hardcoded `8788` (T06-D8, pinned to a base T02 was never merged
into); now reads `process.env.O11Y_DEV_PORT ?? "4200"`, the same env var
`scripts/o11y-dev.mjs` itself defaults to `4200` from, so the two can no
longer drift apart silently.

**`workers/o11y/package.json`**: `deploy` script gained
`--var SERVICE_VERSION:$GITHUB_SHA` (contract §2's own T02-noted TODO for
this task — `env.ts`/`wrangler.jsonc` already documented the intent but the
script itself never had it).

**`docs/run-and-deploy.md`**: new "Observability worker (o11y + Grafana
box)" CD subsection (deploy events, DAG note) plus a full "One-time setup"
section — 9 numbered steps (buckets + lifecycle, the Loki S3 token, the
`o11y-logs` export destination with T02's own real-probe facts: always
JSON+gzip, never protobuf, `service.version` absent, ray id as
`cloudflare.ray_id`, never a trace destination; the Access application +
`ACCESS_AUD` — still the committed `""` placeholder, T00-D8/T03, needs a
real value pasted in before the worker can pass any Access check; every
secret from contract §2; the Slack webhook; the Sentry internal integration
+ HMAC; GitHub OIDC — nothing to configure GitHub-side beyond `id-token:
write`, the real trust boundary is the two committed o11y vars; the
`/telemetry/*` WAF exception, extending the existing `/api/*` one on the
same rule) plus "First deploy, in order". A new `SENTRY_SCOPE` /
`VITE_SENTRY_SCOPE` subsection under "Error monitoring" documents the
`full`/`uncaught` switch and explicitly defers flipping it to T11's launch
plan. A local-dev paragraph covers `pnpm o11y:dev` and the local-only env
vars (`RUNNER_EVENTS_CLICKHOUSE_URL`, `O11Y_LOCAL_*`, `DEV_ADMIN`).
Also fixed three stale `deploy-runner-authoring.yml`/`deploy-runner-api.yml`
references (pre-existing drift from an earlier merge into `master.yml`,
found while writing the CD subsection this task owns, not caused by T10) —
minimal, directly adjacent, left undone it would have actively misled the
next reader of the section this task rewrites.

**`docs/cloudflare-resources.md`**: new "Observability (o11y worker, Grafana
box)" section — the binding table, the API worker's own `O11Y`/`RUNNER_EVENTS`
additions, and a note distinguishing the Grafana box's `@cloudflare/containers`
mechanism from the 7 Tier-2 `@cloudflare/sandbox` applications above it. Fixed
the same stale `deploy-runner-*` reference here too.

**`pipeline/o11y-runbook-drift.test.mjs`** (new, 3 tests): brace-matches the
`export interface Env { ... }` block out of `workers/o11y/src/env.ts` (not a
fixed-line slice), strips comments, and keeps only fields typed as a plain
`string` or a quoted string-literal union (`"production" | "local"`) —
deliberately excluding resource-binding types
(`DurableObjectNamespace<...>`/`R2Bucket`/`AnalyticsEngineDataset`/`Fetcher`/
`RateLimit`), so `API` (a `Fetcher`) can't pass the check vacuously just
because that word appears everywhere in prose. 19 names at the time of
writing. Test 1 floors the count at 15 so a broken slice/regex can't pass on
an empty set, and positively asserts `API`/`INBOX_WRITER`/`RUNNER_EVENTS`
are NOT picked up. Test 2 requires every name to appear as a
backtick-wrapped markdown token (`` `NAME` ``) anywhere in
`docs/run-and-deploy.md`. Test 3 is a small fixture-based unit test of the
parser itself.

**Revert evidence.** With `env.ts`'s `ACCESS_AUD` renamed to
`ACCESS_AUD_RENAMED` (temp edit, restored immediately after): test 2 failed
(`not documented as a backtick-wrapped name`); restoring `env.ts` made it
pass again — `git diff workers/o11y/src/env.ts` empty afterward. Also
verified directly: `docs/run-and-deploy.md` genuinely names all 19 config
fields (each one individually confirmed present before test 2 went green;
the two near-misses along the way — `O11Y_ENV` written as `` `O11Y_ENV=local` ``
rather than a standalone token, `AE_SQL_TOKEN` mentioned only inside a bash
comment without backticks — were each caught by a real test failure, not
assumed fixed). `scripts/check-telemetry-leak.mjs` and the AGENTS.md
dev-bypass grep were each proven to have teeth, not just wired in: a build
with `VITE_TELEMETRY_LOCAL=1` made the telemetry-leak check fail with the
four expected sentinel strings; a build with a `.env.local` containing
`VITE_DEV_USER` made the dev-bypass grep find it; both then passed clean
against an ordinary production build.

**Verify (all raw, exit codes shown):**
```
rtk proxy pnpm install                                          exit=0
rtk proxy pnpm --filter @handsontable/demo-runtime build         exit=0
rtk proxy pnpm -r run typecheck                                  exit=0  (workers/o11y, apps/authoring, workers/api, packages/* all "Done")
rtk proxy pnpm test                                               exit=0  (1655 pass / 1 fail / 1 skip / 2 todo — the 1 fail is
                                                                    pipeline/theme-presets-version.test.mjs, COMMON.md's documented
                                                                    baseline failure, unrelated to o11y; unchanged by this task)
rtk proxy node scripts/check-test-presence.mjs feat/runner-observability   exit=0 (re-run after commit — see below)
```
Real `wrangler deploy --dry-run` for all three Workers, with the exact flags
each `package.json` `deploy` script now uses (`CLOUDFLARE_API_TOKEN=fake`,
never a real account): o11y (`--routes ... --var SERVICE_VERSION:$GITHUB_SHA`)
— exit 0, binding table shows `env.SERVICE_VERSION ("(hidden)")` and every
contract §2 binding, Docker really built and discarded the Grafana box
image; API — exit 0, `env.O11Y (handsontable-demos-o11y)` connected; authoring
— exit 0. `actionlint` 1.7.12 (installed via `brew install actionlint`, which
also pulled in `shellcheck` 0.11.0 — no `npx actionlint` package resolves to
a runnable binary, recorded per COMMON.md/the task's own lint instruction) on
both workflows: exit 0 (one round of real SC2129 findings — 3+ sequential
`>> "$GITHUB_OUTPUT"` redirects — fixed with brace-grouped redirects, then
clean).

Simulated (wrangler replaced by `echo`, `GITHUB_SHA` a fake 40-hex value) the
`build` job's own R2-upload-then-delete loop against a real
`SENTRY_AUTH_TOKEN=fake`-forced build: 7 `.map` files found, each key
computed as `sourcemaps/<sha>/assets/<file>.map` — byte-for-byte the shape
`workers/o11y/src/drain/symbolicate.ts#mapKeyFor` expects
(`sourcemaps/${serviceVersion}${url.pathname}.map`, and `url.pathname` for an
asset at `/assets/x.js` is `/assets/x.js`) — `find dist -name '*.map' | wc -l`
= 0 afterward, both leak checks still green on that same `dist/`.

**Known gaps / follow-ups (for T11 or later):**
- `ACCESS_AUD` is still the committed `""` placeholder — a real value must be
  pasted into `workers/o11y/wrangler.jsonc` before the Access gate can ever
  pass in production (documented as one-time-setup step 4).
- The deploy-event steps' `Current Version ID:` grep is wrangler's documented
  output shape but was never exercised against a *real* (non-dry-run) deploy
  in this task (`--dry-run` prints no version id at all) — an empty capture
  degrades to an empty `cf_version_id` string rather than failing the job;
  worth a real-deploy spot-check on T11's first launch.
- The export-destination create/patch API's exact JSON body was not
  independently re-verified against Cloudflare's HTTP API in this task (no
  real deploy allowed); the runbook step uses the fully-documented dashboard
  UI flow instead of a guessed raw API call, plus T02's own real-probe
  findings (content type, encoding, missing `service.version`, the ray-id
  attribute name) folded in as facts, not assumptions.
- `smoke`'s `needs` list was left as `[deploy-authoring, deploy-api]`
  (unchanged) — it runs after `deploy-o11y` transitively (via `deploy-api`'s
  new dependency) but has no @smoke coverage of `/telemetry/*`/`/grafana/*`
  itself; out of this task's declared scope.
