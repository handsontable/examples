# T10 — CI, deploy wiring and runbook

| | |
|---|---|
| Status | todo |
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

_Filled in when done._
