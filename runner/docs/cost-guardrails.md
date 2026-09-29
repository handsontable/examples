# Cost guardrails

How the demo runner is stopped from running up a surprise Cloudflare bill
(DEV-2030). Decision record: [ADR-0022](adr/0022-self-enforced-spend-ceiling.md).

Everything below applies to the main Handsontable Cloudflare account.

Dollar amounts here are Cloudflare's published unit prices and worked examples
against a nominal **$1,000/month ceiling**; the ceiling and its tiers that this
deployment actually runs with are configuration (`BUDGET_*`, overridable in
`/admin`), not part of this document.

## What was already bounded, and what was not

`runner/workers/api/wrangler.jsonc` caps containers:

```jsonc
"containers": [
  { "class_name": "Sandbox",        "instance_type": "standard-1", "max_instances": 10 },
  { "class_name": "BuilderSandbox", "instance_type": "standard-1", "max_instances": 5 }
]
```

`standard-1` is 0.5 vCPU / 4 GiB / 8 GB. Memory and disk bill on *provisioned*
size for every awake second; CPU bills on *actual* use.

| | per awake container-hour |
|---|---|
| awake, CPU idle | **$0.0380** |
| awake, CPU at the full 0.5 vCPU | **$0.0740** |

Worst case — every slot awake 24/7 for a 730-hour month:

| | container-hours | cost |
|---|---|---|
| Sandbox (10) | 7,300 | $277 – $540 |
| BuilderSandbox (5) | 3,650 | $139 – $270 |
| **Both saturated** | **10,950** | **$416 – $810** |
| + container Durable Object duration | | ~$53 |
| **Ceiling** | | **~$469 – $863/mo** |

So `max_instances` is a real, Cloudflare-enforced cap, and after DEV-2909 it
sits at roughly 47–86% of a $1,000 ceiling. **Raising it is the one change that
invalidates this table** — redo the table in the same commit, and read the next
section before picking a number.

### Why 10/5, and what it costs (DEV-2909)

It was 5/3, chosen before the runner had traffic and defended here as
"structurally 25–45% of the ceiling". Traffic arrived: 500–900 live sessions a
day, and the 5-slot pool started refusing visitors — Cloudflare's "maximum
number of running container instances exceeded", surfaced as the `at_capacity`
503 and filed in Sentry as DEMOS-33. The pool was rationing a resource we were
barely paying for:

| | metered (`cost_ledger`, `sku='container'`) |
|---|---|
| busiest day observed | 30k awake-seconds, **$0.42** |
| typical day | 2–10k awake-seconds, $0.03–0.15 |
| month | **~$5** |

That is ~1% of even the old worst-case row, because the worst case assumes every
slot awake 24/7 and real sessions sleep after 5m. Doubling the live pool and
taking the builder from 3 to 5 buys ~2x the concurrent visitors for a worst case
that is still below the ceiling and a *measured* cost that stays in single-digit
dollars.

What this trade gives up, stated plainly: at 5/3 the container cap was
structurally *below* the lower half of the ceiling, so containers could never be
the SKU that tripped it. At 10/5 the pathological end of the table (every slot at
full 0.5 vCPU, 24/7, for a month) reaches ~86% of $1,000, so a sustained
saturation event would now be caught by the Worker's own tiers — `new_blocked`
at 95% — rather than by Cloudflare's cap alone. That is layer 3 doing its job,
but it is a layer we enforce, which is weaker than one Cloudflare enforces.
Account limits are not a constraint at this size (6 TiB memory / 1,500 vCPU
concurrent).

Cloudflare's cap is also the only thing bounding *concurrency*, not just spend:
there is no separate queue in front of the pool, so `Sandbox.max_instances` is
exactly the number of visitors who can hold a live preview at once.

### Measuring pool pressure — [ADR-0040](adr/0040-hourly-buckets-and-pool-pressure.md), delivered by [ADR-0041](adr/0041-observability-stack.md)

> **Implemented, on the ADR-0041 observability branch.** As of this branch, both gaps
> below are closed: the `at_capacity` refusal counter lands in `usage_daily`
> (`recordUsageEvent(env, "at_capacity", …)` beside the 503, `workers/api/src/index.ts`)
> exactly as ADR-0040 C.1 says, and as a `session.start` outcome=`at_capacity` point;
> peak concurrency is a `pool.gauge` Analytics Engine point (`reason: "live"`,
> `telemetry/cron.ts#emitPoolGauge`) sampled every 5 minutes by the API worker's `*/5`
> cron and read by Grafana — not the `usage_hourly` D1 table or the `hour` dimension
> this section originally proposed; ADR-0041 superseded both of those in favor of
> Analytics Engine points, which is what actually shipped.

The 5 → 10 decision above was made without the number that should have decided
it. Daily totals cannot yield peak concurrency (13,237 sessions over 30 days
averages 0.35 concurrent, and the pool was full anyway), and `at_capacity`
refusals were never counted server-side at all — only budget denials reach
`usage_daily`. The evidence was a Sentry issue and an argument.

ADR-0040 instruments three signals, deliberately kept separate because none of
them substitutes for another:

| signal | how | what it answers |
|---|---|---|
| `at_capacity` refusals | a counter beside the 503 | "is the pool too small?" — the decision-relevant one |
| awake-seconds per hour | bucket the existing meter flush | "when is it busy?" |
| peak concurrency | a `*/15` cron sampling `awakeCount` | "how close to the cap did we get?" |

Summed awake-seconds cannot distinguish ten sequential sessions from ten
simultaneous ones, and only the second exhausts the pool — which is why
concurrency is sampled rather than derived. The sampler in turn can miss a spike
shorter than its interval, which is why the refusal counter is not optional.

**Retention differs from the daily counters.** Hourly rows are 24x daily ones,
so they are pruned on their own shorter window rather than riding
`ANALYTICS_RETENTION_DAYS` (180) — peak-hour analysis is a recent-weeks
question. `cost_ledger` stays day-keyed regardless: its contract is that a
`billing` row outranks the `estimate` row for the same `(day, sku)`, and
Cloudflare reconciles per day, so an hour-keyed ledger could never be reconciled.

**None of this can be backfilled.** The counters we have are daily and the raw
events were never stored, so hour data starts at deploy — the panel labels the
collection start date so a partial first day is not misread as a quiet one.

Ranked by what is actually unbounded:

1. **Container egress** — every dev-server asset and HMR frame of a Tier-2
   preview is proxied out of the container, so egress scales with live-session
   traffic rather than with the container count.
   1 TB included, then $0.025/GB; $1,000 is 40 TB.
2. **Workers Logs** — full-fidelity logging during exactly the traffic spike you
   want to survive cheaply. 20M events included, then $0.60/M.
3. **R2 growth** — slow burn, not a spike. $0.015/GB-month.
4. **Containers** — already capped, see above.

### Calibrating the estimator

The estimator was checked against **Billing → Billable usage** after the first
few days of real traffic, and two things came out of that comparison — both
still worth re-checking whenever the traffic shape changes:

- **Container CPU runs far below the 35% utilisation the estimator assumes**, so
  the CPU term is conservative by several multiples. That is the safe direction,
  and CPU is a small part of the bill anyway.
- **Workers requests are the next allowance to cross**, ahead of egress. Which is
  exactly why the meter counts requests.

## Layer 1 — Cloudflare Budget alerts (dashboard only)

**Manage Account → Billing → Billable Usage → Set Budget Alert.** There is no
API for this in the Cloudflare MCP surface, so it is a dashboard action. Alerts
are set at a few fractions of the ceiling (20% / 50% / 80%) and mail a role
address, not an individual.

What they do and don't do:

- **Informational only. They cap nothing.** That is why layer 3 exists.
- **Account-level**: everything billing to the account counts toward the same
  threshold, not just the runner. In practice the rest of the account
  contributes almost no usage-based spend, so they behave like runner alerts —
  worth re-checking if that changes.
- Fire on **projected** monthly spend, recomputed **daily**, once per billing
  cycle per threshold. Usage is a day in arrears, so expect ~24h lag.
- Exclude the Workers Paid subscription fee; usage-based spend only.
- Aligned to the **billing cycle**, not the calendar month (the in-app ledger
  uses the calendar month — they can disagree for a few days around the
  boundary).
- Delete or retune Cloudflare's auto-created default $10 alert, or it fires every
  cycle and becomes the alert everyone learns to ignore.

Worth adding alongside: per-product usage notifications for Workers and R2,
which fire on unit thresholds and so react faster than the daily rollup.

## Layer 2 — configuration

In `wrangler.jsonc`:

| Setting | Why |
|---|---|
| `observability.head_sampling_rate: 0.1` | Bounds Workers Logs. Sentry, not Workers Logs, is the fault channel. |
| `limits.cpu_ms: 30000` | Backstop for a runaway invocation, stated rather than defaulted. |
| `triggers.crons: ["17 4 * * *"]` | Nightly reconciliation + optional artifact GC. |
| `BUDGET_*` vars | The ceiling and its thresholds (below). |
| `max_instances` 10/5 | It is the container cap; see the arithmetic above. |

`sleepAfter` stays at 5m for live sessions (10m on the builder, which only ever
matters if `runBuild`'s teardown never runs). Given the arithmetic above this is
a UX decision, not a cost lever.

## Layer 3 — the ceiling the Worker enforces itself

Cloudflare offers no hard spend cap, so the ceiling is ours to hold.

### Tiers

Thresholds are **absolute dollars** and **editable from the admin panel** — no
deploy needed. The `BUDGET_*` vars in `wrangler.jsonc` are only the defaults
that apply until someone saves an override. Expressed as a fraction of the
ceiling:

| Tier | Default | Behaviour |
|---|---|---|
| `ok` | <60% | Normal. |
| `warn` | ≥60% | Notice in the authoring UI. Everything still works. |
| `anon_blocked` | ≥80% | Live sessions require a Handsontable sign-in. |
| `new_blocked` | ≥95% | No new live sessions and no builds. Running sessions finish. |
| `closed` | ≥100% | Running sessions are destroyed on their next keepalive. |

The server rejects a save whose tiers are out of order (notice ≤ sign-in ≤
no-new ≤ close) or above the ceiling, because an unreachable tier is a
guardrail that silently does less than the panel says it does. Overrides are
stored in `runner_settings` with who changed them and when; **Reset to
defaults** drops back to the committed config.

**Static shares (`/d/:id`, `/embed/:id`) and R2 artifact reads are never gated.**
They are the degradation path and must survive `closed`.

### How spend is measured

`cost_ledger` (D1, migration `0003`) holds one row per `(day, sku, source)`:

- `source='estimate'` — metered by the Worker: container awake-seconds
  (`src/budget.ts`), proxied response bytes, request counts.
- `source='billing'` — written nightly from Cloudflare's GraphQL Analytics API.

A `billing` row wins over the `estimate` row for the same `(day, sku)`, so drift
self-corrects within 24h instead of compounding.

Estimates deliberately round *against* us (container CPU is priced at 35%
utilisation; allowances such as the 1 TB egress and 10M requests are not
deducted). Under-billing ourselves is the failure mode that matters.

Known gaps, by design:

- Container compute has no public per-account analytics dataset, so `container`
  stays an estimate — it is also the SKU Cloudflare already caps.
- The `llm` SKU (the Ask AI assistant, DEV-2047) is metered from the
  `x-litellm-response-cost` header the gateway returns, so it is a real figure
  rather than an estimate — but it is still written as `estimate`, because a
  `billing` row must always mean "Cloudflare said so".
- Egress counted in-Worker excludes WebSocket/HMR frames; the nightly job's
  `responseBodySize` figure covers them.
- A session abandoned without a clean teardown under-counts by at most one idle
  window.

### Rollout

`BUDGET_ENFORCE` is `"0"` on merge: tiers are computed and logged
(`[budget] would deny …`) but nothing is refused. Compare the metered figures
against the Billable Usage dashboard for a week, then turn enforcement on with
the checkbox in **/admin → Guardrail settings** (no deploy). Changing the
committed default instead means editing `wrangler.jsonc` and deploying.

### Nightly job

```bash
# read-only token: Account -> Account Analytics -> Read. Nothing else.
cd runner/workers/api
npx wrangler secret put CF_ANALYTICS_TOKEN
```

Without the secret the cron logs and skips, and the estimator stays in charge.
The job also prunes ledger rows older than 400 days and, when
`BUDGET_R2_GC_DAYS > 0`, deletes the R2 artifacts of demos revoked longer ago
than that (plus their `build_cache` rows, so a cached build can never be
"reused" into an empty demo). It is `0` — off — by default because it deletes
bytes.

> The DEV-2030 brief expected an unbounded per-version `node_modules` cache in
> R2. There isn't one: dependencies are baked into the container image and R2
> holds only share artifacts, which are immutable by design (ADR-0006). Revoked
> demos are the only thing in the bucket that is safe to expire, which is why
> the GC targets exactly those rather than a bucket lifecycle rule.

### In-app spend alerts

Separate from Cloudflare's. `alertsUsd` (defaults in `BUDGET_ALERTS_USD`,
editable in the panel) fires on **this runner's metered spend**, once per threshold per month,
via Sentry and the Worker log. On a shared account that is the difference
between "the account is spending money" and "the runner is".

## The admin panel

`/admin` on the authoring app (login-gated, same broker identity as `/edit`).
One authenticated call to `GET /api/admin/usage?days=N` renders:

- month-to-date spend against the ceiling, current tier, and whether the
  guardrail is enforcing or observing;
- **the guardrail settings form** — ceiling, all four tiers, alert thresholds
  and the enforcement switch, saved through `PUT /api/admin/settings`;
- spend per SKU, split estimate vs reconciled, so it is obvious which numbers
  are still guesses;
- **audience analytics** (below), and an **AI assistant** section covering the
  chat feature's usage, acceptance rate and spend (see `example-chat.md`);
- daily spend and daily activity (sessions started, builds, share/embed views,
  sessions refused by the guardrail);
- **peak time** — hour-of-day breakdowns, both collapsed across the window
  ("the busiest hour is 14:00 UTC") and as an hour-by-hour timeline;
- **pool pressure** — `at_capacity` refusals and sampled peak concurrency
  against `Sandbox.max_instances` (see below);
- live sessions with their awake time and running cost;
- demo inventory by framework and the most-viewed shares.

## Audience analytics — what is and isn't collected

A simplified analytics view: views, unique visitors, top pages and demos,
referrers, countries, devices, browsers, languages. Built to be useful for
capacity and product decisions and useless for tracking anyone.

**Collected** (all bucketed at write time into `analytics_daily`, one row per
day/dimension/value):

| Dimension | Value |
|---|---|
| `views` | count of page views |
| `page` | normalised path — `/d/:id`, `/embed/:id`, `/edit/:id`, `/share/:id`, `/`, `/admin`, `/other` |
| `demo` | demo id, for shared/embedded demos |
| `referrer` | referring **hostname** only, or `direct` / `internal` |
| `country` | two-letter code from the Cloudflare edge |
| `device` / `browser` / `os` | three to six coarse buckets each |
| `language` | primary subtag (`en`, `pl`, …) |
| `hour` | *planned, not implemented* — hour of day; delivered as an Analytics Engine point per ADR-0041, not as a D1 row |
| `bot` | requests identified as bots, excluded from every other bucket |

**Never stored:** cookies or any client-side id, IP addresses, user-agent
strings, full URLs or query strings, per-request rows of any kind.

**Unique visitors** come from `SHA-256(daily random salt + IP + user agent)`,
truncated, stored in `analytics_visitors` as one row per (day, hash). The salt
lives in KV for ~48h and is then gone, so the hashes cannot be re-derived from
a known IP afterwards and cannot be joined across days. A returning visitor
therefore counts once per day and is unrecognisable tomorrow — that is the
intended trade, not a limitation to fix. Visitor rows are deleted after
`ANALYTICS_RETENTION_DAYS` (180).

The authoring app is a separate Worker, so its views arrive via
`POST /api/beacon` with a path and nothing else; the server normalises even
that into the label set above. The nightly job folds one-hit referrer
hostnames into `other`, so a crawler inventing `Referer` headers cannot grow
the table.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/budget` | public (details for signed-in) | Tier + user-facing notice; drives the UI banner. |
| `POST /api/beacon` | public | One anonymous page view from the authoring app. |
| `GET /api/admin/usage?days=N` | broker token | Everything the panel renders. |
| `GET /api/admin/settings` | broker token | Effective thresholds + whether they are an override. |
| `PUT /api/admin/settings` | broker token | Change ceiling / tiers / alerts / enforcement. |
| `DELETE /api/admin/settings` | broker token | Revert to the `wrangler.jsonc` defaults. |

## Open decisions

- **Account placement.** The runner shares the main account, so the first alert
  threshold is diluted by everything else billing there. Moving it to the PoC Sandbox
  account would make both the alerts and the blast radius clean, but that is a
  migration and a bigger call than DEV-2030.
- **Anonymous live editing.** `anon_blocked` assumes signing in is an acceptable
  fallback. If it isn't, that tier collapses into `new_blocked`.
- **$1000 vs reality.** Containers cap structurally at ~$863 since DEV-2909, so
  a $1000 in-app limit is still most likely to be tripped by egress or logs —
  which is why the meter counts those SKUs and not just container-seconds — but
  containers are no longer arithmetically incapable of reaching it. If the pool
  is raised again, either re-price the instance type or accept that the tiers,
  not `max_instances`, are the cap.
