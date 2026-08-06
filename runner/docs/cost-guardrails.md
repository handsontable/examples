# Cost guardrails

How the demo runner is stopped from running up a surprise Cloudflare bill
(DEV-2030). Decision record: [ADR-0022](adr/0022-self-enforced-spend-ceiling.md).

Everything below applies to the main Handsontable account
`15111272c53ed0aaf84a908f0c9c7f8b`.

## What was already bounded, and what was not

`runner/workers/api/wrangler.jsonc` caps containers:

```jsonc
"containers": [
  { "class_name": "Sandbox",        "instance_type": "standard-1", "max_instances": 5 },
  { "class_name": "BuilderSandbox", "instance_type": "standard-1", "max_instances": 3 }
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
| Sandbox (5) | 3,650 | $139 – $270 |
| BuilderSandbox (3) | 2,190 | $83 – $162 |
| **Both saturated** | **5,840** | **$222 – $432** |
| + container Durable Object duration | | ~$28 |
| **Ceiling** | | **~$250 – $460/mo** |

So `max_instances` is a real, Cloudflare-enforced cap sitting at roughly 25–45%
of the $1000 line. **Leave it at 5/3** — raising it is the one change that
invalidates this table.

Ranked by what is actually unbounded:

1. **Container egress** — every dev-server asset and HMR frame of a Tier-2
   preview is proxied out of the container, and `POST /api/session` is public.
   1 TB included, then $0.025/GB; $1000 is 40 TB.
2. **Workers Logs** — full-fidelity logging during exactly the traffic spike you
   want to survive cheaply. 20M events included, then $0.60/M.
3. **R2 growth** — slow burn, not a spike. $0.015/GB-month.
4. **Containers** — already capped, see above.

### Measured baseline (2026-08-06)

From **Billing → Billable usage**, cycle Aug 4 – Sep 3 2026, 3 days observed:

| | |
|---|---|
| Total cost so far | **$1.27** |
| Projected cycle cost | **$13.11** |
| Average daily | $0.42 |

The entire billable amount is *our* containers (memory $1.24, disk $0.03).
Everything else on the account — including the other ~13 Workers — sat inside
its included allowances and contributed **$0**. Two things worth carrying
forward:

- **Container CPU is ~8% utilised**, not the 35% the estimator assumes
  (5.69k vCPU-seconds against ~146k awake container-seconds). The estimator is
  therefore conservative by roughly 4.5× on the CPU term — which is the safe
  direction, and CPU is a small part of the bill anyway.
- **Workers requests are the next line to cross**: 2.06M of the 10M included in
  3 days, i.e. ~21M projected for the cycle, so ~$3/month of overage will start
  appearing. Which is exactly why the meter counts requests.

## Layer 1 — Cloudflare Budget alerts (dashboard only)

**Manage Account → Billing → Billable Usage → Set Budget Alert.** There is no
API for this in the Cloudflare MCP surface, so it is a dashboard action.

**Already created on account `15111272…` (2026-08-06):**

| Alert | Threshold | Recipient |
|---|---|---|
| Usage alert $200 (20% of $1000 ceiling) | $200 | `invoices@handsontable.com` |
| Usage alert $500 (50% of $1000 ceiling) | $500 | `invoices@handsontable.com` |
| Usage alert $800 (80% of $1000 ceiling) | $800 | `invoices@handsontable.com` |

⚠️ A **"Default budget alert (auto-created)" at $10** also exists and was left
alone. Projected spend is $13.11, so **it will fire this cycle**. Delete or
retune it, or it becomes the alert everyone learns to ignore.

What they do and don't do:

- **Informational only. They cap nothing.** That is why layer 3 exists.
- **Account-level**: everything billing to `15111272…` counts toward the same
  $200. Measured, that turns out not to matter — the rest of the account
  currently contributes $0 of usage-based spend, so in practice these behave
  like runner alerts. Re-check the baseline if that changes.
- Fire on **projected** monthly spend, recomputed **daily**, once per billing
  cycle per threshold. Usage is a day in arrears, so expect ~24h lag.
- Exclude the $5 Workers Paid subscription fee; usage-based spend only.
- Aligned to the **billing cycle**, not the calendar month (the in-app ledger
  uses the calendar month — they can disagree for a few days around the
  boundary).
- Delete or retune any auto-created default $10 alert.

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
| `max_instances` unchanged | It is the container cap. |

`sleepAfter` stays at 5m for live sessions (10m on the builder, which only ever
matters if `runBuild`'s teardown never runs). Given the arithmetic above this is
a UX decision, not a cost lever.

## Layer 3 — the ceiling the Worker enforces itself

Cloudflare offers no hard spend cap, so the $1000 line is ours to hold.

### Tiers

Thresholds are **absolute dollars** and **editable from the admin panel** — no
deploy needed. The `BUDGET_*` vars in `wrangler.jsonc` are only the defaults
that apply until someone saves an override.

| Tier | Default | Behaviour |
|---|---|---|
| `ok` | <$600 | Normal. |
| `warn` | ≥$600 | Notice in the authoring UI. Everything still works. |
| `anon_blocked` | ≥$800 | Live sessions require a Handsontable sign-in. |
| `new_blocked` | ≥$950 | No new live sessions and no builds. Running sessions finish. |
| `closed` | ≥$1000 | Running sessions are destroyed on their next keepalive. |

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

Separate from Cloudflare's. `alertsUsd` (default `200,500,800`, editable in the
panel) fires on **this runner's metered spend**, once per threshold per month,
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
- **audience analytics** (below);
- daily spend and daily activity (sessions started, builds, share/embed views,
  sessions refused by the guardrail);
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

- **Account placement.** The runner shares the main account, so the $200 alert
  is diluted by everything else billing there. Moving it to the PoC Sandbox
  account would make both the alerts and the blast radius clean, but that is a
  migration and a bigger call than DEV-2030.
- **Anonymous live editing.** `anon_blocked` assumes signing in is an acceptable
  fallback. If it isn't, that tier collapses into `new_blocked`.
- **$1000 vs reality.** Containers cap structurally at ~$460, so a $1000 in-app
  limit will realistically only ever be tripped by egress or logs — which is
  exactly why the meter counts those SKUs and not just container-seconds.
