# T04 — Alert cron with state, watchdog, observability cost

| | |
|---|---|
| Status | todo |
| Size | M |
| Depends on | T00, T02; the API-side pieces merge after T05 |
| Blocks | T11 |
| ADR | 0041 §F.3, §G |
| Owns | `workers/o11y/src/alerts/**`, `workers/o11y/src/heartbeat.ts` (a `WorkerEntrypoint` exposing `heartbeat()`), `workers/o11y/src/cost.ts`, the alert entry of the `*/10` cron, `workers/api/src/o11y-watchdog.ts`, `workers/api/src/o11y-usage.ts`, `workers/api/src/{budget,reconcile,settings,admin}.ts`, `apps/authoring/src/Admin.tsx` (budget numbers and the o11y cap field only), `pipeline/o11y-{alerts,cost,watchdog}.test.mjs` |
| Shared | `workers/api/src/index.ts`: register the usage entrypoint and call the watchdog from T05's `*/5` dispatch |

## Goal

Every time-critical signal is evaluated outside the sleeping box and notifies once per
state change; the o11y stack is watched from outside itself; observability spend is its
own number with its own cap.

## Read first

- ADR-0041 §F.3 (ownership table, thresholds) and §G; contract §5, §8 (`alert:*`, `fp:*`,
  `heartbeat`, `drainsPaused`).
- `workers/api/src/budget.ts` (`recordContainerUsage`, `upsertEstimate`),
  `reconcile.ts` (`writeBillingRow`, `CF_SCRIPT_NAME`, the budget-alert
  `captureMessage` that must stay), `settings.ts`, `admin.ts`.

## Scope

In:

- **Query helper** over Analytics Engine (`AE_SQL_TOKEN`) or local ClickHouse, building
  from the contract columns, enforcing `SUM(_sample_interval * double1)` and weighted
  quantiles, refusing functions outside the Analytics Engine allowlist.
- **Rules** in one `rules.ts`, thresholds from the ADR §F.3 text; state in `InboxWriter`
  (`alert:<rule>`): notify on fire and on resolve only; `o11y.alert` points.
- **New-fingerprint rule** from the exact `fp:*` registry, excluding `demo-runtime`.
- **Rejected inbox key** rule and **backlog age** rule from `InboxWriter`.
- **Watchdog**: `heartbeat()` on the o11y worker returns `lastCron`, `lastIngest` and the
  backlog; the API worker's `*/5` cron (T05 owns the dispatch) calls
  `o11y-watchdog.ts`, which sends one Sentry `captureMessage` when either is older than
  30 minutes, and one when it recovers.
- **Cost**: `recordContainerUsage` takes a SKU; the o11y worker reports `GrafanaBox`
  awake seconds over the `API` binding to an internal entrypoint (not an HTTP route) that
  records `o11y_container`; `reconcile.ts` iterates `[handsontable-demos-api,
  handsontable-demos-o11y]` and writes the o11y script's billing rows under
  `o11y_container` / `o11y_workers`, so no upsert overwrites the app's rows; a
  `reconcile.run` point per run.
- **Cap**: `O11Y_BUDGET_USD` in the guardrail settings (validate, save, reset, default 15);
  crossing it sets `drainsPaused` and posts one Slack line; cleared at month rollover or
  when raised. `/admin` shows app, observability, total and the cap.

Out: Grafana alert rules (none, by design); spend alerts (unchanged, still Sentry).

## Acceptance criteria

- Seeded local ClickHouse data makes a rule fire once, stay silent on the next ticks, and
  resolve once (Slack capture server).
- A demo-runtime ladder raises no new-fingerprint alert; a new `authoring` handled error
  raises one.
- Stopping the o11y cron locally makes the API watchdog send one Sentry message
  (transport spy) and one on recovery.
- A local o11y usage report writes a `cost_ledger` row with `sku = 'o11y_container'`; a
  reconcile run over fixtures for both scripts leaves the app's `container` rows unchanged.
- Crossing the cap stops backlog wakes; a Grafana visit still wakes the box.
- Each test fails when its rule, state, dedupe or refusal is removed.

## Verify

```bash
cd runner
pnpm test
pnpm o11y:dev   # then trigger both crons with --test-scheduled
( cd workers/o11y && npx wrangler deploy --dry-run )
( cd workers/api && npx wrangler deploy --dry-run )
```

## Traps

- Two Workers under `wrangler dev` reach each other only through the dev registry.
- Local ClickHouse accepts SQL that Analytics Engine rejects; trust the helper's allowlist.
- `VITE_DEV_USER` short-circuits identity on `/admin` locally; clear it in admin tests.
- Do not touch the budget-alert `captureMessage` or `rehomeBudgetAlert`.

## Outcome

_Filled in when done._
