# ADR-0041: Observability on Cloudflare — a sleeping Loki + Grafana box, OTLP inward, Sentry for uncaught errors

**Status:** Proposed — design approved 2026-09-23 (revision 3); becomes Accepted when every exit criterion in §L passes. Supersedes ADR-0040 decisions A, B, C.2 and C.3; amends ADR-0022 (o11y spend cap, per-script billing rows), ADR-0038 (WAF exception extended to `/telemetry/*`); deviates from ADR-0007 for the operator UI; adds routes under ADR-0020. ADR-0042 ships with this ADR; ADR-0043 follows after launch.

## Context

The runner reports faults through Sentry and nothing else. Both SDKs run errors-only,
Workers Logs keeps seven days at a 10 % head sample, and every number the team looks
at is a D1 counter aggregated at write time (`usage_daily`, `analytics_daily`,
`cost_ledger`) and rendered by `/admin`. There are no traces, no metric history, no
browser performance data, and the only join between a Sentry issue and a Worker log is
the `cf-ray` header, promoted to a Sentry tag by hand.

The missing thing is the ability to answer, from data, the questions the runner is run
on: how long an example takes to show a grid, by tier and Handsontable major; how full
the container pool is at 14:00 UTC; whether the last release raised compile errors on
the `next` bucket; what the AI assistant costs per answer; which docs guides people
reach for a live example of (ADR-0042).

Constraints:

1. **Self-hosted, on Cloudflare, next to the app**, in the main account (ADR-0010). No
   VPS, no Grafana Cloud, no SaaS beyond Sentry.
2. **OpenTelemetry protocol as the contract** from the Worker inward.
3. **Grafana as the UI, Grafana Faro as the browser SDK.**
4. **Sentry stays connected for uncaught errors**, and those errors also land in the new
   stack.
5. **Cost at app scale.** The runner's containers cost $1–13 a month because they sleep;
   observability follows the same pattern.
6. **Anonymous by construction** stays in force for analytics (`analytics.ts`,
   AGENTS.md). Operational logs are governed by the explicit rule in §E.4.
7. **Deploy only after localhost tests**, from one feature branch (decision 2026-09-23).
   Facts that exist only on real Cloudflare are measured with throwaway probes on the
   sandbox account, never the production account (§L).

Platform facts that shaped the design (verified 2026-09-22/23, including Loki, Sentry
and Faro source):

- **Workers tracing and export** (open beta): auto spans for fetch, D1, KV, R2, DO,
  handlers, RPC; custom spans via `tracing.enterSpan`; OTLP export of traces and logs to
  any endpoint with custom headers. From 2026-10-01 spans are billed as events **in the
  same 20 M/month Workers Logs pool** as log lines, and export includes **10 M events per
  signal**. No `spanContext()`, so no browser-to-worker `traceparent` join. No metrics
  export. Sampling is per invocation and per Worker, never per route. Export retry
  semantics are undocumented. Fetch-handler spans carry `url.full`,
  `user_agent.original`, city and ASN; preview hostnames carry the sandbox token.
- **Workers Logs**: every sampled invocation writes an invocation log plus each
  `console.*` line; `observability.logs.invocation_logs: false` removes the former. The
  Sandbox SDK logs a warning on every request to a stale preview URL, and Tier-2
  container stdout lands in the API worker's logs.
- **Containers** bill CPU on use and memory/disk on provisioned size, nothing while
  asleep. Disk is ephemeral. Inbound only via Worker/DO. `jurisdiction: "eu"` placement
  exists since 2026-04-05. `onStop` reports a host loss the DO did not observe as
  `{ exitCode: 0, reason: "exit" }`, indistinguishable from a clean exit. Cloudflare
  "does not guarantee that any container instance will run for any set period of time."
- **R2** is S3-compatible; EU jurisdiction on buckets; lifecycle rules work by key prefix.
- **Loki 3.x** ingests OTLP natively and synchronously; `otlp_config` can label only
  **resource** attributes. Query-time dedupe needs same stream, same timestamp, same line
  **and** same structured metadata (`TestMergeIteratorNoDedupDifferentStructuredMetadata`),
  and metric queries dedupe only across iterators, so two copies inside one chunk are
  both counted. When an OTLP record has no timestamp, Loki stamps `time.Now()`.
  `POST /flush` returns before anything is written. The TSDB index head rotates every
  15 minutes and uploads afterwards. The compactor rewrites index only, and its retention
  markers live on local disk. Default push limits are 4 MB/s with a 6 MB burst;
  `shard_streams` is on by default with shard numbers from in-memory state;
  `query_ingesters_within` defaults to 3 h.
- **Grafana Faro** v2.12: `faro.receiver` stamps every entry with `time.Now()`, answers 202
  even when its exporter fails, drops after a 2 s timeout, rate-limits at 50 req/s, and
  looks maps up by URL path. `persistent: false` session tracking uses `sessionStorage`.
  The Performance and CSP instrumentations send full URLs with query strings.
- **Workers Analytics Engine**: 20 blobs + 20 doubles + 1 index per point, 3-month
  retention, 10 M data points and 1 M read queries per month included (currently not
  billed), SQL API; it samples at write time and read time (`_sample_interval`).
  Grafana reads it through the Altinity ClickHouse plugin. No local emulation.
- **Sentry**: Team plan, so issue-alert webhooks only, no per-event `error.created`. The
  API worker's fetch catch-all converts every throw into an explicit `captureException`
  plus a 500, and the snapshot-job alarm reports without rethrowing, so almost no Worker
  error is "uncaught" in the SDK's sense. Spend alerts reach anyone only through
  `Sentry.captureMessage` in `reconcile.ts`. React 19 render crashes caught by
  `Sentry.ErrorBoundary` never reach `window.onerror`.
- **Edge**: the zone rule behind ADR-0038 403s any body containing `<script` outside
  `/api/*`; `workers_dev` defaults to on and bypasses zone rules.

Alternatives considered and rejected:

- **VPS with the LGTM stack** — outside constraint 1.
- **Serverless store (Pipelines → Iceberg → R2 SQL)** — no LogQL, two open-beta
  services. Kept as the escape hatch (§L).
- **Cloudflare's own Workers Observability as the store** — 7-day, non-EU, not Grafana.
  Kept as the temporary safety net (`persist: true`, §H).
- **Alloy with `faro.receiver` in the box** (revision 2's design) — `time.Now()`
  stamping makes every browser record land at drain time and never dedupe on re-replay;
  202-on-failure makes the drain's ledger lie; its rate limit refuses backlog replays; its
  path-based map lookup breaks per-release storage. Once the Worker converts Faro to
  OTLP itself (§C.1), Alloy has nothing left to do: the drain pushes straight to Loki.
- **Vanilla OpenTelemetry JS in the browser** — experimental SDKs, no bundled error or
  vitals capture. Faro stays as the capture SDK; only its wire format stops at the Worker.
- **Mimir** — a WAL on ephemeral disk and ingestion only while awake. Analytics Engine
  ingests while the box sleeps.
- **Tempo, and exporting traces at all, in the first release** — no browser join exists,
  span attributes carry URLs, user agents, geo and preview tokens, and spans compete with
  logs for the same 20 M pool. Deferred (§C.4).
- **A Queue in front of the inbox** — billed per message operation and a second write
  path next to the inbox Durable Object, which already batches.
- **Self-hosted Sentry or GlitchTip**; **`@microlabs/otel-cf-workers`** — not the Grafana
  stack; deprioritised by its maintainer.

## Decision

### A. One sleeping box: Loki + Grafana in a Container; R2 is the store

A new Worker `handsontable-demos-o11y` (`workers/o11y/`, own `wrangler.jsonc` with
`workers_dev: false` and `preview_urls: false`, own deploy job) owns two Durable Object
classes: `InboxWriter` (§B) and `GrafanaBox`, a Container class running **Loki and
Grafana** on `standard-1`, pinned with `jurisdiction: "eu"`. There is no collector in the
box.

- **Loki**, single binary, TSDB single store in an EU R2 bucket, two tenants:
  `browser` (browser and beacon streams) and `worker` (Worker streams). Configuration in
  §B.4.
- **Grafana** served from `/grafana/`, provisioned from git (one Loki datasource per
  tenant via `X-Scope-OrgID`, the Altinity plugin against the Analytics Engine SQL API,
  dashboards), `auth.proxy` behind the Worker (§B.5), **Grafana Live disabled**, sqlite
  state disposable.
- **Secrets reach the container** only as `envVars` set by `GrafanaBox` at start from
  Worker secrets (`LOKI_S3_*`, `AE_SQL_TOKEN`). The Slack webhook never enters the box.

**Wake.** Two triggers only:

1. A Grafana visit through Access. The Worker renews the activity timer only on HTTP
   requests to `/grafana/*`; the box stops after 15 idle minutes, and after 4 hours awake
   regardless (the next request shows the waking page).
2. A backlog: a `*/10` cron in the o11y worker asks `InboxWriter.backlog()` and wakes the
   box when the oldest uncommitted object is older than 60 minutes or the backlog exceeds
   64 MB. The cron never wakes the box when drains are paused (§G).

**Stop protocol**, the same for every stop the Worker initiates: the drain finishes; if
no Grafana request arrived in the last 10 minutes the Worker calls `stop()` (otherwise
the idle timer does, later, so a drain never SIGTERMs someone reading a dashboard); the
container's shutdown script stops Loki gracefully, confirms the index is uploaded to R2,
and only then writes a **clean-shutdown marker** `state/wakes/<wakeId>/clean` into the Loki
bucket, the one bucket its credentials reach. The o11y worker reads `state/` through an R2
binding on the same bucket; no lifecycle rule touches that prefix except a 30-day expiry.
The marker, not `onStop`, is what the ledger trusts (§B.3).

**Waking page**: the Handsontable logo, one line of text, `<meta http-equiv="refresh"
content="3">`, no script, served by the Worker while the box is not ready.

**Cost model**: drain wakes × measured drain-wake duration + visit hours, at
$0.038–0.074 per awake hour on `standard-1`. The target is ≈ $5–8/month at current
traffic; exit criterion L.7 recomputes it from the measured drain-wake duration and
fails above $10.

### B. Ingest never waits for the box

**B.1 Routes**, all owned by the o11y worker on the main hostname, passed as `--routes`
flags (ADR-0020), beside the API worker's `/api/*`, `/d/*`, `/embed/*`:

| Route | Source |
|---|---|
| `POST /telemetry/collect` | Faro from the authoring app |
| `POST /telemetry/lite` | lite beacon from `/d` and `/embed` |
| `POST /telemetry/v1/logs` | Cloudflare OTLP log export |
| `POST /telemetry/deploy` | CI deploy events |
| `POST /telemetry/hooks/sentry` | Sentry issue-alert webhook |
| `/grafana/*` | Grafana, waking page |
| `POST /grafana/_o11y/reopen` | manual ledger re-open (§B.3) |

ADR-0038's WAF exception is extended from `/api/*` to `/telemetry/*`: Faro errors and
Sentry payloads legitimately contain `<script`. The compensating controls are the gates
in §B.5.

**B.2 `InboxWriter`: one owner of the inbox lifecycle.** One instance, named `main`,
addressed through `.jurisdiction("eu")`. The CPU-heavy steps run in the **stateless route
handler**, so ingest is not serialised through one object; `InboxWriter` only checks,
stores and packs. For each accepted request, in this order:

1. **Decode and scrub** in the route handler into OTLP log records (§C.1): convert Faro
   and beacon payloads; decode Cloudflare's export (protobuf or JSON, whichever spike (b)
   observes); keep only allowlisted attributes; hoist `hot.*` and `service.*` to resource
   attributes; run the server-side scrubber (§E.4). Nothing derived from the arrival time
   is added yet. Records over 256 KB are dropped.
2. **Hash** each record (SHA-256) at this point, before any arrival-time value exists, so
   a redelivered body hashes identically.
3. **Stamp** timestamps (§C.2), which may use the arrival time as a clamp or fallback.
   The arrival time itself never becomes part of a stored record; `InboxWriter` keeps it
   on the storage row.
4. **Deduplicate** in `InboxWriter`: each hash is checked against a 24-hour set in DO
   storage; a record already seen is dropped. This is what makes a duplicate Cloudflare
   delivery a non-event.
5. **Append** the records to DO SQLite storage in rows of at most 1 MB, and answer `2xx`
   only after the transaction commits. Nothing is held in memory across requests.
6. **Pack**, from a 60-second alarm or at 4 MB stored: write one gzipped NDJSON object
   per tenant to `inbox/<tenant>/<yyyy-mm-dd>/<hh>/<seq>.ndjson.gz`, where `<seq>` is a
   counter persisted in DO storage, incremented in the same transaction that records the
   key, zero-padded to 12 digits. The key's state is recorded as `written`; the packed
   rows are deleted.

One writer means key order equals arrival order; storage-backed buffering means a
deploy, eviction or host restart between two alarms loses nothing.

Analytics Engine points for browser metrics are written by the route handler after step 3
(§F.1), so they exist while the box sleeps. `example.*` events (ADR-0042) produce Analytics Engine points only
and are never packed into the inbox. The exact first-seen registry for error fingerprints
(§F.3) is updated at step 4.

**B.3 Drain and ledger.** The ledger lives in `InboxWriter` storage, next to the keys it
describes, so backlog and state are readable without starting the container. Each key is
`written` → `provisional(wakeId)` → `committed`, or `rejected`.

- **At each cron tick and at the start of each wake**, `InboxWriter` resolves every wake
  that still owns provisional keys and is **over** — a newer `wakeId` has started, or
  `GrafanaBox`'s container state reports it not running: marker present → those keys
  become `committed`; marker absent → they go back to `written` (re-opened). A wake that is
  still running is left alone. `POST /grafana/_o11y/reopen` re-opens a time window by hand.
- `backlog()` counts only `written` keys, after that resolution step, so a box kept awake
  by a visitor never triggers wake attempts for its own provisional keys, and a crashed
  wake's keys count again as soon as the crash is noticed.
- **The drain** runs in `GrafanaBox`, as a Durable Object alarm loop that handles a bounded
  number of objects per invocation and reschedules itself, under the o11y worker's
  `limits.cpu_ms` (set to the value spike (b) needs, at most 300 000). It runs only on a
  freshly woken box, before anything else is pushed: it
  replays re-opened keys first, then new `written` keys, in key order, each object's
  records pushed to Loki's `/otlp/v1/logs` with the tenant header in requests of at most
  1 MB decompressed. A key becomes `provisional(wakeId)` only after every one of its
  requests returned `2xx`. `429` and `5xx` are retried with backoff within the wake; a
  `400` (for example `too_far_behind`) is logged with Loki's message, marks the key
  `rejected`, and raises an alert (§F.3). Within one wake, a per-record hash set
  guarantees no record is pushed twice.
- **What an unclean stop costs.** The whole wake's keys are replayed on the next wake.
  Data that Loki had already indexed before the crash is then stored twice, in different
  chunks; queries return it once, because timestamps, labels and structured metadata are
  deterministic (§C.2) and `shard_streams` is off. The duplicate storage stays until R2
  lifecycle deletes it, not until compaction. Re-opening across a Loki configuration or
  label change is not allowed, because it would break that determinism.

**B.4 Loki configuration**: `ingester.wal.flush_on_shutdown: true`;
`limits_config.shard_streams.enabled: false`; `max_chunk_age: 2h` (a 1-hour out-of-order
window, enough because the drain replays in key order into an empty ingester);
`reject_old_samples_max_age: 7d`; `query_ingesters_within: 168h`, so backfilled data is
queryable while the box is awake; `ingestion_rate_mb` and `ingestion_burst_size_mb`
raised to what spike (b) measures, at least 16/32; `max_line_size: 256KB`;
`otlp_config` promoting the `hot.*` resource attributes to labels. **Retention through
R2 lifecycle, not the compactor**: one rule per tenant chunk prefix (`browser` 30 days,
`worker` 90 days) and the index prefix at 90 days, with `max_query_lookback` per tenant so
nothing past retention is queried. For days 31–90 the shared index still lists `browser`
chunks that lifecycle has already deleted; `max_query_lookback: 30d` on that tenant means
no query ever reaches those entries, and the index bytes they cost are negligible, so the
index is not split per tenant. Compactor retention stays off: its markers would live
on ephemeral disk, and `retention_delete_delay` outlasts any wake.

**B.5 Gates**, every route authenticated or gated:

| Route | Gate |
|---|---|
| `collect`, `lite` | `Origin`/`Referer` host is the production host (or `localhost` in the `local` environment), payload environment matches, `BOT_RE` user-agent filter, size caps, item-kind allowlist, unknown attributes dropped, the Workers rate-limiting binding, then the server-side scrubber. `navigator.webdriver` is a browser-side check only (§E.4). |
| `v1/logs` | `x-o11y-secret` header set on the export destination, constant-time compare |
| `deploy` | GitHub OIDC token (issuer, audience, repository, workflow), secret fallback |
| `hooks/sentry` | `sentry-hook-signature` HMAC |
| `/grafana/*`, `reopen` | `Cf-Access-Jwt-Assertion` verified against the Access JWKS in the Worker; a client-sent `auth.proxy` header is stripped |

Every drop writes an `o11y.ingest` point with the gate as the reason.

**B.6 The observer does not observe itself**: the o11y worker exports no Workers Logs and
no traces, with invocation logs off and its own lines persisted in Cloudflare's dashboard
only. Its self-metrics (`o11y.*`) go to Analytics Engine like every other metric, which is
not a loop: they never pass through its own ingest routes.

### C. OTLP from the Worker inward

**C.1 Hops.**

| Hop | Format |
|---|---|
| Authoring app → o11y worker | Faro JSON (the SDK's native transport) |
| Embeds → o11y worker | the §C.5 beacon payload |
| API worker → o11y worker | OTLP logs, Cloudflare's export |
| o11y worker (ingest) | everything normalised to OTLP log records, stored as OTLP JSON in the inbox |
| drain → Loki | OTLP `/otlp/v1/logs`, synchronous |
| metrics | Analytics Engine points, written at ingest by the o11y worker (browser) and directly by the API worker (server) |

**C.2 Attributes, identity and time.** Every record carries `service.name`,
`service.version`, `deployment.environment.name` and the `hot.*` set (`surface`, `tier`,
`framework`, `ht_major`, `outcome`) as **resource attributes**, so Loki can label them;
exit criterion 15 checks that they arrive as labels. The exact names, allowed values and
Analytics Engine slots live in
[`docs/observability-contract.md`](../observability-contract.md).
`hot.demo_id`, `session.id` and `cf.ray` are structured metadata only; never labels, never
Analytics Engine indexes. The user pseudonym, emails, IPs, user-agent strings, query
strings, authored code, chat text and console output are never sent to the o11y stack.

- `session.id` is an in-memory id minted per page load by the app (§E.4). It joins a page
  load's browser records with the API calls that page made (sent as `x-hot-session`); it
  is not a visitor session and does not survive a reload.
- `service.version` is the deploying `GITHUB_SHA` on each deployable. Authoring and API
  deploy independently (path-gated in `master.yml`), so their versions usually differ;
  each deploy job posts `{service, sha, cf_version_id}` to `/telemetry/deploy`, which
  becomes a Loki line and a Grafana annotation.
- **Timestamps are event time, deterministically**: browser item timestamps are clamped
  to the envelope's `received_at` ± 5 minutes; beacon timestamps likewise; OTLP records
  keep `time_unix_nano`, falling back to `observed_time_unix_nano`, then to `received_at`,
  so no record ever reaches Loki without one.

**C.3 Symbolication in the Worker, at drain.** CI uploads the authoring build's maps to
the EU maps bucket under `sourcemaps/<sha>/<original asset path>.map` before deleting
them from `dist` (the Sentry Vite plugin's in-build deletion is turned off; one CI step
uploads to both destinations, then deletes). At drain, for exception records only, the
o11y worker resolves app-chunk frames with `source-map-js` against the map for the
record's `service.version`, parsing lazily per file and caching in the isolate within a
fixed memory budget; frames from the Babel compiler chunk and third-party files are left
as they are. Maps expire with the browser tenant (30 days). Symbolication never runs on
the public ingest route. Exit criterion L.5 bounds its cost.

**C.4 Traces are deferred, and not exported.** No trace destination is configured.
Worker traces are sampled at 1 % into Cloudflare's own dashboard for the 7-day view while
`persist: true` holds (§H). Tempo, and a trace export with a span-attribute allowlist
that removes URLs, user agents, geo and preview hosts, return together when
`spanContext()` makes the browser join real.

**C.5 Lite beacon for `/d` and `/embed`.** The existing ES5 reporter in `monitor.ts` gains
a standalone mode: with no parent runner frame, it sends uncaught errors (up to the
existing ceiling) and sampled web vitals (10 % of page views) with `navigator.sendBeacon`
to same-origin `/telemetry/lite`, under 2 KB per payload. It is injected at the serve seam
in `share.ts` with the `monitor-inject.ts` guards and the DEV-2580 rules (self-removing
tag, no whitespace). Docs pages link with `noreferrer` and send
`strict-origin-when-cross-origin`, so no embed payload carries a docs page path;
embeds are identified by demo id.

### D. Worker signals

- `observability.logs`: `head_sampling_rate: 1.0`, `invocation_logs: false`,
  `persist: true`, `destinations: ["o11y-logs"]`.
- `observability.traces`: `head_sampling_rate: 0.01`, `persist: true`, no destination.
- One structured JSON line per non-proxy request (route class, status, duration,
  `cf.ray`, `session.id`, `hot.demo_id`, `service.version`), replacing the
  bracketed-prefix convention, plus an `api.request` Analytics Engine point. The preview
  proxy path emits nothing per request; stale-preview requests are answered before the
  Sandbox SDK where the code can recognise them, so its per-request warning does not fire.
- Every error that escapes a handler is logged as a structured line **by our code**: the
  fetch catch-all, the snapshot-job alarm's report path, the Durable Object alarms and the
  cron handler. The Worker half of constraint 4 therefore does not depend on how
  Cloudflare exports an uncaught exception with invocation logs off.
- Custom spans (`tracing.enterSpan`) around session start, container boot, snapshot
  build, chat, theme AI, import and payload boot, for the dashboard view.
- A `*/5` cron in the **API worker**, which owns the KV session meters and D1, writes
  `pool.gauge`, `budget.gauge` (tier, percent of ceiling) and checks the o11y heartbeat
  (§F.3).
- **Volume budget** (exit criterion L.8): at current traffic, Workers Logs events (lines
  plus spans) stay under half of the 20 M pool, exported log events under half of the 10 M
  logs allotment, Analytics Engine points under half of 10 M. Tier-2 container stdout is
  counted in the first. Because every count and alert reads Analytics Engine, which is not
  sampled at ingest, lowering the log sampling rate is the fallback that costs text, never
  alerts.
- The comment at `wrangler.jsonc:10-13` ("full fidelity is a spike amplifier") is answered
  by `invocation_logs: false`, the silent proxy path and the budget above, not reversed.

### E. Sentry: what "uncaught" means, what moves, what stays

**E.1 Definition.** Uncaught means an error that escapes a handler:

- **Browser**: `window.onerror`, `unhandledrejection`, and render crashes caught by
  `Sentry.ErrorBoundary`.
- **Worker**: anything that escapes a fetch, alarm or scheduled handler, including errors
  the fetch catch-all turns into a 500 and snapshot-job failures the alarm reports
  without rethrowing.

These stay in Sentry, keep its grouping and regression detection, and also reach the new
stack (§E.2).

**Moves to the new stack only**: diagnostic reports about handled conditions — upstream
failures reported with tags (npm registry, import URL), the preview boot-window report,
`reportError` calls for recoverable UI failures, and demo-runtime preview events. They
become Faro reports or structured lines with an `error.handled` point and lose Sentry's
grouping; the exact new-fingerprint alert (§F.3) replaces its "new issue" signal. The
Outcome of each implementing task lists every call site and its classification.

**Stays in Sentry, unconverted**: the budget-alert `captureMessage` in `reconcile.ts` and
its `rehomeBudgetAlert` hook. It is the spend alert channel.

**E.2 Tee.** Faro's errors instrumentation sees `window.onerror` and rejections;
`Sentry.ErrorBoundary`'s `onError` also calls the facade, so render crashes reach Faro.
Worker errors reach Loki through the structured lines of §D. Sentry's `beforeSend`
pushes the Sentry event id as a Faro event, and the Faro page-load id becomes a Sentry
tag. The issue-alert webhook (new issue, regression, resolved) becomes a Loki line with
issue id, title, release and link.

**E.3 Switch.** The trim ships behind `SENTRY_SCOPE` (API worker var) and
`VITE_SENTRY_SCOPE` (authoring build), both `full` by default, where moved reports go to
**both** Sentry and the new stack. The launch plan flips both to `uncaught` only after
data has been seen end to end in Grafana, alerts have fired once, and volume sits inside
the budget. Until then nothing that reaches Sentry today stops reaching it.

**E.4 Faro configuration and the operational-log rule.**

- Faro: session tracking **disabled**; the facade mints the page-load id in memory and
  sets it on every item; no `user` meta; only the errors and web-vitals instrumentations
  (Performance, CSP, console and view instrumentations off, because they send full URLs
  or console text); transport to same-origin `/telemetry/collect`.
- One scrubber, `scrubTelemetry`, runs in the browser **and authoritatively at ingest**
  for Faro, beacon and OTLP records alike: strip query strings and fragments from every
  URL-valued field; `redactPreviewHosts` on every string; reduce any browser meta to the
  device and browser classes `analytics.ts` uses; remove Babel code frames explicitly
  (`stripCodeFrame`: the gutter-numbered source lines and caret markers), because
  `normalizeMonitorMessage` does not; drop unknown attributes.
- The rule: **operational logs may carry a page-load id, a demo id and a cf-ray as
  structured metadata, and nothing else that identifies a person or a request's content.
  Browser streams are kept 30 days, Worker streams 90 days.** This is a separate class from
  analytics, which keeps its rule unchanged: `example.*` events are counts only and never
  reach Loki.
- Local testing: Faro runs on a local path only when the build was made with
  `VITE_TELEMETRY_LOCAL=1` and the host is `localhost`/`127.0.0.1`, with environment
  `local`. That path checks neither `import.meta.env.DEV` nor `navigator.webdriver`,
  because Playwright serves a production `vite preview` under automation. The production
  gate (`resolveReporting`) is unchanged and stays closed under automation; a post-build
  check fails if the local path survives into a production bundle.

### F. What is metered

**F.1 Store.** Counts and latencies go to Analytics Engine; Loki holds the text. The
positional slot layout and the full metric registry, with allowed outcomes, are in
[`docs/observability-contract.md`](../observability-contract.md) §4–§5; this section
names the signals, the contract fixes their shape. Every
count is `SUM(_sample_interval * count)`, every percentile a weighted quantile, and every
query goes through one helper that allowlists Analytics Engine's documented functions.
Browser metrics are extracted from Faro measurements at ingest (§B.2); server metrics are
written by the API worker.

**F.2 Catalogue.**

| Journey | Signals |
|---|---|
| **Play** | `preview.ready_ms` (pick → `data-preview-status="ready"`, by tier/framework/ht_major — the headline metric); `sandpack.compile_ms`; `sandpack.compile_error` (fingerprint, no code); `sandpack.bundler_unreachable`; `preview.runtime_error` groups (ladder-deduped); `version.switch`; `bucket.resolve_ms` |
| **Edit live** | `session.start` (server; outcomes `ready`, `at_capacity`, `container_starting`, `boot_timeout`, `budget_denied`, `error`) and `session.start_ms` (client, cold/warm); `container.boot_ms`; `hmr.roundtrip_ms` where a reliable hook exists; `session.end` with reason and awake seconds; `pool.gauge` every 5 min |
| **Share & build** | `snapshot.build`; `serve.share`, `serve.d`, `serve.embed` (demo id as a blob); web vitals on `/share` and `/d` |
| **Embed on docs** | beacon `error.uncaught` and `web_vital` by demo id and `ht_major`; broken-embed and slow-embed lists by demo id |
| **Assist** | `chat.answer` (model, tokens, USD, latency, outcome), `chat.edit`, `theme.ai`, `import.url`, `payload.boot` |
| **Examples** | ADR-0042 |
| **Platform** | `api.request` (route class, status class, duration); `error.handled`; `budget.gauge` every 5 min; `reconcile.run`; o11y self: `o11y.ingest`, `o11y.drain`, `o11y.wake`, `o11y.backlog`, `o11y.alert` |

Sampling: authoring Faro 100 %; beacon errors 100 %, vitals 10 %; Worker lines 100 %;
Worker traces 1 % into Cloudflare's dashboard only.

Dashboards, provisioned from git: Runner overview (with deploy annotations), Tier-2
sessions, Tier-1 playground, Version health (framework × ht_major, `next` highlighted),
Docs embeds, AI assist, Examples & features (ADR-0042), Observability self. Cost moves to
ADR-0043, because spend truth is D1.

**F.3 Alerting runs outside the box, with state.** Grafana holds no alert rules: its
state would not survive a sleep.

| Signal | Owner | Latency |
|---|---|---|
| Uncaught error, new issue, regression | Sentry | seconds |
| Spend thresholds (200/500/800) | `reconcile.ts` `captureMessage` to Sentry, as today | nightly |
| `at_capacity` rate, 5xx rate from `api.request`, preview-ready rate per tier, session start p95, embed error rate per demo id, compile-error rate per `ht_major` day over day, inbox backlog age, a `rejected` inbox key, the o11y spend cap | o11y worker `*/10` cron over Analytics Engine and `InboxWriter` → Slack | minutes |
| New handled-error fingerprint | the exact first-seen registry in `InboxWriter` (not sampled data), excluding `surface = demo-runtime`, whose keystroke ladders are authored-code output | minutes |
| The o11y stack itself stale (no cron tick or ingest for 30 min) | the API worker's `*/5` cron reads the o11y heartbeat over a service binding and sends `captureMessage` to Sentry | minutes |

Alert state (firing, resolved, last notified) lives in Durable Object storage: a rule
notifies once when it fires and once when it resolves, never on every tick. Thresholds are
starting values, tuned after launch: preview-ready below 97 % (Tier-1) or 95 % (Tier-2)
over 1 h; session start p95 above 20 s; `at_capacity` above 5/h; 5xx above 1 % over
15 min; LiteLLM errors above 5 %; compile errors on one `ht_major` doubling day over
day; an embed above 20 % errors with more than 50 views in 24 h; backlog older than 2 h.

### G. Cost is its own number, with its own cap

- `recordContainerUsage` takes the SKU as a parameter; `o11y_container` carries the box's
  awake seconds, reported by the o11y worker to the API worker over the `API` service
  binding (the API worker owns D1 and KV; the o11y worker binds neither).
- `reconcile.ts` iterates over the scripts it reconciles, `handsontable-demos-api` and
  `handsontable-demos-o11y`, and writes each script's billing rows under distinct SKUs
  (`o11y_container`, `o11y_workers`), so the per-SKU upsert never overwrites the app's
  rows.
- `/admin` shows app, observability and total.
- `O11Y_BUDGET_USD` (default $15/month) joins the guardrail settings. When month-to-date
  observability spend crosses it, drains pause, visit wakes still work, and one Slack line
  is posted. Metrics and alerts keep working, because they read Analytics Engine, not Loki.
  Log text is kept only while the pause is shorter than the inbox's 7-day lifecycle and
  Loki's 7-day `reject_old_samples_max_age`; a longer pause loses the oldest log text, and
  that is the price of the cap.
- **Why the cap ($15) sits above the exit ceiling ($10)**: the ceiling is a design check
  at current traffic, measured once in exit criterion 7; the cap is a runtime brake. A cap
  at the ceiling would pause drains on the first busy month or heavy week of Grafana use,
  which is exactly when the logs matter. The $5 gap is headroom for traffic growth; a
  month that reaches it is a signal to revisit the design, not normal operation.
  Product tiers keep acting on the total. The bound is honest: drains are capped by the
  pause; visits are bounded by the 15-minute idle stop and the 4-hour limit (§A), not by
  construction.

### H. Access, jurisdiction, retention

- **Access**: every `@handsontable.com` account, as for `/admin`; Grafana Viewer via
  `auth.proxy`. This deviates from ADR-0007 for one surface: the broker hands a JWT to a
  SPA and cannot gate a proxied third-party HTML application.
- **EU-pinned**: the container (`jurisdiction: "eu"`), both Durable Objects, the inbox,
  Loki and maps buckets.
- **Deploy order** for the mutual service bindings: the o11y worker first (binding the
  existing API worker), then the API worker with its `O11Y` binding.
- **Not EU-pinned, stated plainly**: Cloudflare's own Workers Observability store keeps
  full lines and 1 % of spans for 7 days while `persist: true`, which is switched off 30
  days after this ADR is accepted; Analytics Engine; the Workers edge; Sentry, whose
  ingest host is `ingest.us.sentry.io` (unchanged); D1, which has an EEUR location hint,
  not a jurisdiction, and cannot gain one later.
- **Retention**: Loki `browser` 30 days, `worker` 90 days (§B.4); inbox objects 7 days;
  maps 30 days; Analytics Engine 3 months (platform); D1 rollups unbounded;
  `analytics_visitors` 180 days as today.

### I. Local development

Layout: `workers/o11y/` (Worker, both DOs), `containers/o11y/` (Dockerfile, Loki and
Grafana config, provisioning, `compose.yml`), `pipeline/fixtures/otlp/`,
`pipeline/o11y-*.test.mjs`. The whole new stack runs locally with Docker: the box through
`wrangler dev` or `compose.yml`; the o11y worker with Miniflare's R2, DO and cron; Loki on
Miniflare's local S3 endpoint for R2 or MinIO; Analytics Engine replaced by a ClickHouse
container holding an AE-shaped `runner_events` table, queried with the same SQL through
the allowlisting helper; Access by a fail-closed `DEV_ADMIN` bypass in `.dev.vars`.
Cloudflare's OTLP export does not run locally; its fixtures are real bodies captured by
the sandbox probe, scrubbed, plus hand-built edge cases. `pnpm o11y:dev` starts the box,
the Worker and the fixture replay.

### J. ADR-0042 and ADR-0043

ADR-0042 (example analytics) ships with this ADR: it needs the ingest path and Grafana,
and its events are counts only. ADR-0043 (`/admin` reads in Grafana) follows after launch;
the manual ledger re-open does not wait for it and lives on `/grafana/_o11y/reopen`.

### K. Tests

Every implementing change carries tests that fail with the change reverted
(docs/TESTING.md, the presence gate): gate tests per §B.5 row; `InboxWriter` tests for
normalisation, dedupe, storage-backed buffering across a simulated restart, sequence
persistence and key order; ledger tests for provisional/committed/re-opened/rejected
transitions and marker handling; a label test asserting the Loki series for each source
carry exactly the contract labels (exit criterion 15); scrubber tests per rule on real inputs (a Babel code
frame, a preview-host URL, a user-agent string); a config test pinning the Loki keys of
§B.4 and the `observability` block of §D; symbolication against a real `vite build`;
beacon injection and an `acorn` ES5 parse; one `E2E_LIVE` spec from `/telemetry` to a
queryable Loki line.

### L. Delivery and exit criteria

**Probes.** Cloudflare-only facts are measured with throwaway resources on the sandbox
account: separate Worker names, a probe-only config, `wrangler whoami` before every
deploy, synthetic traffic only, every resource deleted afterwards and listed.

**Order**: shared contract and scaffolds; the box and its stop protocol (spike a);
ingest and `InboxWriter` (spike b); drain, ledger and Grafana access; API worker signals;
Faro and the beacon; alerts and cost; ADR-0042; dashboards; CI and runbook; the local
end-to-end walkthrough and launch.

**Exit criteria**, each a pass/fail with recorded evidence:

1. **Clean stop**: lines pushed, clean stop, fresh wake → 100 % of lines queryable and the
   marker present, written with the **production-scoped** R2 token, not a local
   all-bucket credential. **Plan B** if Loki does not upload the index on graceful shutdown: the
   stop protocol waits for the next 15-minute index rotation and its upload before
   stopping, and wakes are thinned to backlog > 3 h or > 128 MB, which keeps the cost
   model within criterion 7; if that fails too, the serverless store replaces Loki.
2. **Unclean stop**: SIGKILL mid-drain, next wake → re-open → `count_over_time` and a log
   query both equal a single clean replay.
3. **Event time**: stored timestamps equal event time (clamped for browsers) for Faro,
   beacon and OTLP records, including OTLP records without `time_unix_nano`.
4. **Duplicate delivery**: the same export body delivered twice produces one copy.
5. **Symbolication**: an exception from a real `vite build` resolves to `src/…` file and
   line using at most 500 ms CPU and 64 MB of isolate memory; Babel-chunk frames are
   skipped, not parsed.
6. **Cold start**: wake-to-ready at most 90 s, worst of five runs on Cloudflare.
7. **Drain wake**: one hour of production-shaped traffic drains in at most 5 minutes of
   wall time, no alarm invocation exceeds the configured `cpu_ms`, CPU per object is
   recorded, and the cost model recomputed from the measured duration stays at or under
   $10/month at current traffic.
8. **Volume**: each allotment of §D under half, projected from measured per-session and
   per-request counts times production traffic.
9. **Idle tab**: an open, idle Grafana tab lets the box stop at the 15-minute idle timeout.
10. **Placement**: the Container's Durable Object namespace accepts `.jurisdiction("eu")`
    and the instance runs in an EU region.
11. **Worker errors**: an error thrown in a fetch handler, a DO alarm and the cron handler
    each produce a structured line in Loki with `invocation_logs: false`.
12. **Stop semantics**: what `onStop` reports for our own `stop()` is recorded, and a
    Worker-initiated stop does not escalate to SIGKILL before the clean marker is written.
13. **Retention**: R2 lifecycle deletes expired chunk prefixes per tenant, and queries past
    `max_query_lookback` return nothing.
14. **Image**: compressed size recorded and at most 1 GB, and it fits the instance disk.
15. **Labels**: records from each source (Faro, beacon, Cloudflare export, deploy events)
    arrive in Loki with every `hot.*`, `service.name` and `deployment.environment.name`
    label populated, and `hot.demo_id`, `session.id` and `cf.ray` present as structured
    metadata only, never as labels. Checked with Loki's label and series APIs, locally and
    on the sandbox probe with a real Cloudflare export.

If criterion 1, 2 or 7 fails with its plan B, the design is rewritten toward the
serverless store before more is built.

## Consequences

- **ADR-0040** decisions A (hour dimension) and B (`usage_hourly`) are not built;
  awake-seconds per hour and sampled peak concurrency become Analytics Engine points
  (C.2, C.3). **C.1 stands as written**: `at_capacity` is a `usage_daily` counter, and is
  also emitted as a `session.start` outcome. D (privacy) stands.
- **ADR-0022** gains a subordinate o11y ceiling and per-script billing rows;
  `recordContainerUsage` takes a SKU.
- **ADR-0038**'s WAF exception grows by one path, `/telemetry/*`.
- **ADR-0007** is deviated from for Grafana only.
- **ADR-0020**: more route patterns on the main hostname, still in deploy commands.
- **Sentry** keeps uncaught errors (as §E.1 defines them) and spend alerts; handled
  diagnostics move and lose grouping; the per-event `environment` re-homing and the
  `demo-runtime` environment disappear once the scope flips.
- **Source maps** are no longer deleted inside `vite build`; CI uploads them to Sentry
  and to R2, then deletes them before deploy.
- **We own**: the Faro-to-OTLP converter, the scrubber, the symbolicator, the drain and
  its ledger, and the alert evaluator. That is more code than revision 2, in exchange for
  synchronous acknowledgements, event-time timestamps, and one path for every record.
- **New operational surface**: one image (Loki + Grafana), three EU buckets, two Durable
  Object classes, provisioning in git, a fixture set, one Slack webhook, one Access
  application.
- **Accepted limits**: no browser-to-worker trace join and no traces in Grafana until
  `spanContext()`; no alert rules or durable UI state in Grafana; the first visit after a
  sleep waits behind the waking page; an unclean stop costs a replay and duplicate storage
  until lifecycle; embeds have no docs page attribution; handled errors have no issue
  grouping; the non-EU items listed in §H.
- **Cost**: ≈ $5–8/month target, $10 exit ceiling, reported separately, capped
  separately, summed under the same product ceiling.
