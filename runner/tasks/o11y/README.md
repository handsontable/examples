# Runner observability — task board

Implementation tasks for [ADR-0041](../../docs/adr/0041-observability-stack.md) revision 3 and [ADR-0042](../../docs/adr/0042-example-analytics.md).
**Temporary**: this directory lives only on `feat/runner-observability`. T11 folds
what must survive into permanent docs and deletes the directory in the last commit
before the feature branch merges to `master`.

Read before any task: ADR-0041, the permanent
[observability contract](../../docs/observability-contract.md),
[REVIEW-RESPONSE.md](REVIEW-RESPONSE.md) (why revision 3 looks the way it does), `runner/AGENTS.md`, `runner/docs/TESTING.md`.

## Index

Sizes: **M** ≈ one focused agent session, **L** ≈ one to two sessions. No task is
smaller than a reviewable PR on its own. Each task's status lives only in its own
file's header (not in this table), so parallel PRs never edit the same lines here.
T13 is `deferred`; the rest start as `todo`.

| ID | Task | Size | Depends on | Runs in parallel with |
|---|---|---|---|---|
| [T00](T00-contract-module-and-scaffolds.md) | Telemetry contract module, o11y scaffolds, dependencies | M | — | T01 |
| [T01](T01-grafana-box-image.md) | Loki + Grafana box, stop protocol, clean-shutdown marker (spike a) | L | — (merges after T00) | T00, T02, T05, T06, T07 |
| [T02](T02-o11y-ingest.md) | o11y Worker ingest: routes, gates, normalisation, `InboxWriter` (spike b, part 1) | L | T00 | T01, T05, T06, T07 |
| [T03](T03-drain-wake-grafana-access.md) | Ledger, drain, symbolication, wake, Grafana access (spike b, part 2) | L | T01, T02 | T04, T08, T09 |
| [T04](T04-alerts-and-o11y-cost.md) | Alert cron with state, watchdog, observability cost | M | T00, T02; merges after T05 | T03, T08, T09 |
| [T05](T05-api-worker-signals.md) | API worker signals, error lines, Sentry switch | L | T00 | T01, T02, T06, T07 |
| [T06](T06-faro-in-authoring.md) | Faro in the authoring app and browser-side Sentry trim | L | T00 | T01, T02, T05, T07 |
| [T07](T07-browser-metrics.md) | Browser metrics catalogue | M | T00; merges after T06 | T01, T02, T05, T06 |
| [T08](T08-lite-beacon-and-serve-counts.md) | Lite beacon on embeds and `/d`, serve counts | M | T00, T02 | T03, T04, T09 |
| [T09](T09-dashboards.md) | Dashboards as code | L | T00, T01 | T03, T04, T08 |
| [T10](T10-ci-deploy-runbook.md) | CI, deploy wiring and runbook | M | T01, T02, T03 | T09 |
| [T12](T12-example-analytics.md) | ADR-0042 example analytics | M | T02, T06 | T03, T04, T08, T09 |
| [T11](T11-local-e2e-and-launch-gate.md) | Local end-to-end verification and launch gate | M | T00–T10, T12 | — |
| [T13](T13-admin-cutover.md) | ADR-0043 `/admin` cutover and Cost dashboard | M | T03, T04, T09 | — |

**Scope** (decided 2026-09-23): T00–T12 are this branch and the launch, ADR-0042 included.
T13 (`/admin` cutover, ADR-0043) runs last, after launch: its comparison week needs
production data. T11 keeps T13's plan alive by leaving ADR-0043 as the record of it.

## Waves

```text
wave 0   T00 ─────────────┐        T01 may start at once (reads the contract doc, imports nothing)
wave 1   T01  T02  T05  T06  T07   five agents, disjoint files (see ownership below)
wave 2   T03 (T01+T02)  T04 (T02)  T08 (T02)  T09 (T01)  T12 (T02+T06)
wave 3   T10 (after T03)
wave 4   T11 launch gate
after    T13, once production has run a week
```

## Decision: probes on the sandbox account

Decided 2026-09-23: facts that only exist on real Cloudflare are measured with
**throwaway probes on the sandbox account** (`PoCs handsontable.com Sandbox`,
`e17e41cc82bda15dfa63960aa172fb87`). That covers container cold start and memory, EU
pinning of the Container's Durable Object, the export's shape, cadence and retry
behaviour, and whether real export records reach Loki with the contract labels (ADR-0041
exit criterion 15). T01, T02 and T03 each have a required "Sandbox probe" section.

Probe rules:

- **Never the production account.** Deploy probes with an explicit sandbox account id
  (`CLOUDFLARE_ACCOUNT_ID=e17e41cc82bda15dfa63960aa172fb87` and a probe-only
  `wrangler.probe.jsonc` with its own Worker name, e.g. `o11y-probe-t02`), never with the
  feature's `wrangler.jsonc`. Run `wrangler whoami` before every deploy.
- **Throwaway**: delete every probe Worker, container image, bucket and export
  destination when measured, and list what was deleted in the Outcome.
- **No real user data**: probes carry synthetic traffic only; fixtures captured from them
  are still passed through the scrubber before they are committed.

**How ADR-0041 moves from Proposed to Accepted**: the local exit criteria are proven by
T01/T03/T11, the Cloudflare-only ones by the probes. T11 flips the status before merge
when both have evidence.

## Working a task

1. **Claim**: set the task file's `Status` to `in-progress — <who>, <branch>`; commit
   only that and push, so two agents never take the same task. Check the other task
   files' status before claiming.
2. **Branch**: `feat/o11y/T<nn>-<slug>` off `feat/runner-observability`. Open the PR
   **into the feature branch**, with `.github/PULL_REQUEST_TEMPLATE.md` filled in
   (repo rule). Rebase on the feature branch before asking for review.
3. **Files**: change the files your task owns. Shared files follow the table below
   and its merge order; if you must touch a file owned elsewhere, keep the edit
   minimal and say so in the PR.
4. **Contract**: never change a name, a slot or a shape locally. Edit
   `docs/observability-contract.md` and `packages/runtime/src/telemetry/` together in
   a separate small PR and merge it first. Its history is
   `git log -- docs/observability-contract.md`.
5. **ADR deviations**: do not edit ADR-0041/0042/0043 during the review round, and do
   not append to ADR-DELTAS.md (it holds the planning-time deltas only). Record a new
   deviation in your task's Outcome under an id like `T02-D1`; T11 collects them.
6. **Done** means every item of the definition of done below, then `Status: done`
   and an **Outcome** section in the task file: what was built, measured facts with
   numbers, deviations (with their delta id), follow-ups.

## Definition of done (every task)

- Acceptance criteria met **on localhost**, with the commands in the task file.
- Tests prove intent (`runner-test-discipline` skill): each new test was seen failing
  with the change reverted, and says so in the PR's "How was this verified".
- The presence gate passes: `node scripts/check-test-presence.mjs feat/runner-observability`.
- Run raw, never through an `rtk` summary (it has printed a green summary over real
  failures in this repo):
  ```bash
  cd runner
  pnpm --filter @handsontable/demo-runtime build     # apps typecheck against dist
  pnpm -r run typecheck
  pnpm test
  ```
  plus the task's own e2e spec, on its own port.
- `wrangler deploy --dry-run` for every Worker the task touched.
- No secret in git; new local-only settings go in `.dev.vars` / `.env.local` with an
  entry in the matching `.example` file.

## Shared files and merge order

| File | Owner | Also touched by | Merge order |
|---|---|---|---|
| `runner/pnpm-lock.yaml`, dependency lists | T00 adds every new dependency | anyone who truly needs one more | T00 first; one dependency change per PR afterwards |
| `packages/runtime/src/telemetry/**`, `packages/runtime/package.json` exports | T00 | contract PRs only | — |
| `workers/o11y/wrangler.jsonc` | T00 (scaffold, all binding names) | T01 containers block, T02 DO/R2/AE/rate limit, T03 cron, T04 alert cron entry | T00 → T01/T02 → T03 → T04 |
| `workers/o11y/src/box.ts` | T01 | T03 (wake and stop wiring) | T01 → T03 |
| `workers/o11y/src/inbox/**` | T02 (`writer.ts`, `pack.ts`, `dedupe.ts`, `registry.ts`) | T03 (`ledger.ts`), T04 (alert state helpers) | T02 → T03 → T04 |
| `workers/o11y/src/router.ts` | T02 | T03, T04, T08 register handlers through `registerRoute`, never edit internals | T02 first |
| `workers/api/wrangler.jsonc`, `workers/api/package.json` | T05 | T10 (CI passes `SERVICE_VERSION`) | T05 → T10 |
| `workers/api/src/index.ts` | T05 | T04 (usage entrypoint, watchdog call), T12 (rollup call via reconcile) | T05 → T04 → T12 |
| `workers/api/src/share.ts`, `monitor-inject.ts` | T08 | — | — |
| `workers/api/src/budget.ts`, `reconcile.ts`, `admin.ts`, `settings.ts` | T04 | T12 (one rollup call in `reconcile.ts`) | T04 → T12 |
| `workers/api/src/analytics.ts` | T00 (moves `BOT_RE` and the UA classifiers into the contract module) | — | — |
| `apps/authoring/src/App.tsx` | T06 (reporting, relay, fetch headers) | T07 (timing call sites), T12 (`example.*` at the resolve path) | T06 → T07 → T12 |
| `apps/authoring/src/sentry.ts`, `main.tsx`, `userScope.ts`, `reportingGate.ts`, `eventGate.ts` | T06 | — | — |
| `apps/authoring/vite.config.ts` | T06 (dev proxy for `/telemetry`) | T10 (source maps) | T06 → T10 |
| `apps/authoring/src/Admin.tsx` | T04 (three budget numbers, o11y cap field) | — | — |
| `packages/runtime/src/monitor.ts` | T08 (beacon transport) | T00 (fingerprint shapes read `normalizeMonitorMessage`, no edit) | — |
| `packages/runtime/src/sandpack.ts`, `container.ts` | T07 | — | — |
| `containers/o11y/**` | T01 | T03 `waking/`; T09 and T12 `grafana/dashboards/**` | T01 first |
| `.github/workflows/*.yml` | T10 | — | — |
| `docs/run-and-deploy.md`, `docs/cloudflare-resources.md` | T10 | T11 final pass | T10 → T11 |
| `docs/adr/**` | nobody during the branch | T11 folds ADR-DELTAS | last |
| `runner/AGENTS.md` | T11 | — | last |

## Local stack quick reference

Filled in by T01 and T03 as the pieces land. Target shape:

```bash
cd runner
pnpm o11y:dev            # box (Docker) + o11y worker + fixture replay + Slack capture
# authoring app with local telemetry: VITE_TELEMETRY_LOCAL=1 in apps/authoring/.env.local
# API worker: cd workers/api && npx wrangler dev
```

## Git

The feature branch exists locally only, uncommitted. Agents working asynchronously need it pushed
(`git push -u origin feat/runner-observability`); that is the branch owner's call.

## Launch safety

Everything merges and deploys together, so the risky part is switched, not merged
separately: the Sentry trim ships behind `SENTRY_SCOPE` / `VITE_SENTRY_SCOPE` (contract
§11), defaulting to `full`, where handled reports go to Sentry **and** the new stack.
T11's launch plan flips both to `uncaught` only after the pipeline has been seen working
in production. Until then nothing that reaches Sentry today stops reaching it.

## CI

`ci.yml` runs on every pull request with no branch filter, so task PRs into the feature
branch get the full PR suite, the presence gate and Bugbot like any other PR.
