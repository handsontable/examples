# ADR-0040: Hour-of-day buckets, and measuring pool pressure

**Status:** Accepted (extends [ADR-0022](0022-self-enforced-spend-ceiling.md))

## Context

`/admin` can say what happened yesterday. It cannot say *when*, and it cannot
say how close the container pool came to full.

Both gaps have the same root: every counter in the runner is bucketed by **UTC
day at write time**. `usage.ts:36` is `new Date().toISOString().slice(0, 10)`,
`usage_daily` is keyed `(day, metric, dimension)`, `analytics_daily` is keyed
`(day, dimension, value)`, and `cost_ledger` is keyed `(day, sku, source)`.
Nothing anywhere records an hour.

That was the right default. ADR-0022 chose write-time aggregation because an
events table would be, in the words of `usage.ts:8-10`, "both a privacy
liability and a D1 write amplifier on the `/d/:id` path". Nothing here reopens
that decision — per-request rows stay banned. The question is only whether the
*bucket* can be finer than a day.

Two things forced the question:

1. **Capacity planning has no time axis.** DEV-2909 raised
   `containers.max_instances` from 5/3 to 10/5 after the pool started refusing
   visitors. The evidence for that raise was a Sentry issue (DEMOS-33) plus a
   month of daily totals, from which peak concurrency simply cannot be derived:
   13,237 sessions in 30 days averages 0.35 concurrent, and the pool was
   nevertheless full. Daily totals hide the shape of the day entirely.
2. **`at_capacity` refusals are not counted at all.** `recordUsageEvent(env,
   "session_denied", …)` fires only for budget-gate denials
   (`index.ts:754`). The capacity refusal beside it (`index.ts:936`) records
   nothing server-side — the only trace a visitor was turned away is a
   client-side Sentry event. The single most decision-relevant number in the
   system is the one we do not keep.

## Decision

### A. Hour-of-day for page views rides the existing schema, at no cost

`analytics_daily` is `PRIMARY KEY (day, dimension, value)` (migration `0004`).
A new `dimension='hour'` with `value='00'…'23'` therefore needs **no
migration** — the table is already generic over dimensions.

It also answers both questions people actually ask, because `day` is already a
column:

| query | answers |
|---|---|
| `GROUP BY value` | "our peak hour is 14:00 UTC" — the window collapsed into 24 buckets |
| `GROUP BY day, value` | the hour-by-hour timeline across the window |

Cost is one extra in-memory `bump()` in `notePageView` (`analytics.ts:159`,
alongside the existing `bump("os", …)` / `bump("language", …)` calls at
`analytics.ts:188-189`). A page view already costs **zero** D1 writes — counts
accumulate in the isolate and flush at `FLUSH_AT_EVENTS = 100`
(`analytics.ts:26`) — so this adds no write per view and at most 24 extra
distinct keys per flush batch. Storage grows by ≤24 rows/day.

### B. Sessions and builds need one new table

`usage_daily.dimension` already carries the framework, so hour cannot be
overloaded onto it without making the column mean two things. A new additive
table instead:

```sql
CREATE TABLE IF NOT EXISTS usage_hourly (
  day    TEXT NOT NULL,     -- YYYY-MM-DD (UTC)
  hour   INTEGER NOT NULL,  -- 0-23 (UTC)
  metric TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  ...
  PRIMARY KEY (day, hour, metric)
);
```

Forward-only and `IF NOT EXISTS`, in the style of `0007_build_status.sql`.
Growth is bounded by metrics × 24 rows/day. Note this table deliberately drops
the `dimension` breakdown that `usage_daily` keeps: hour × metric × framework is
more cells than the question needs, and `usage_daily` still answers
"which framework".

### C. Pool pressure is three signals, and they are not interchangeable

This is the part most likely to be got wrong by measuring one thing and
believing it says something about another.

**1. `at_capacity` refusals — a counter.** The cheapest of the three and the
most valuable: it is the direct answer to "is 10 enough". A
`recordUsageEvent(env, "at_capacity", framework)` beside the existing 503 at
`index.ts:936`, mirroring the `session_denied` call the budget gate already
makes. No new mechanism at all.

**2. Awake-seconds per hour — cheap, and derivable.** Every
`recordContainerUsage` flush already happens with a timestamp; bucketing it by
hour costs nothing extra. It goes in `usage_hourly`, **not** in `cost_ledger`.
The ledger must stay day-keyed, because its whole contract is that a
`source='billing'` row outranks the `source='estimate'` row for the same
`(day, sku)` — Cloudflare reconciles per day, so an hour-keyed ledger could
never be reconciled.

**3. True peak concurrency — needs point-in-time sampling.** Summed
awake-seconds cannot distinguish ten sessions running six minutes each in
sequence from ten running at once. Only the second exhausts the pool, and they
produce the identical number. So concurrency has to be *sampled*, not summed.

The sample itself is nearly free: `readMeters` (`admin.ts:121`) already scans
the whole `session-meter:` prefix with one `KV.list()` and zero `get`s, and
`liveSessions` (`admin.ts:187`) already derives `awakeCount` from it
(`admin.ts:205`). `/admin` computes that number on every load and throws it
away. What is missing is only a scheduler.

Cloudflare accepts multiple expressions in one `triggers.crons` array, so add
`*/15 * * * *` beside the nightly `17 4 * * *` (`wrangler.jsonc:23`) and branch
on `controller.cron` in `scheduled()` (`index.ts:2217`), which today ignores its
controller argument entirely.

**Stated honestly: a 15-minute sample can miss a shorter spike.** A pool that
fills and drains inside one interval is invisible to it. That is why signal 1
exists and is not optional — the refusal counter catches exactly the spikes the
sampler misses, and the two together are the evidence base. Neither alone is.

### D. Hour buckets do not weaken the privacy property

Worth stating with the reason, not as an assertion, because "we added a
time dimension to the analytics" is the shape of a change that usually *does*
erode anonymity.

`analytics_daily` holds one row per `(day, dimension, value)`. Dimensions are
**never crossed** — the schema cannot express `country × hour × browser`, which
is precisely the combination that would narrow a bucket to one person. Each
`bump()` is independent, and adding `hour` adds a 24-value bucket, not a join
key. A row saying "37 views happened in the 14:00 hour" is not attributable to
anyone.

The `AGENTS.md` rule — analytics anonymous by construction, no cookies, no IPs,
no user agents, no query strings, no per-request rows — therefore holds
unchanged, and this ADR does not amend it.

## Consequences

- **No backfill, ever.** The 30 days of history we have are daily totals; the
  raw events behind them were never stored, by design. Hour data begins at
  deploy. The panel must show "collecting since &lt;date&gt;" so a partial first
  day is not read as a real trough — an empty bucket and a genuinely quiet hour
  look identical otherwise.
- **Hourly rows are 24× daily rows**, so they need their own retention rather
  than riding the existing 180-day `ANALYTICS_RETENTION_DAYS`
  (`wrangler.jsonc:85`). `pruneAnalytics` (`analytics.ts:311`) gains a shorter
  hourly window; peak-hour analysis is a recent-weeks question, not a
  year-scale one.
- **The `*/15` trigger is the first non-nightly periodic job in the runner.**
  Everything scheduled today either reconciles or prunes once a day; every other
  flush is opportunistic, piggybacked on request traffic. A job that runs 96
  times a day is a new operational shape, and its own failure mode: if it throws,
  it does so 96 times a day into Sentry.
- **`at_capacity` becomes a first-class metric**, which means the next
  `max_instances` decision has a number behind it instead of a Sentry issue and
  an argument. That is the point of the whole ADR.
