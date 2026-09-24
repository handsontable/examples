# Observability contract

The names, shapes and slot positions every observability component shares
([ADR-0041](adr/0041-observability-stack.md) revision 3, [ADR-0042](adr/0042-example-analytics.md)).
**Permanent document**: it outlives the implementation task board and is what a
dashboard author or a new emitter reads.

Implemented once, in `packages/runtime/src/telemetry/`, exported as
`@handsontable/demo-runtime/telemetry` — the subpath-export pattern `monitor-inject.ts`
already uses for `@handsontable/demo-runtime/monitor`. The module is pure (no DOM, no
Cloudflare imports), so the API worker, the o11y worker, the authoring app and
`pipeline/` tests import the same definitions. `pipeline/telemetry-contract.test.mjs`
parses the tables below and fails when the module disagrees with this file.

**Changing this file**: in its own small PR, together with the module, before any code
relies on the change. Metric rows and slots are **append-only**: never reuse, move or
rename a slot or a metric name. Analytics Engine columns are positional, so a moved slot
silently corrupts every stored row and no type checks it.

## 1. Deployables, routes, ports

| Name | Path | Notes |
|---|---|---|
| `handsontable-demos-o11y` | `workers/o11y/` | Worker + `InboxWriter` DO + `GrafanaBox` Container class; `workers_dev: false`, `preview_urls: false` |
| Grafana box image | `containers/o11y/` | Loki + Grafana only |

Routes on `demos.handsontable.com`, owned by the o11y worker, passed as `--routes` flags
in its deploy script (ADR-0020), never in `wrangler.jsonc`:

| Route | Purpose | Gate (ADR-0041 §B.5) |
|---|---|---|
| `POST /telemetry/collect` | Faro payloads from the authoring app | host/env, bot filter, caps, kind allowlist, rate limit, server scrub |
| `POST /telemetry/lite` | lite beacon from `/d` and `/embed` | same as `collect` |
| `POST /telemetry/v1/logs` | Cloudflare OTLP log export | `x-o11y-secret` |
| `POST /telemetry/deploy` | deploy event from CI | GitHub OIDC token, `x-o11y-secret` fallback |
| `POST /telemetry/hooks/sentry` | Sentry issue-alert webhook | `sentry-hook-signature` HMAC |
| `/grafana/*` | Grafana UI, waking page | Access JWT verified in the Worker |
| `POST /grafana/_o11y/reopen` | manual ledger re-open | Access JWT |
| `GET /grafana/_o11y/admin/<name>` | ADR-0043 read forwarder (after launch) | Access JWT, name allowlist, GET only |

There is no trace route: traces are not exported (ADR-0041 §C.4).

Ports inside the Grafana box, reached only through `GrafanaBox.containerFetch`:

| Port | Service |
|---|---|
| 3000 | Grafana (served from sub-path `/grafana/`) |
| 3100 | Loki HTTP (`/otlp/v1/logs`, `/ready`, `/metrics`) |

## 2. Bindings, variables, secrets

**o11y worker** (`workers/o11y/wrangler.jsonc`):

| Name | Kind | Value / purpose |
|---|---|---|
| `INBOX_WRITER` | Durable Object | class `InboxWriter`, one instance `main`, `.jurisdiction("eu")`; owns inbox keys, ledger, dedupe set, fingerprint registry, alert state |
| `GRAFANA_BOX` | Durable Object + Container | class `GrafanaBox`, one instance `box`, `.jurisdiction("eu")`, container `jurisdiction: "eu"` |
| `O11Y_INBOX` | R2 | bucket `handsontable-demos-o11y-inbox` (EU) |
| `O11Y_LOKI_STATE` | R2 | bucket `handsontable-demos-o11y-loki` (EU); the Worker reads only `state/wakes/<wakeId>/clean` markers |
| `O11Y_MAPS` | R2 | bucket `handsontable-demos-o11y-maps` (EU) |
| `RUNNER_EVENTS` | Analytics Engine | dataset `runner_events` |
| `API` | service binding | `handsontable-demos-api` (o11y usage metering, o11y spend, later `AdminReads`) |
| `O11Y_ENV` | var | `production` \| `local` |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | vars | Access application for `/grafana/*` |
| `GITHUB_OIDC_REPOSITORY` | var | `handsontable/examples` |
| `O11Y_EXPORT_SECRET` | secret | `x-o11y-secret` on the export destination and the deploy fallback |
| `SENTRY_HOOK_SECRET` | secret | Sentry internal-integration client secret |
| `AE_SQL_TOKEN` | secret | Analytics Engine SQL API (alert cron; passed to the box for Grafana) |
| `LOKI_S3_ACCESS_KEY_ID`, `LOKI_S3_SECRET_ACCESS_KEY` | secrets | R2 S3 credentials, passed to the box as `envVars` |
| `SLACK_WEBHOOK_URL` | secret | alert channel; never passed to the box |
| `DEV_ADMIN` | `.dev.vars` only | fail-closed local bypass of the Access check |

The box reaches the Loki bucket over S3 at
`https://<account-id>.eu.r2.cloudflarestorage.com` with `LOKI_S3_*`, scoped to that bucket
only; it writes Loki data and the clean markers there. Lifecycle rules: `browser/` chunks
30 d, `worker/` chunks 90 d, index 90 d, `state/` 30 d.

**API worker** additions (`workers/api/wrangler.jsonc`):

| Name | Kind | Value / purpose |
|---|---|---|
| `RUNNER_EVENTS` | Analytics Engine | dataset `runner_events` |
| `O11Y` | service binding | `handsontable-demos-o11y`, `heartbeat()` for the watchdog |
| `SERVICE_VERSION` | `--var` in the deploy script | full `GITHUB_SHA` |
| `SENTRY_SCOPE` | var | `full` \| `uncaught` (§11) |
| `CF_ACCOUNT_ID` | var | GraphQL Analytics API account tag; also scopes the Analytics Engine SQL API read below |
| `AE_SQL_TOKEN` | secret | Analytics Engine SQL API (Account Analytics Read) — production read side of the nightly `example_daily` rollup (ADR-0042 §5, C-I1). Unset means `reconcile.ts#queryExampleEventTotals` throws instead of rolling up an empty day |
| `o11y-logs` | export destination name | referenced from `observability.logs.destinations` |
| `*/5 * * * *` | cron | `pool.gauge`, `budget.gauge`, o11y heartbeat check |

**Authoring app**: `VITE_SENTRY_RELEASE` (the `GITHUB_SHA` define) doubles as
`service.version`; `VITE_TELEMETRY_LOCAL=1` enables the local path (§10) and is never set
for a production build; `VITE_SENTRY_SCOPE` = `full` | `uncaught` (§11).

**Headers**: `x-hot-session` (page-load id, browser → API worker), `x-o11y-secret`,
`sentry-hook-signature`, `Cf-Access-Jwt-Assertion`, `x-o11y-grafana-user` (set by the o11y
worker for Grafana `auth.proxy`; stripped from every client request), `X-Scope-OrgID`
(Loki tenant: `browser` \| `worker`).

## 3. Attributes

All of these are **OTLP resource attributes** on every record, so Loki's `otlp_config`
can promote them to labels.

| Key | Values | Loki label | AE slot |
|---|---|---|---|
| `service.name` | `demos-authoring`, `demos-api`, `demos-o11y`, `demos-embed` | `service_name` | `blob1` |
| `service.version` | full git SHA | no | `blob2` |
| `deployment.environment.name` | `production`, `local` | `deployment_environment_name` | `blob3` |
| `hot.surface` | `authoring`, `share`, `embed`, `d`, `api`, `demo-runtime`, `o11y` | `hot_surface` | `blob4` |
| `hot.tier` | `1`, `2`, `static`, `none` | `hot_tier` | `blob5` |
| `hot.framework` | a key of `config/frameworks.json`, a docs-example framework, or `none` | `hot_framework` | `blob6` |
| `hot.ht_major` | `15`…`19`, `next`, `none` | `hot_ht_major` | `blob7` |
| `hot.outcome` | per metric, see §5 | `hot_outcome` | `blob8` |

Structured metadata only — never a Loki label, never an Analytics Engine index:
`hot.demo_id`, `session.id` (an in-memory page-load id), `cf.ray`, `hot.kind` (the Faro item
kind: `exception`, `log`, `event`, `measurement`).

Diagnostic tags — flat, non-dotted, never a Loki label, never an Analytics Engine
index, and not hoisted to structured metadata either (§6): `handled`, `context`,
`sentry_event_id`, `versions_fetch_attempts`, `versions_fetch_outcome`,
`versions_fetch_elapsed_bucket`, `versions_fetch_online`, `api_base_origin`,
`net_effective_type`. Each is a boolean flag, an enum-like/bucketed value, an
opaque platform id, or the reporting call site's own name — never user or
request content.

**Never sent to the o11y stack**: the user pseudonym, an email, an IP, a user-agent
string, a query string or fragment, authored code (including Babel code frames), chat
text, console output, `url.full`, geo or ASN attributes.

## 4. Analytics Engine layout (`runner_events`)

`index1` = metric name (the sampling key); queries filter on `index1` directly.

| Slot | Column | Meaning |
|---|---|---|
| `index1` | `metric` | metric name (§5) |
| `blob1` | `service_name` | §3 |
| `blob2` | `service_version` | §3 |
| `blob3` | `environment` | §3 |
| `blob4` | `surface` | §3 |
| `blob5` | `tier` | §3 |
| `blob6` | `framework` | §3 |
| `blob7` | `ht_major` | §3 |
| `blob8` | `outcome` | §3, §5 |
| `blob9` | `reason` | metric-specific qualifier (§5) |
| `blob10` | `route_class` | API route class, e.g. `api/versions` |
| `blob11` | `fingerprint` | §7 |
| `blob12` | `demo_id` | demo id where the metric concerns one demo |
| `blob13` | `model` | LLM model id |
| `blob14` | `provider` | upstream or import provider |
| `blob15` | `device` | `desktop`, `mobile`, `tablet` |
| `blob16` | `bucket` | docs or starter bucket (`18.1`, `next`) |
| `blob17` | `kind` | ADR-0042: `docs`, `starter`, `saved`, `import`, `payload` |
| `blob18` | `ref` | ADR-0042: guide path or starter id |
| `blob19` | `area` | ADR-0042: first breadcrumb element of a docs example |
| `blob20` | — | unassigned |
| `double1` | `count` | 1 per point unless pre-aggregated |
| `double2` | `duration_ms` | latency |
| `double3` | `value` | generic measurement (web-vital value, gauge level, seconds, percent) |
| `double4` | `usd` | cost |
| `double5` | `tokens_in` | LLM input tokens |
| `double6` | `tokens_out` | LLM output tokens |
| `double7` | `bytes` | payload or artifact size |
| `double8` | `cap` | the limit a gauge is measured against |
| `double9`–`double20` | — | unassigned |

**Reading rule**: Analytics Engine samples at write and read time. Every count is
`SUM(_sample_interval * double1)`, every percentile a weighted quantile, never `COUNT()`.
Queries go through one helper that allowlists Analytics Engine's documented functions;
the local ClickHouse shim accepts more.

## 5. Metric registry

Outcome values are the only strings allowed in `blob8` for that metric.

| Metric | Emitted by | Blobs used | Doubles | Outcomes / reason |
|---|---|---|---|---|
| `preview.ready_ms` | browser | surface, tier, framework, ht_major, outcome, bucket | duration_ms | `ready`, `error`, `timeout`, `abandoned` |
| `sandpack.compile_ms` | browser | tier, framework, ht_major, outcome | duration_ms | `ok`, `error` |
| `sandpack.compile_error` | browser | framework, ht_major, fingerprint | count | — |
| `sandpack.bundler_unreachable` | browser | ht_major | count, duration_ms | — |
| `preview.runtime_error` | browser | surface=`demo-runtime`, tier, framework, ht_major, fingerprint, reason | count | reason: `uncaught`, `console`, `network`, `stderr` |
| `version.switch` | browser | framework, ht_major (to), reason (from), bucket | count | — |
| `bucket.resolve_ms` | browser | bucket, outcome | duration_ms | `ok`, `error` |
| `session.start_ms` | browser | framework, ht_major, outcome, reason | duration_ms | outcomes as `session.start`; reason `cold`, `warm` |
| `hmr.roundtrip_ms` | browser | framework, ht_major | duration_ms | — |
| `web_vital` | browser, beacon | surface, framework, ht_major, reason, device, demo_id | value | reason `LCP`, `INP`, `CLS`, `TTFB` |
| `error.uncaught` | browser, beacon | surface, fingerprint, demo_id | count | — |
| `error.handled` | browser, API worker | surface, route_class, fingerprint | count | — |
| `example.open` | browser (ADR-0042) | kind, ref, area, framework, ht_major, bucket, reason (`entry`) | count | reason `deep-link`, `picker`, `switch`, `version-switch`, `fork` |
| `example.engaged`, `example.forked`, `example.saved`, `example.shared`, `example.downloaded` | browser (ADR-0042) | kind, ref, area, framework, ht_major, bucket | count | — |
| `api.request` | API worker | route_class, outcome | count, duration_ms | `2xx`, `3xx`, `4xx`, `5xx` |
| `session.start` | API worker | framework, ht_major, outcome | count, duration_ms | `ready`, `at_capacity`, `container_starting`, `boot_timeout`, `budget_denied`, `error` |
| `session.end` | API worker | framework, reason | count, value (awake s) | reason `pagehide`, `sleep_after`, `teardown_failed`, `budget_closed` |
| `container.boot_ms` | API worker | framework, outcome, reason | duration_ms | `ready`, `window_exceeded`, `error`; reason `cold`, `warm` |
| `pool.gauge` | API worker `*/5` | reason (`live`, `builder`) | value (awake), cap | — |
| `budget.gauge` | API worker `*/5` | reason (tier) | value (percent of ceiling), usd | — |
| `snapshot.build` | API worker | framework, outcome, reason | count, duration_ms, bytes | `ok`, `failed`; reason `inline`, `detached` |
| `serve.share`, `serve.d`, `serve.embed` | API worker | outcome, demo_id | count, bytes | `2xx`, `304`, `4xx`, `5xx` |
| `chat.answer` | API worker | model, outcome | count, duration_ms, usd, tokens_in, tokens_out | `answered`, `denied`, `error` |
| `chat.edit` | API worker | outcome | count | `proposed`, `applied`, `undone` |
| `theme.ai` | API worker | model, outcome | count, duration_ms, usd | `answered`, `denied`, `error` |
| `import.url` | API worker | provider, outcome, reason | count, duration_ms | `ok`, `refused`, `error` |
| `payload.boot` | API worker | framework, outcome | count | `ok`, `error` |
| `reconcile.run` | API worker cron | outcome | count, duration_ms, usd (billing total WRITTEN this run — not a delta against the estimate; D-M15 fix round) | `ok`, `skipped`, `error` |
| `o11y.ingest` | o11y worker | reason, outcome | count, bytes | `accepted`, `dropped`, `duplicate`; reason = gate |
| `o11y.drain` | o11y worker | reason, outcome | count (objects), duration_ms, bytes, value (re-opened keys) | `ok`, `partial`, `error`; reason `backlog`, `visit`, `reopen` |
| `o11y.wake` | o11y worker | reason, outcome | count, duration_ms (to ready) | reason `backlog`, `visit`; outcome `clean`, `unclean` |
| `o11y.backlog` | o11y worker cron | — | value (oldest age s), bytes | — |
| `o11y.alert` | o11y worker cron | reason (rule id), outcome | count | `fired`, `resolved` |

## 6. Browser facade and Faro

The app never calls Faro directly; it calls one facade, implemented with Faro:

```ts
interface Telemetry {
  metric(name: MetricName, values: { duration_ms?: number; value?: number; count?: number }, attrs: HotAttrs): void;
  event(name: EventName, attrs: HotAttrs & Record<string, string>): void;
  error(err: unknown, context: string, attrs?: HotAttrs): void; // handled errors
  pageLoadId(): string; // minted in memory at page load
}
```

Faro configuration: session tracking disabled; only the errors and web-vitals
instrumentations; no `user` meta; the facade sets `session.id` = page-load id on every
item; transport to same-origin `/telemetry/collect`; `beforeSend` = `scrubTelemetry` then
the shared noise gates.

What the o11y worker does with each Faro item at ingest:

| Faro item | Analytics Engine | Inbox (Loki `browser` tenant) |
|---|---|---|
| measurement whose `type` is a browser metric in §5 | one point | one log record |
| `web-vitals` measurement | one `web_vital` point per vital | one log record |
| exception with `context.handled = "true"` | `error.handled` | one log record, symbolicated at drain |
| other exception | `error.uncaught` | one log record, symbolicated at drain |
| event named `example.*` | one point | **none** |
| other event, log | — | one log record |

## 7. Fingerprint

`fingerprint(context, message)` = `<context>:<16 hex chars of FNV-1a 64 over the
normalised message>`, synchronous and identical in browser and Worker; the normalisation
is `normalizeMonitorMessage` plus `stripCodeFrame`. For `hot.surface = demo-runtime`,
keystroke-ladder shapes (`"<identifier> is not defined"` and similar) collapse to one
fingerprint per shape. Demo-runtime fingerprints never feed the new-fingerprint alert.

`context` is caller-chosen (typically `hot.surface` or a metric name) and MAY itself
contain further `:`-separated segments, e.g. `docs-example-load:fetch` or
`npm-registry:version-exists` — a call-site path, not always a single flat token. A
client-supplied fingerprint (Faro's own `payload.fingerprint` wire field, or
`context["hot.fingerprint"]`) is trusted only when it passes the ONE shared validator
(`isValidFingerprint`, `packages/runtime/src/telemetry/fingerprint.ts` — also used by
`normalise/faro.ts`'s `resolveFingerprint` and `normalise/otlp.ts`'s
`apiFingerprintFeed`, never a second, independently drifting copy of the shape):
anchor on the LAST `:`, followed by exactly 16 lowercase hex characters, with zero or
more earlier `:`-separated segments in `context`, each drawn from `[a-z][a-z0-9._-]*`;
the whole `context` half is capped at 128 characters. A value that does not match is
discarded, never stored or forwarded to Slack verbatim.

## 8. Inbox

Normalised records are OTLP JSON log records (`resourceLogs` shape), one tenant per
object:

```text
inbox/<tenant>/<yyyy-mm-dd>/<hh>/<seq:012d>.ndjson.gz     # inbox bucket; tenant = browser | worker
state/wakes/<wakeId>/clean                                # Loki bucket; written by the box on a clean stop
```

`<seq>` is a counter in `InboxWriter` storage, incremented in the transaction that
records the key. Each NDJSON line is one OTLP `ResourceLogs` object. The arrival time is
**not** part of the record (it would break dedupe); it lives on the storage row. The
dedupe hash is computed over the decoded, scrubbed record before timestamps are stamped.

`InboxWriter` storage:

| Key | Value |
|---|---|
| `seq` | last issued sequence |
| `row:<n:012d>` | pending records with their arrival time, ≤ 1 MB per row. `<n>` is zero-padded to 12 digits (G1 fix round, A-I2) so native ascending key order equals arrival order; a row written before this fix, under the un-padded `row:<n>` shape, is migrated in place (rewritten under the padded key, oldest first) before the pack alarm packs anything appended after the fix — see `pack.ts#migrateLegacyRows` |
| `key:<inbox key>` | `written` \| `provisional:<wakeId>` \| `rejected:<reason>` — **never `committed`** (see `done:`, below) |
| `done:<inbox key>` | `1` — a **committed** key, moved OUT of `key:` on commit (same write that deletes `key:<inbox key>`) |
| `hash:<yyyymmdd>:<sha256>` | first-seen epoch ms; 24 h window, checked across the current and previous UTC-day bucket |
| `fp:<fingerprint>` | first-seen epoch ms (exact registry for the new-fingerprint alert) |
| `fpts:<firstSeenMs:015d>:<fingerprint>` | same first-seen epoch ms as its `fp:` twin — a time-ordered secondary index (G1 fix round, B-C1/A-I1 remainder) so the new-fingerprint alert can do a bounded `start`/`end` range read instead of listing the whole (alphabetically, not chronologically, ordered) `fp:` prefix every tick. Written/deleted together with its `fp:` twin, always |
| `alert:<rule>` | `{ state: firing \| resolved, since, lastNotified }` |
| `wake:<wakeId>` | `{ startedAt, reason, over: boolean }` — over when a newer wake started or the container is not running; **deleted once fully resolved** (see below) |
| `rejectedEvent:<ms:015d>:<inbox key>` | rejection reason (string) — a chronological audit/alert log (G1 fix round, row 19 / B-C1/A-I1 remainder), written by both a full rejection (`ledger.ts#rejectKey`) and a **partial** one (`ledger.ts#recordPartialReject`, see below). The `rejected-inbox-key` alert fires on a RECENT (last hour) count here, not on `rejectedKeyCount()`'s never-pruned total, so it resolves once rejections stop instead of firing forever after the first one ever seen |
| `drainsPaused` | boolean (o11y spend cap) |
| `heartbeat` | `{ lastCron, lastIngest }` |

Limits: records over 256 KB are dropped; requests to Loki carry at most 1 MB
decompressed.

**Bounded storage (F2 fix, final review, B-C1/A-I1 — the resolve/drain/backlog paths
must never scan committed history):**
- A `key:` entry only ever holds a **live** state (`written`, `provisional:<wakeId>`, or
  a genuine `rejected:<reason>`). The moment a key is confirmed clean-committed, its
  `key:<inbox key>` entry is deleted and a `done:<inbox key>` marker takes its place in
  the same write — `key:` therefore never grows with committed history, only with what is
  currently open or in flight. `done:` entries are pruned once their embedded date is
  older than the 7-day inbox-object retention (the ten-minute cron path, via
  `InboxWriter.backlog()`), using a bounded `start`/`end` range delete (`done:inbox/<tenant>/`
  through the cutoff date), never a full-prefix scan.
- A `wake:<wakeId>` entry is deleted as soon as `resolveOverWakes` fully resolves it (every
  provisional key under it moved to `written` or `done:`) — not merely flagged. The
  `wake:` prefix therefore only ever holds the (at most one) currently-active wake plus
  any wake whose resolution crashed mid-way, never all-time history.
- `hash:` is bucketed by UTC calendar day (`hash:<yyyymmdd>:<sha256>`) instead of one flat
  set; a dedupe check reads exactly the current and previous day's buckets (the 24 h window
  can never span more than those two), and stale buckets (2+ days old) are pruned with a
  bounded range delete on the same cron path.
- `fp:` keeps its flat shape (nothing reads it by date range), but is swept by a bounded,
  cursor-paginated TTL prune (default 90 days) on the same cron path, so it does not grow
  forever either.
- `POST /grafana/_o11y/reopen`'s window is capped to the same 7-day retention — nothing
  older can exist any more (`done:`/`hash:` are pruned past it, and Loki's own
  `reject_old_samples_max_age` is 7d too) — and requires an exact `content-type:
  application/json` (CSRF hardening: forces a CORS preflight for any cross-origin caller).
- A manual reopen of a **committed** key reads `done:`, moves it back to `key:<inbox
  key> = written`, and deletes the `done:` entry.

**G1 fix round (final review, second wave) additions:**
- **Pack alarm, bounded (A-I2 remainder).** The alarm no longer loads every pending
  `row:` into memory before packing (F1's fix only bounded the packed OBJECT's size, not
  this read). It first migrates any legacy (un-padded) `row:<n>` rows to completion, then
  pages `row:` in small chunks, accumulating up to one packed object's own ~4 MB budget
  per round, looping until the backlog is drained or `MAX_OBJECTS_PER_ALARM` (25) objects
  have been packed this invocation. See `pack.ts#collectRowBatch`/`migrateLegacyRows`.
- **DO storage 128-key batch limit (N2).** Cloudflare's SQLite-backed Durable Object
  storage API caps `get`/`put`/`delete` at 128 keys/pairs per call
  (<https://developers.cloudflare.com/durable-objects/api/storage-api/>, fetched
  2026-09-24: "Supports up to 128 keys at a time" / "up to 128 key-value pairs at a
  time"). Every multi-key call in `InboxWriter` chunks through `storage.ts`'s
  `getManyChunked`/`putChunked`/`deleteChunked` — `checkDuplicates`, `newFingerprintWrites`,
  `pruneLedger`/`pruneHashBuckets`/`pruneFingerprintRegistry`, `finalizeWakeResolution`,
  `markKeysProvisional`, `reopenWindow`, `commitPackedObject`, and `ingest`'s own
  transaction `put`. `finalizeWakeResolution`/`reopenWindow` also now run their whole
  put+delete sequence inside one `storage.transaction()` (previously two independent
  top-level calls) — chunking alone, without that, would let a crash between chunks
  leave a partial write.
- **Prune throughput (B-C1/A-I1 remainder).** `hash:`/`done:` prune batch sizes raised
  from 500 to 5,000 rows/tick (still chunked to 128 per actual `delete()` call) — ADR
  §D's own 10× headroom projects ~220,000 worker records/day, which the old 500/tick ×
  144 ten-minute ticks/day (72,000/day) falls behind at roughly 3× today's traffic.
  `rejected:` `key:` entries are now pruned too, past the same 7-day retention (filtered
  by value, since `key:` mixes live and rejected states chronologically — see
  `ledger.ts#pruneLedger`).
- **Drain partial-400 durability (rereview.md row 19).** A key with at least one chunk
  accepted (2xx) and at least one chunk permanently rejected (400) now stays
  `provisional` (not `rejected`) — its accepted content follows the normal
  written→provisional→committed path, so an unclean stop before Loki's local flush
  still triggers an automatic replay instead of being silently unrecoverable except by
  manual reopen. Only a key with ZERO accepted chunks stays `rejected`. See
  `drain.ts#drainKey`'s own doc comment.

## 9. Lite beacon payload

`POST /telemetry/lite`, `navigator.sendBeacon`, `application/json`, **≤ 2 KB**:

```json
{"v":1,"t":"err","s":"embed","demo":"r-react-18-0-0","ht":"18","fw":"react","n":"TypeError","m":"<normalized, ≤500 chars>","st":"<stack, ≤2000 chars>","val":null,"dev":"desktop","ts":1695463200000}
```

`t` = `err` | `vital`; `s` = `embed` | `d`; for `vital`, `n` is `LCP` | `INP` | `CLS` |
`TTFB` and `val` carries the value. No page path: docs pages send no referrer. Vitals are
sampled at 10 % per page view, decided once per page; errors are sent up to the
`monitor.ts` event ceiling. The o11y worker converts beacons with the same converter as
Faro items, clamping `ts` to the receive time ± 5 minutes.

## 10. Local mode

| Piece | Local stand-in |
|---|---|
| `RUNNER_EVENTS` | ClickHouse at `http://localhost:8123`, table `runner_events` with the §4 columns plus `timestamp` and `_sample_interval` (always 1), DDL in `containers/o11y/local/clickhouse-init.sql` |
| Loki S3 | Miniflare's local S3 endpoint for R2, or MinIO from `containers/o11y/compose.yml` |
| Access | `DEV_ADMIN` in `workers/o11y/.dev.vars` |
| Cloudflare OTLP export | fixtures in `pipeline/fixtures/otlp/` (scrubbed sandbox-probe captures plus hand-built edge cases), replayed by `scripts/o11y-replay-fixtures.mjs` |
| Slack | `scripts/o11y-slack-capture.mjs`, a local HTTP capture server started by `pnpm dev:full` (NOT by `pnpm o11y:dev`, which doesn't start it — point `SLACK_WEBHOOK_URL` at your own instance if you need one from the standalone o11y-only command); prints and keeps the last 50 posts, `GET /_captured` to inspect |

`deployment.environment.name = local`; the production o11y worker drops `local` data.

**Local telemetry gate in the browser.** Faro runs on the local path only when the build
was made with `VITE_TELEMETRY_LOCAL=1` **and** the host is `localhost` or `127.0.0.1`. It
checks neither `import.meta.env.DEV` nor `navigator.webdriver`, because Playwright serves
a production `vite preview` under automation. The production gate (`resolveReporting`)
is unchanged and stays closed under automation. A production build never sets the flag,
and the post-build leak check fails if the local path survives into it.

## 11. Sentry scope

`SENTRY_SCOPE` / `VITE_SENTRY_SCOPE` = `full` (default): handled diagnostic reports go to
Sentry **and** the new stack. `uncaught`: they go only to the new stack; Sentry keeps
errors that escape a handler (browser `onerror`, `unhandledrejection`,
`Sentry.ErrorBoundary`; Worker fetch catch-all, DO alarms, cron, snapshot-job failures)
and the budget-alert `captureMessage`. The launch plan flips to `uncaught` after the
pipeline is seen working in production.
