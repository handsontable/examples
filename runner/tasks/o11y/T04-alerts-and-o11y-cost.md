# T04 — Alert cron with state, watchdog, observability cost

| | |
|---|---|
| Status | done |
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

### What was built

- **AE query helper** (`workers/o11y/src/alerts/ae-query.ts`): a shared allowlist of
  Cloudflare's *documented* Analytics Engine SQL functions (read from
  developers.cloudflare.com/analytics/analytics-engine/sql-reference/
  `{aggregate,date-time}-functions/`, 2026-09-23 — `sum`, `avg`, `quantileExactWeighted`,
  `toStartOfInterval`, `toUInt32`, `now`), `findDisallowedAeFunctions`/`assertAllowedAeQuery`,
  and `runAeQuery(env, sql)` which executes against local ClickHouse (`O11Y_ENV === "local"`)
  or the real Analytics Engine SQL API. `pipeline/o11y-dashboards.test.mjs` (T09) now imports
  `ALLOWED_AE_FUNCTIONS` from this module instead of keeping its own copy — one allowlist,
  not two diverging ones, per the controller's note. All 47 dashboard tests still pass.
- **Rules** (`alerts/rules.ts`), every ADR §F.3 signal this task owns, each a pure
  `(env) => Promise<RuleResult>` (or `(inboxWriter) => ...` for the three that read
  `InboxWriter` directly): `atCapacityRule` (>5/h), `fiveXxRateRule` (>1% over 15 min),
  `previewReadyRateRule` (below 97%/95% per tier over 1h), `sessionStartP95Rule` (>20s),
  `embedErrorRateRule` (>20% with >50 views/24h, per demo), `compileErrorDoublingRule`
  (day-over-day per `ht_major`), `litellmErrorRateRule` (>5%, `chat.answer` + `theme.ai`
  combined), `backlogAgeRule` (>2h), `rejectedKeyRule` (any `rejected:*` key),
  `newFingerprintRule` (cursor-based, `InboxWriter`'s exact `fp:*` registry — `demo-runtime`
  is already excluded at write time by `feedsNewFingerprintAlert`, confirmed by reading
  `registry.ts`/`normalise/faro.ts`), and `o11yCapRule`. SQL stays to grouped
  `sum(_sample_interval * double1)`/weighted-quantile reads; every ratio, day-over-day
  comparison and the embed views/errors join is computed in JS, per the controller's "keep
  the allowlist small" note.
- **Notify** (`alerts/notify.ts`): `evaluateAndNotify` — reads `InboxWriter`'s
  `alert:<rule>` state, transitions `firing`/`resolved` exactly once per edge, posts one
  Slack line per transition (`slackPoster`, no-ops without `SLACK_WEBHOOK_URL`), and writes
  one `o11y.alert` Analytics Engine point (`reason` = rule id, `outcome` = `fired`/`resolved`).
- **`InboxWriter` additions** (`env.ts#InboxWriterApi`, implemented in `inbox/writer.ts`
  as thin RPC shells over new pure helpers in `alerts/inbox-state.ts`, same split
  `dedupe.ts`/`registry.ts`/`pack.ts` already use): `heartbeat()`/`stampCronHeartbeat()`,
  `backlogOldestAgeMs()` (derived from the inbox key's own `<yyyy-mm-dd>/<hh>`, measured as
  a lower bound from `hh:59:59.999Z` — T04-D1), `rejectedKeyCount()`,
  `newFingerprintsSince(sinceMs)`, `alertState`/`setAlertState`, `getAlertMeta`/
  `setAlertMeta` (small scalar bookkeeping — the new-fingerprint rule's cursor — under a
  separate `alertMeta:<key>` prefix, not overloading the fixed `AlertState` shape),
  `drainsPaused()`/`setDrainsPaused()`.
- **Watchdog**: `workers/o11y/src/heartbeat.ts` (`O11yHeartbeat`, a `WorkerEntrypoint`)
  composes `InboxWriter`'s `heartbeat()` + `backlogOldestAgeMs()` into one report;
  `index.ts`'s `fetch()` also answers `GET /_internal/heartbeat` directly (never through
  `router.ts`/`registerRoute` — see T04-D2 below for why that is safe here but would not be
  on the API worker). `workers/api/src/o11y-watchdog.ts#checkO11yHeartbeat` fetches that
  path over the existing `O11Y: Fetcher` binding, treats an unreachable/malformed response
  the same as staleness, and sends exactly one `Sentry.captureMessage` on the transition
  into staleness (`error` level) and one on recovery (`warning` level) — state lives in the
  API worker's own KV (`CACHE`), not `InboxWriter` (T04-D3: the watchdog watches the o11y
  stack from outside it, so its own bookkeeping must survive even when `InboxWriter` itself
  is what's unreachable). Wired into T05's marked `runFiveMinuteCron` call point exactly as
  its handoff comment specified.
- **Cost**: `budget.ts#recordContainerUsage` gained an optional `sku` parameter (default
  `"container"`, every existing call site unaffected). `workers/api/src/o11y-usage.ts`
  (`O11yUsage`, a named `WorkerEntrypoint`) exposes `recordAwakeSeconds`/`o11ySpend`;
  `workers/o11y/src/cost.ts` calls it from `box.ts#onStop` (T04-D4, see below) and from the
  cap rule, through a locally-cast structural interface (`O11yUsageRpc`) rather than a
  cross-project type import — the two Workers are separate `tsconfig.json` projects
  (`"include": ["src"]` each). `budget.ts#computeO11ySpend` sums only
  `o11y_container`/`o11y_workers` for `/admin` and the cap check;
  `computeBudgetState`'s own total is untouched, so those two SKUs still count toward the
  app's existing tiers (ADR §G: "product tiers keep acting on the total"). `reconcile.ts`
  now iterates `[handsontable-demos-api, handsontable-demos-o11y]`
  (`RECONCILE_TARGETS`), writing the o11y script's `workersInvocationsAdaptive` under
  `o11y_workers` (`o11y_container` stays estimate-only — no public per-account dataset for
  container compute, same as the app's own `container` sku) without touching the app's
  `container`/`egress`/`r2` rows; adds one `reconcile.run` point per run.
- **Cap**: `settings.ts#o11yBudgetUsd` (default $15, validated, defaults gracefully when
  absent from an older stored payload so a settings row saved before this field existed
  doesn't take the whole override down). `alerts/index.ts#runAlerts` evaluates
  `o11yCapRule` last and, on the fire/resolve transition specifically, calls
  `InboxWriter.setDrainsPaused`. `canWakeForBacklog(env)` is exported for T03's wake path
  to call after the merge (a Grafana-visit wake must not call it — unaffected by design).
  `/admin` (`adminUsage`) and `Admin.tsx`'s `BudgetCard`/`SettingsForm` show
  app/observability/total and the cap field.
- **Named `WorkerEntrypoint`s, not hidden routes, for the o11y→API direction** (T04-D2):
  the API worker's own deploy routes are the wildcard `*.demos.handsontable.com/*` (every
  Tier-2 preview subdomain), so a path added to its default `fetch()` export would be
  externally reachable from any subdomain — confirmed by reading `workers/api/package.json`'s
  `deploy` script, not assumed. `workers/o11y/wrangler.jsonc`'s `services` entry for `API`
  now carries `"entrypoint": "O11yUsage"`, so `env.API` reaches only that class's RPC
  surface, which has no HTTP route on any host. The reverse direction (API → o11y,
  `checkO11yHeartbeat`) uses a plain `fetch()` to `/_internal/heartbeat` instead, because
  the o11y worker's own deploy routes (`demos.handsontable.com/telemetry/*` and
  `/grafana/*`) do NOT wildcard-match arbitrary paths — confirmed the same way, and by a
  live `wrangler dev` probe (see "Live verification" below) showing `env.API
  (handsontable-demos-api#O11yUsage)` connected in the o11y worker's own binding listing.
- **Placeholder `scheduled()`** (`workers/o11y/src/index.ts`): calls
  `InboxWriter.stampCronHeartbeat` and `runAlerts`, clearly marked for removal at the
  feature-branch merge — T03 owns the real ten-minute cron. `workers/o11y/wrangler.jsonc`
  gained a `triggers.crons: ["*/10 * * * *"]` entry so this is locally triggerable; expected
  merge conflict with T03's own cron config, per the controller's dispatch note.

### Deltas (T04-D`<k>`)

- **T04-D1**: backlog age is measured from the END of the inbox key's own hour bucket
  (`hh:59:59.999Z`), not its start — a deliberate lower bound so the 2h rule can only fire
  late relative to the true age, never early/falsely (the key format only carries date+hour,
  never a precise arrival timestamp).
- **T04-D2**: the o11y→API cost/spend RPC uses a real named `WorkerEntrypoint`
  (`O11yUsage`) with `"entrypoint"` set in `workers/o11y/wrangler.jsonc`, not a hidden path
  on the API worker's own `fetch()` export — a design correction made *before* writing any
  code, from advisor review: the API worker's deploy routes are `*.demos.handsontable.com/*`
  (every Tier-2 subdomain), so a "not registered in `router.ts`" path there is still
  externally reachable and would have let anyone inflate `o11y_container`/`o11y_workers`
  spend rows (ADR §G: those SKUs count toward the app's own budget tiers, so this would
  have been an unauthenticated way to push the app toward `closed`). The API→o11y direction
  (`/_internal/heartbeat`) keeps the simpler `fetch()`-to-an-unrouted-path shape, because
  the o11y worker's own deploy routes do not wildcard-match arbitrary paths — verified by
  reading both `package.json` `deploy` scripts, not assumed.
- **T04-D3**: watchdog fire/resolve state lives in the API worker's own KV (`CACHE`), not
  in `InboxWriter` — the watchdog exists specifically to detect the o11y stack (and
  therefore `InboxWriter`) being unreachable, so its own bookkeeping cannot depend on the
  thing it watches.
- **T04-D4**: `box.ts#onStop` (T01-owned file, not in this task's "Owns" row) gained a
  small, clearly-commented call to `cost.ts#reportAwakeSeconds`, computing awake seconds
  from the wake record's `startedAt` to the stop's own timestamp — the only place that
  duration is ever known. First attempt used `this.ctx.waitUntil(...)`; found live (this
  task's own `pipeline/o11y-box.test.mjs` run — see "Revert evidence" below, this was a
  real regression, not a hypothetical) that a `DurableObjectState` test double need not
  implement `waitUntil`, and there is no response to unblock at that point in `onStop`
  anyway — changed to a direct `await`, which fixed all three failures.
- **T04-D5**: `pipeline/fixtures/o11y-cloudflare-workers-stub.mjs` (T02-owned test fixture)
  gained a `WorkerEntrypoint` stub alongside its existing `DurableObject` one, and
  `pipeline/fixtures/worker-hooks.mjs` (api-side) now also resolves `cloudflare:workers` to
  the SAME stub — `index.ts` re-exporting `O11yUsage` would otherwise have broken every one
  of the ~10 existing pipeline specs that import `workers/api/src/index.ts` through that
  hook file (`mcp-routes.test.mjs`, `token-routes.test.mjs`, etc.) with
  `ERR_MODULE_NOT_FOUND: cloudflare:workers`. Confirmed this would have been a real
  regression by running the full suite before adding the stub (not assumed) — see "Revert
  evidence".
- **T04-D6**: a literal `*/10`/`*/5` inside three JSDoc block comments (`settings.ts`,
  `o11y-usage.ts`, `o11y-watchdog.ts`, `env.ts`) terminates the comment early
  (`*/` closes it) and produces a cascading `SyntaxError` several lines later — caught by
  running the new pipeline tests, not by inspection; all four reworded to "ten-minute"/
  "five-minute" cron instead of the cron-string literal. Swept the rest of the diff for the
  same pattern afterward (grep for `\*/[0-9A-Za-z]`) — the remaining hits are all `//`
  line comments or the real cron-string code literal (`"*/5 * * * *"`), which are safe.

### Acceptance criteria — evidence

- **"Seeded local ClickHouse data makes a rule fire once, stay silent on the next ticks,
  and resolve once (Slack capture server)."** LIVE, against a real throwaway
  `clickhouse/clickhouse-server:24.10-alpine` container (port 4523, this task's block) with
  the contract's exact local DDL (`index1`, `blob1`–`blob20` `String`, `double1`–`double20`
  `Float64`, `timestamp DateTime64(3)`, `_sample_interval`), and a real local HTTP server
  as the Slack capture target (port 4599). Seeded 6 `session.start`/`at_capacity` rows,
  ran `atCapacityRule` + `evaluateAndNotify` three times: tick 1 (6 > 5) → `fired`, exactly
  one Slack POST; tick 2 (same data, still firing) → `undefined` transition, Slack call
  count unchanged at 1; tick 3 (truncated + reseeded with only a `ready` row) → `resolved`,
  Slack call count 2. Full transcript:
  ```
  tick1 rule result: { rule: 'at-capacity-rate', firing: true, detail: '6 at_capacity refusal(s) in the last hour (threshold 5)' }
  tick1 transition: fired slackCalls: 1
  tick2 rule.firing: true transition: undefined slackCalls: 1
  tick3 rule.firing: false transition: resolved slackCalls: 2
  ALL SLACK LINES: [
    ":rotating_light: [o11y] *at-capacity-rate* firing — 6 at_capacity refusal(s) in the last hour (threshold 5)",
    ":white_check_mark: [o11y] *at-capacity-rate* resolved"
  ]
  LIVE VERIFY: PASS
  ```
  Container and capture server both torn down afterward (`docker rm -f t04-ch-probe`;
  confirmed `docker ps` clean). The equivalent deterministic case (injected fakes, no
  Docker) is `pipeline/o11y-alerts.test.mjs`'s "notify: fires once… stays silent…" pair,
  which runs on every future `pnpm test`.
- **"A demo-runtime ladder raises no new-fingerprint alert; a new `authoring` handled
  error raises one."** Partially covered, honestly scoped: `feedsNewFingerprintAlert`
  (contract §7, T00-owned, called from `normalise/faro.ts` — confirmed by reading both
  files) is what excludes `surface = demo-runtime` fingerprints from ever reaching the
  `fp:*` registry at all, so by the time `newFingerprintRule` runs, every entry it can see
  is already alert-eligible — `newFingerprintRule`'s own test
  (`pipeline/o11y-alerts.test.mjs`) proves the cursor/fire logic over a fake registry, and
  `pipeline/o11y-normalise.test.mjs` (T02, unmodified by this task) already proves the
  demo-runtime exclusion at the write path. This task did not add a NEW end-to-end test
  driving a demo-runtime ladder through the real ingest route into `newFingerprintRule` in
  one pass — the pieces are proven separately, not stitched into one live scenario, for
  time. Recorded as a gap below.
- **"Stopping the o11y cron locally makes the API watchdog send one Sentry message
  (transport spy) and one on recovery."** Deterministic:
  `pipeline/o11y-watchdog.test.mjs`, 5/5 passing, including the exact fire-once/
  stays-silent-across-ticks/resolve-once sequence with an injected `capture` spy (mirrors
  T05's `CronCaptureFn`/`CaptureExceptionFn` injection pattern). LIVE (real `wrangler dev`,
  both Workers, real cross-worker binding, see "Live verification" below): triggering the
  API's five-minute cron while the o11y worker is reachable produces no heartbeat error in
  the log (fresh — correct); stopping the o11y `wrangler dev` process and re-triggering
  produces no crash and the cron still answers `ok` (the unreachable-heartbeat path is
  exercised for real, not just mocked) — a real Sentry transport-spy capture (T05's exact
  `:4640` HTTP-spy pattern) was not reproduced live, since `SENTRY_ENVIRONMENT` (only set
  by the deploy script) gates the SDK off locally by design (`sentry-gate.ts`) and setting
  it up would have meant redoing T05's whole spy-server harness for marginal additional
  confidence over the 5 already-passing injected-capture unit tests. Recorded as a gap.
- **"A local o11y usage report writes a `cost_ledger` row with `sku = 'o11y_container'`; a
  reconcile run over fixtures for both scripts leaves the app's `container` rows
  unchanged."** `pipeline/o11y-cost.test.mjs`, 10/10 — `O11yUsage.recordAwakeSeconds`
  writes exactly that row (case 7); `reconcileBilling` over mocked GraphQL fixtures for
  both scripts (case 10) asserts the app's pre-existing `container` estimate row is
  `deepEqual` before/after, byte-for-byte.
- **"Crossing the cap stops backlog wakes; a Grafana visit still wakes the box."**
  Testable only up to the boundary this task owns, honestly: `o11yCapRule`'s fire/resolve
  is proven (`pipeline/o11y-alerts.test.mjs`), and `canWakeForBacklog`/`drainsPaused` are
  proven through the REAL `InboxWriter` Durable Object (not just the pure helper) —
  `setDrainsPaused(true)` → `canWakeForBacklog` → `false`. **The backlog-wake decision
  itself is T03's, and T03 has not merged** — this task cannot test "a backlog wake is
  actually refused" or "a visit wake is actually unaffected" until that code exists.
  `canWakeForBacklog(env)` is exported from `alerts/index.ts` specifically so T03's wake
  path can call it after the merge; the controller's own dispatch note anticipates this
  ("make sure T03's wake path honours it after the merge, with a test" — that test lands
  with T03's merge, not here). Reported as directed rather than claimed.
- **"Each test fails when its rule, state, dedupe or refusal is removed."** See "Revert
  evidence" below — six real mutations, each proven red then reverted to green, covering
  the fire-once dedupe, the sku parameter, the reconcile script loop, the cap boundary, the
  `onStop` regression, and the `cloudflare:workers` stub regression.

### Revert evidence

Every row: the named change was made for real in the working tree, the stated test file
run, the exact failing test id recorded, then the change reverted and the suite
re-confirmed green (`git diff --stat` clean before/after this whole pass, confirming every
revert landed back exactly on the committed state).

| Reverted | Test file | Failing test | Reverted, re-passes |
|---|---|---|---|
| `notify.ts`: `!wasFiring` dropped from the fire condition | `o11y-alerts.test.mjs` | `not ok 11 - notify: fires once on the first firing tick, stays silent while still firing` | yes (23/23) |
| `budget.ts`: `recordContainerUsage`'s `opts.sku ??` collapsed to a bare `"container"` | `o11y-cost.test.mjs` | `not ok 2` (explicit sku) and `not ok 7` (O11yUsage) | yes (10/10) |
| `reconcile.ts`: the o11y entry dropped from `RECONCILE_TARGETS` | `o11y-cost.test.mjs` | `not ok 10 - reconcileBilling: iterates both scripts…` | yes (10/10) |
| `rules.ts`: `o11yCapRule`'s `>=` relaxed to `>` | `o11y-alerts.test.mjs` | `not ok 18 - o11yCapRule: fires at or above the cap, not below it` | yes (23/23) |
| `box.ts`: `onStop`'s cost report changed from a direct `await` to `this.ctx.waitUntil(...)` (the FIRST version, found live, not a deliberate revert-proof mutation) | `o11y-box.test.mjs` | 3 failures: `not ok 787/804/805`, `this.ctx.waitUntil is not a function` | yes (19/19), fixed by awaiting directly instead |
| `worker-hooks.mjs`: `cloudflare:workers` stub NOT added (the state before this task's own fix, found live, not a deliberate revert-proof mutation) | full `pnpm test` | would have broken `mcp-routes.test.mjs`, `token-routes.test.mjs`, and 8 others with `ERR_MODULE_NOT_FOUND: cloudflare:workers` the moment `index.ts` re-exported `O11yUsage` | yes (full suite green except the known baseline failure) |

The last two rows are real regressions this task's own work caused and then fixed, kept in
the table per COMMON.md's "seen failing" rule rather than only reporting the clean end
state.

### Live verification

**ClickHouse + Slack capture** — see "Acceptance criteria" above.

**`wrangler dev`, both Workers, real cross-worker bindings** (port block 4500–4599;
`WRANGLER_REGISTRY_PATH=/Users/amedrygal/Code/examples-wt/T04/.wrangler-registry` on both,
per COMMON.md's isolated-registry rule):

```
cd workers/o11y && WRANGLER_REGISTRY_PATH=... npx wrangler dev --port 4510 --inspector-port 4511 --test-scheduled
cd workers/api && WRANGLER_REGISTRY_PATH=... npx wrangler dev --port 4520 --inspector-port 4521 --test-scheduled
```

- Both bindings connected: o11y's own binding listing shows
  `env.API (handsontable-demos-api#O11yUsage) ... [connected]`; the api worker's shows
  `env.O11Y (handsontable-demos-o11y) ... [connected]`.
- `curl "http://localhost:4510/cdn-cgi/handler/scheduled?cron=*/10 * * * *"` → `ok`, no
  crash; `curl http://localhost:4510/_internal/heartbeat` afterward →
  `{"lastCron":1790172681145,"lastIngest":0,"backlogOldestAgeMs":null}` — confirms
  `stampCronHeartbeat` persisted to the real (SQLite-backed) local `InboxWriter` storage
  and survived the request round-trip.
- `curl "http://localhost:4520/cdn-cgi/handler/scheduled?cron=*/5 * * * *"` (o11y still
  up, heartbeat fresh) → `ok`; log shows `pool-gauge`/`budget-gauge` steps failing on a
  fresh local D1 with no migrations applied (pre-existing environment gap, same one T05's
  Outcome recorded — `no such table: cost_ledger`/`runner_settings`), but **no error for
  the `heartbeat` step** — silent success is the correct "fresh, no capture" behaviour.
- Stopped the o11y `wrangler dev` process (`TaskStop`), re-triggered the api cron →
  `_internal/heartbeat` now refuses the connection (`curl` exit 000), the cron still
  answers `ok`, still no crash — `fetchHeartbeat`'s `catch { return null; }` path is
  exercised for real, not just mocked. See "Acceptance criteria" above for what this does
  and does not prove about the actual Sentry transport.
- Both `wrangler dev` processes stopped afterward (`TaskStop` on both task ids); `ps aux |
  grep "wrangler dev"` empty; `docker ps` shows no running containers from either session
  (the sandbox/proxy-everything containers wrangler dev creates all stopped cleanly);
  `.dev.vars` files removed from both worker directories (never committed); the
  `.wrangler-registry` directory removed.

### Concerns / gaps for the controller

- **Analytics Engine SQL on the real platform is not verifiable** (COMMON.md: the sandbox
  probe token has no Account Analytics read). `alerts/ae-query.ts#runAnalyticsEngineSqlApi`
  is written to Cloudflare's documented request/response shape (raw SQL POST body,
  `{ data: [...] }` JSON) but only the local ClickHouse path was actually exercised, live
  and in the test suite. This is the same gap T09's own Outcome records for its dashboard
  queries.
- **The new-fingerprint rule's end-to-end path (real ingest → real exclusion → real alert
  fire) is proven in two separate pieces, not stitched into one live scenario** — see
  "Acceptance criteria" above. The seam (`IngestItem.fingerprint` being set/unset) is
  exactly what `normalise/faro.ts`/`registry.ts` already test; `newFingerprintRule`'s own
  cursor logic is exactly what this task's test proves. Low risk, but not a single
  end-to-end proof.
- **A real Sentry transport-spy capture of `checkO11yHeartbeat`'s live message was not
  reproduced** (T05's `:4640` HTTP-spy pattern) — the fire-once/resolve-once logic itself
  is proven deterministically (5 unit tests) and the real cross-worker fetch path is proven
  live; only the actual `Sentry.captureMessage` → real HTTP POST hop is unverified beyond
  what T05 already established works for the same SDK call shape.
- **"Crossing the cap stops backlog wakes; a Grafana visit still wakes the box" cannot be
  tested past `canWakeForBacklog`/`drainsPaused`** until T03 merges — see "Acceptance
  criteria" above. T03's wake path must call `alerts/index.ts#canWakeForBacklog(env)`
  before a *backlog* wake (never before a visit wake) and gets a ready-made test target
  (`InboxWriter.setDrainsPaused` → `canWakeForBacklog` → `false`) to build its own wake
  test against.
- **`workers/o11y/wrangler.jsonc`'s new `triggers.crons` entry and the `services[0]
  .entrypoint` field, and `workers/api/wrangler.jsonc`'s unmodified `services[0]` for
  `O11Y`, are expected merge-conflict/coordination points with T03** (cron config) and
  potentially T03/T09 (nothing else touches these blocks currently, but T03's own cron
  handler needs to replace this task's placeholder `scheduled()` and call `runAlerts`
  itself, per the controller's dispatch note).
- **`reconcile.run`'s `usd` value is "total billing usd written this run," not a true
  delta against the estimate it replaced** — the contract names the metric "usd (billing −
  estimate)"; reading the pre-write estimate back would have meant an extra D1 read per
  sku per run for a number `/admin`'s existing `spendBySku` breakdown already exposes more
  precisely (estimate vs. billing side by side). Flagged rather than silently shipped as
  exact.

### Merge status

T03 (`*/10` cron, backlog/ledger) and T09 (dashboards) have both already merged into this
task's base per the dispatch (T09's allowlist is repointed at this task's shared module;
T03's real cron has NOT been merged as of this report — this task's `scheduled()` is
still the placeholder). Per the controller's instruction: **merge
`feat/runner-observability` into this branch, resolve conflicts, and re-run the DoD before
declaring final** — not yet done as of this commit; reported as directed if the controller
has not yet said to proceed with that merge.

### Verify — commands run, exit codes

All via `rtk proxy <command>; echo "exit=$?"`, from `runner/` unless noted, per COMMON.md.

```
rtk proxy pnpm install                                              exit=0
rtk proxy pnpm --filter @handsontable/demo-runtime build             exit=0
rtk proxy pnpm -r run typecheck                                      exit=0
rtk proxy pnpm test                                                   exit=1 (1523 tests, 1520 pass,
                                                                                1 known baseline failure —
                                                                                theme-presets-version.test.mjs,
                                                                                '18.1.0' !== '18.1.1' — 2 todo,
                                                                                0 other failures)
rtk proxy node --experimental-strip-types --test pipeline/o11y-alerts.test.mjs     exit=0 (23/23)
rtk proxy node --experimental-strip-types --test pipeline/o11y-cost.test.mjs       exit=0 (10/10)
rtk proxy node --experimental-strip-types --test pipeline/o11y-watchdog.test.mjs   exit=0 (5/5)
rtk proxy node --experimental-strip-types --test pipeline/o11y-dashboards.test.mjs exit=0 (47/47, unchanged)
( cd workers/o11y && rtk proxy npx wrangler deploy --dry-run )        exit=0
( cd workers/api && rtk proxy npx wrangler deploy --dry-run
  --routes '*.demos.handsontable.com/*' --routes 'demos.handsontable.com/api/*'
  --routes 'demos.handsontable.com/d/*' --routes 'demos.handsontable.com/embed/*'
  --var SENTRY_ENVIRONMENT:api-production --var SERVICE_VERSION:<sha> )   exit=0
rtk proxy node scripts/check-test-presence.mjs feat/runner-observability
                                                    exit=0 (20 source file(s) changed, matching test change)
```

`pnpm o11y:dev` does not exist yet (T03 builds it, confirmed by T09's own Outcome noting
the same gap at its own dispatch time) — substituted direct `wrangler dev --test-scheduled`
against both Workers on this task's own port block, per the same precedent T09 and T05
used. See "Live verification" above for what was run and what it showed.

### Fix round (single round, per controller review)

Findings I1, I2, and the controller's ruling on the deferred Minor 3 (session-start p95
must read `outcome = 'ready'` only). Other minors deferred, per the controller's note.
T03 still has not merged; the feature branch was not merged into this branch this round
either, per the reviewer's explicit instruction.

- **I1 — 7 of 11 rules and their shared SQL helpers had no automated tests.** Threaded an
  injectable `queryFn: AeQueryFn = runAeQuery` through every shared helper
  (`countByOutcome`, `countByGroup`, `countByGroupInWindow`, `weightedQuantile`) and every
  AE-query rule (`atCapacityRule`, `fiveXxRateRule`, `previewReadyRateRule`,
  `sessionStartP95Rule`, `embedErrorRateRule`, `compileErrorDoublingRule`,
  `litellmErrorRateRule`) — the same injection shape `cron-step.ts#CronCaptureFn`/
  `diagnostic.ts#CaptureExceptionFn` already use elsewhere in this codebase. Added
  `pipeline/fixtures/fake-ae-query.mjs`: a small SQL-shape matcher (parses `index1 = `,
  the window bound(s), `AND <slot> = '<value>'` filters, and either a grouped-count or a
  `quantileExactWeighted` `SELECT`) that answers from a plain JS array of seeded rows —
  no live ClickHouse/AE endpoint, fully deterministic. **Column references in `rules.ts`
  are now built from the contract's own `AE_COLUMNS` map via a `col()` helper (throws on
  an unknown name) instead of hand-numbered `blobN`/`doubleN` literals** — `countByGroup`/
  `countByGroupInWindow` now take a column *name* (`"demo_id"`, `"ht_major"`), never a
  bare slot number. 10 new test cases (one over-threshold, one under-threshold per rule,
  plus a dedicated case proving the ready-outcome filter below), each asserting the
  generated SQL names the right `AE_COLUMNS` slot for at least one central column.
- **Controller ruling (was Minor 3) — `sessionStartP95Rule` now filters to
  `outcome = 'ready'` only.** Unfiltered, fast `at_capacity`/`container_starting`/
  `budget_denied` refusals blend into the same `session.start` metric and drag the
  computed p95 down, masking a real slow-start problem during overload — exactly when the
  rule matters most. Fixed with `AND ${col("outcome")} = 'ready'` appended to
  `weightedQuantile`'s `WHERE` clause. Proven by a dedicated case: 10 `ready` rows at
  1000ms plus one non-`ready` (`at_capacity`) row at 999999ms — firing stays `false`
  (p95 ≈ 1000ms), proving the huge non-ready value was excluded, not merely that the SQL
  string looks right.
- **I2 — AE query failures were silent past the returned `errors` map.** Added
  `rules.ts#alertEvalErrorRule(errors)`, a synthetic rule (id `alert-eval-error`, not an
  ADR §F.3 signal) that `runAlerts` builds from whatever errors *this tick's own run*
  collected and evaluates **last**, through the exact same fire-once/resolve-once
  `evaluateAndNotify` every other rule uses. The logic lives inside `runAlerts` itself
  (`alerts/index.ts`), not the caller — so it holds for whichever cron handler calls
  `runAlerts` (this task's own placeholder `scheduled()` today, T03's real ten-minute cron
  after the merge), per the controller's note. Also renamed the per-rule error-map keys
  from the JS function name (e.g. `atCapacityRule`) to the exact `RuleResult.rule` id
  (e.g. `at-capacity-rate`, via a new `QUERY_RULES: { id, fn }[]` list) — before this fix
  the error map and every ordinary fire/resolve Slack line named the same rule two
  different ways.
- **A real bug found and fixed while writing the I2 integration test (not a deliberate
  revert-proof mutation).** `notify.ts#writeAlertPoint` did `void sink.writeDataPoint(point)`
  — `void` only silences the "unused promise" lint concern, it does not catch a rejection.
  `clickhouseSink`'s HTTP write returns a promise that rejects on a real failure (which the
  I2 integration test deliberately causes, pointing `RUNNER_EVENTS_CLICKHOUSE_URL` at a
  refused local port), and that rejection surfaced later as an unhandled rejection,
  failing the whole `o11y-alerts.test.mjs` file (`node --test`'s own "generated
  asynchronous activity after the test ended" diagnostic — measured, not assumed). Fixed
  by wrapping in `Promise.resolve(sink.writeDataPoint(point)).catch(() => {})`, which
  correctly handles both the synchronous `void` case (`bindingSink`, the real AE binding)
  and the async one.

**Revert evidence (three real mutations for I1's own "show at least three tests failing"
ask, on top of the six already recorded above — nine total across both rounds)**:

| Reverted | Test | Failing test id | Reverted, re-passes |
|---|---|---|---|
| `rules.ts`: `previewReadyRateRule`'s `tierCol` built from `col("outcome")` instead of `col("tier")` (a swapped blob) | `o11y-alerts.test.mjs` | `not ok 26 - previewReadyRateRule: tier 1 below 97% fires...` | yes (33/33) |
| `rules.ts`: `atCapacityRule`'s `firing: n > 5` flipped to `n > 50` | `o11y-alerts.test.mjs` | `not ok 24 - atCapacityRule: over threshold (6 > 5) fires...` | yes (33/33) |
| `rules.ts`: `sessionStartP95Rule`'s `AND ${outcomeCol} = 'ready'` filter dropped (reverting the controller's own ruling) | `o11y-alerts.test.mjs` | `not ok 27 - sessionStartP95Rule: over 20s fires... outcome='ready' filter is real, not decorative` | yes (33/33) |

`git diff --stat` on `rules.ts` after all three mutate/revert cycles matches the intended
fix-round diff exactly (verified — no leftover mutation).

**Verify — commands run, exit codes (fix round)**:

```
rtk proxy node --experimental-strip-types --test pipeline/o11y-alerts.test.mjs        exit=0 (33/33)
rtk proxy node --experimental-strip-types --test pipeline/o11y-cost.test.mjs          exit=0 (10/10)
rtk proxy node --experimental-strip-types --test pipeline/o11y-watchdog.test.mjs      exit=0 (5/5)
rtk proxy node --experimental-strip-types --test pipeline/o11y-dashboards.test.mjs    exit=0 (47/47, unaffected)
rtk proxy pnpm -r run typecheck                                                        exit=0
rtk proxy pnpm test    exit=1 (1533 tests, 1530 pass, 1 known baseline failure
                                — theme-presets-version.test.mjs, '18.1.0' !== '18.1.1' —
                                2 todo, 0 other failures; +10 net new tests since phase 1)
( cd workers/o11y && rtk proxy npx wrangler deploy --dry-run )                         exit=0
( cd workers/api && rtk proxy npx wrangler deploy --dry-run ... )                      exit=0
rtk proxy node scripts/check-test-presence.mjs feat/runner-observability
                                                    exit=0 (20 source file(s) changed, matching test change)
```

Commit: `3b7dcebab` — "fix(runner): T04 fix round -- rule tests, alert-eval-error,
ready-only p95". Not amended, per instruction. `feat/runner-observability` was not merged
into this branch this round — T03 still has not merged, per the reviewer's explicit
instruction to wait.
