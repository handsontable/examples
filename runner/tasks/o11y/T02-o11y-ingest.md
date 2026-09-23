# T02 — o11y Worker ingest: routes, gates, normalisation, `InboxWriter` (spike b, part 1)

| | |
|---|---|
| Status | done |
| Size | L |
| Depends on | T00 |
| Blocks | T03, T04, T08, T09 (fixtures), T12, T11 |
| ADR | 0041 §B.1, §B.2, §B.5, §B.6, §C.1, §C.2, §E.4 (server scrub), §F.1; exit criteria 3, 4 |
| Owns | `workers/o11y/src/{index.ts,router.ts,gates/**,normalise/**}`, `workers/o11y/src/inbox/{writer.ts,pack.ts,dedupe.ts,registry.ts}`, the DO/R2/AE/rate-limit parts of `workers/o11y/wrangler.jsonc`, `pipeline/o11y-{routes,gates,normalise,inbox}.test.mjs`, `pipeline/fixtures/otlp/**`, `pipeline/fixtures/faro/**`, `scripts/o11y-replay-fixtures.mjs` |

## Goal

Every telemetry route authenticates or drops its input, normalises it into scrubbed,
deterministic OTLP log records with event-time timestamps, drops duplicates, commits to
durable storage before answering, and packs ordered per-tenant R2 objects — with the box
asleep.

## Read first

- ADR-0041 §B and §C; contract §1, §2, §3, §5, §6, §8.
- `workers/api/src/analytics.ts` (bot filter, classifiers — moved to the contract module
  by T00) and `packages/runtime/src/monitor.ts` (`redactPreviewHosts`).

## Scope

In:

- `router.ts` with `registerRoute(method, path, handler)` so T03, T04, T08 plug in.
- `gates/` per ADR §B.5: origin/referer host + environment gate (production host only;
  `localhost` only when `O11Y_ENV = local`), `BOT_RE`, size caps, item-kind allowlist,
  the Workers rate-limiting binding; `x-o11y-secret` (constant-time); GitHub OIDC with
  `jose`; Sentry HMAC; the Access JWT helper exported for T03. Every drop writes an
  `o11y.ingest` point with its reason.
- `normalise/`, in the **stateless route handler** (never inside `InboxWriter`), in the ADR
  §B.2 order — decode and scrub, **hash**, then stamp timestamps:
  - Faro payload → OTLP log records (contract §6 mapping), `session.id` from the item,
    timestamps clamped to the arrival time ± 5 min after hashing;
  - Cloudflare export → decode protobuf or JSON (both, until the probe shows which is
    sent), keep allowlisted attributes, drop `url.full`, user agent, geo and ASN,
    `redactPreviewHosts` over bodies and attributes, timestamp fallback chain
    `time_unix_nano` → `observed_time_unix_nano` → `received_at`;
  - hoist `hot.*`, `service.*` and `deployment.environment.name` to resource
    attributes; run `scrubTelemetry` authoritatively; drop records over 256 KB;
  - deploy events and Sentry issue webhooks → one OTLP log record each (`worker` tenant).
- `inbox/`: the `InboxWriter` DO (`main`, EU): dedupe of the hashes the route computed
  over 24 h (`o11y.ingest` outcome `duplicate`), append to storage rows ≤ 1 MB with the
  arrival time on the row (never in the record), answer after commit,
  60 s / 4 MB alarm packing one gzipped object per tenant, `seq` persisted in the same
  transaction as `key:<key> = written`, the exact fingerprint registry (`fp:*`), the
  heartbeat `lastIngest`. Analytics Engine extraction per contract §6 at this step;
  `example.*` events produce points only and are never stored.
- Fixtures: hand-built OTLP bodies (protobuf and JSON, including zero timestamps and
  forbidden attributes), Faro payloads (exception with a code frame, measurement, web
  vitals, `example.open`, a log), a deploy event, a Sentry issue payload; the replay script.

Out: beacon conversion (T08, via `registerRoute` and this task's converter), the ledger
transitions and drain (T03), alerts (T04).

### Sandbox probe (required — see the board README's probe rules)

A throwaway Worker on the sandbox account exporting logs to a throwaway copy of these
routes. Record content type, body sizes, batches per minute under synthetic load, whether
records carry `time_unix_nano`, which attributes arrive and where (resource vs record),
and the exporter's behaviour on a forced 5xx and a forced timeout. Then check exit
criterion 15 on those real bodies: after normalisation, every contract label reaches
Loki (spin up the local box against the captured fixtures) and no metadata-only field
becomes a label. Capture, scrub and
commit bodies as fixtures. Delete the probe.

## Acceptance criteria

- Replaying every fixture against `wrangler dev` returns 2xx only after the storage
  commit; after the alarm, local R2 holds per-tenant objects with strictly increasing
  keys; every line is a valid OTLP `ResourceLogs` with the contract resource attributes.
- **Exit criterion 3 at ingest**: stored timestamps equal the fixture's event time,
  clamped for browser items; a zero-timestamp OTLP record gets its fallback.
- **Exit criterion 4**: the same export body posted twice, seconds apart and including a
  zero-timestamp record, yields one stored copy and one `duplicate` point.
- No stored record contains a query string, a user agent, a Babel code frame, a preview
  hostname, `url.full`, geo or ASN (assert over all fixtures).
- A simulated restart between an append and the alarm loses nothing.
- An `example.open` Faro event produces one Analytics Engine point and no stored record.
- Every stored record carries the contract §3 keys as **resource** attributes, never as
  record attributes (the precondition for exit criterion 15).
- Each gate test fails when its gate is bypassed.

## Verify

```bash
cd runner
pnpm test
( cd workers/o11y && npx wrangler dev ) &
node scripts/o11y-replay-fixtures.mjs --base http://localhost:8788
( cd workers/o11y && npx wrangler deploy --dry-run )
```

## Traps

- Keys come only from the writer's persisted `seq`, never from `Date.now()` in a route.
- DO SQLite rows cap at 2 MB; keep rows ≤ 1 MB.
- `CompressionStream` output must be fully read before `put`.
- Jurisdiction is not enforced locally; a green local run is not evidence of EU placement.
- ADR-0038's WAF rule 403s bodies containing `<script` until T10 extends the exception to
  `/telemetry/*`; the sandbox probe zone may behave differently from production.

## Outcome

### What was built

- `workers/o11y/src/router.ts` — COMMON.md interface 2: `registerRoute(method, path, handler)`,
  exact-path-beats-prefix / longest-prefix-wins precedence, throws on a duplicate
  `method`+`path` registration.
- `workers/o11y/src/gates/` — `util.ts` (constant-time compare, HMAC-SHA256, SHA-256,
  host/env helpers), `limits.ts` (size caps), `types.ts` (`GateResult`), `browser.ts`
  (`collect`/`lite` host+env+bot+size+rate-limit chain, plus `checkPayloadEnvironment`),
  `secret.ts` (`x-o11y-secret`, constant-time, fail-closed), `oidc.ts` (GitHub OIDC via
  `jose`, secret fallback), `sentry.ts` (HMAC), `access.ts` (COMMON.md interface 3:
  `verifyAccess`, `DEV_ADMIN` fail-closed to `O11Y_ENV === "local"`, empty `ACCESS_AUD`
  refused rather than treated as "no restriction").
- `workers/o11y/src/normalise/` — `hash.ts` (pre-stamp content hash, T02-D1), `read-body.ts`
  (capped, gzip-aware body reader), `points.ts` (AE sink selection + §3 default filler),
  `respond.ts` (the one place a drop/accepted/duplicate `o11y.ingest` point is written),
  `browser-attrs.ts` (the AE-only `hot.*` channel, T02-D4), `text-scrub.ts` (query-string
  and UA redaction in free body text, T02-D7), `faro.ts` (Faro `TransportBody` → items →
  records/points, T02-D6), `otlp.ts` + `otlp-protobuf.ts` (JSON and hand-rolled protobuf
  OTLP decode, T02-D2), `deploy.ts`, `sentry.ts` (single-record worker-tenant converters).
- `workers/o11y/src/inbox/` — `storage.ts` (`StorageLike`, `memoryStorage()` test fake),
  `dedupe.ts`, `registry.ts`, `pack.ts` (row chunking, numeric row ordering, pack/commit),
  `accessor.ts` (`inboxWriter(env)`, T02-D11), `writer.ts` (the real `InboxWriter` DO:
  `recordWake` implemented, `ingest` added to `InboxWriterApi`, `alarm()`).
- `workers/o11y/src/index.ts` — real handlers for `POST /telemetry/{collect,v1/logs,deploy,hooks/sentry}`
  registered through the router; every other contract §1 path (`lite`, `/grafana/*`,
  `reopen`, `admin`) still answers `501`, exactly as T00's scaffold did, until its owning
  task registers a handler.
- `workers/o11y/src/env.ts` (T00's file, edited as COMMON.md interface 1 explicitly
  anticipates — "further methods are added by T02 (ingest)"): `IngestItem`/`IngestOutcome`/
  `IngestResult` types, `InboxWriterApi.ingest`, `RATE_LIMITER: RateLimit`, optional
  `SERVICE_VERSION`.
- `workers/o11y/wrangler.jsonc` (T02's row: "the DO/R2/AE/rate-limit parts"): added the
  `ratelimits` binding (T02-D8) and a comment on `SERVICE_VERSION`'s absence.
- `workers/o11y/wrangler.probe.jsonc` — the sandbox-probe-only config (kept, committed, for
  reproducibility; deploys nothing on its own).
- Fixtures: `pipeline/fixtures/faro/{exception-code-frame,measurement,web-vitals,example-open,log}.json`
  (real `TransportBody` wire shape); `pipeline/fixtures/otlp/json/{basic,zero-timestamp,forbidden-attrs}.json`;
  `pipeline/fixtures/otlp/protobuf/{basic,zero-timestamp}.bin` + the hand-rolled
  `build-protobuf-fixtures.mjs` generator (both decoders verified to agree on the same
  content); `pipeline/fixtures/otlp/{deploy-event,sentry-issue}.json`.
- `scripts/o11y-replay-fixtures.mjs` — replays every fixture against a running
  `wrangler dev`, freshening Faro timestamps (one deliberately shifted outside the ±5 min
  clamp window), signing the Sentry HMAC, exercising exit criterion 4's duplicate-delivery
  shape.
- Test harness (not named in this task's "Owns" row, but necessary infrastructure nothing
  else provides — see Concerns): `pipeline/fixtures/o11y-worker-hooks.mjs` (`.js`→`.ts`
  remap under `workers/o11y/src/`, `cloudflare:workers`/`@cloudflare/containers` stubs, a
  `jose`/`@handsontable/demo-runtime` resolution borrow for test files outside
  `workers/o11y/`), `o11y-cloudflare-{workers,containers}-stub.mjs`, `o11y-harness.mjs`
  (`makeEnv`, `makeDurableObjectStorage`, `makeR2Bucket`, `makeAnalyticsEngine`).
- `pipeline/o11y-{gates,normalise,inbox,routes}.test.mjs` — 49 `node --test` cases.
- One fix outside T02's "Owns" row, `packages/runtime/src/telemetry/facade.ts` (T00's
  file) + its regression test `pipeline/telemetry-facade.test.mjs` — see T02-D14.

### Deviations (T02-D)

- **T02-D1 — what gets hashed.** ADR §B.2 step 2 says hash "before any arrival-time value
  exists," but a `NormalisedRecord` already carries its *final*, clamped `timeUnixNano`.
  Hashing that would break exit criterion 4's zero-timestamp case (two deliveries "seconds
  apart" clamp to two different `receivedAtMs` values). Implemented: hash over
  `{body, resourceAttributes, attributes, rawEventTime}` where `rawEventTime` is the
  record's own *raw*, un-clamped source timestamp (Faro's `payload.timestamp` string, or
  OTLP's raw `time_unix_nano`/`observed_time_unix_nano`, `""` when absent) — genuinely part
  of the original body, unlike the arrival time, so two real events with identical text but
  different real timestamps still hash differently. `normalise/hash.ts`. Proven by
  `o11y-normalise.test.mjs`'s two "hashes identically across redelivery" cases and
  `o11y-routes.test.mjs`'s end-to-end exit-criterion-4 test.
- **T02-D2 — no clamping for OTLP.** `convert.ts`'s doc comment suggests `clampTimestampMs`
  is usable for "T02's Cloudflare-OTLP-export path too" — this is wrong against ADR §C.2,
  which clamps only browser/beacon timestamps; OTLP keeps `time_unix_nano` → fallback
  chain, no window check (a replayed sandbox-probe fixture days later must still pass exit
  criterion 3). `normalise/otlp.ts` never calls `clampTimestampMs`; every nanosecond value
  stays a decimal string, never round-tripped through a `number` of milliseconds (which
  loses precision past 2^53 ns, ≈104 days). Proven: `o11y-normalise.test.mjs`'s "a real
  time_unix_nano is never clamped, even far from receivedAtMs" case.
- **T02-D3 — one aggregated `o11y.ingest` point per request, not per record.** Exit
  criterion 4 requires "one duplicate point" for a batch of N duplicate records — a point
  per record would make that indistinguishable from N separate deliveries in a query.
  `normalise/respond.ts#respondIngested` writes one `accepted` point (`count = N`) and one
  `duplicate` point (`count = M`) per request. Proven: the exit-criterion-4 route test
  asserts exactly one `duplicate`-outcome point exists after the second delivery.
- **T02-D4 — the AE-only browser attribute channel.** `HotAttrs` fields `toAePoint` reads
  (`reason`, `route_class`, `fingerprint`, `model`, `provider`, `device`, `bucket`, `ref`,
  `area`) are not part of `attrs.ts#ALLOWED_ATTRIBUTE_KEYS` — that allowlist governs the
  small, privacy-conscious §3 resource/structured-metadata set, not §4's richer AE layout.
  `normalise/browser-attrs.ts` reads these from a Faro item's **raw, pre-scrub**
  `context`/`attributes` under `hot.<column>` keys, with one deliberate exception:
  `hot.kind` is reserved (the Faro item kind) and always overwritten by
  `convert.ts#faroItemToRecord`, so ADR-0042's "kind" AE column (`docs`/`starter`/…) is read
  from `hot.metric_kind` instead to avoid the collision. These values never reach storage
  (only `toAePoint`), so they get their own light sanitisation
  (`redactPreviewHosts`+`stripQueryAndFragment`+256-char cap) rather than the authoritative
  scrubber. **T06 must send these exact key names** for `example.*`/measurement/exception
  AE attributes to reach Analytics Engine at all — nothing else pins this convention today.
- **T02-D5 — §3 resource-attribute defaults.** Exit criterion 15 needs all eight keys
  present on every record; several sources have no natural value for
  `hot.tier`/`framework`/`ht_major`/`outcome`. `normalise/points.ts#withResourceAttrDefaults`:
  `"none"` for tier/framework/ht_major/outcome (all three list `"none"` as a real contract
  value except outcome, which has no closed set at the record level — only `toAePoint`'s
  per-metric check constrains it); `hot.surface` defaults via a `service.name` → surface
  table (`demos-api→api`, `demos-authoring→authoring`, `demos-o11y→o11y`,
  `demos-embed→embed`, unknown→`api`); `deployment.environment.name` falls back to
  `env.O11Y_ENV`. **Found and fixed a real bug from this**: the same defaulted
  resourceAttributes bag was originally reused to build AE point attrs, so a metric with no
  outcome slot (e.g. `example.open`) got a spurious `outcome: "none"` and `toAePoint` threw,
  silently *storing the record anyway* (the outer catch fell through) — an `example.open`
  event was landing in the inbox instead of staying AE-only. Fixed by snapshotting
  `clientResourceAttributes` *before* filling defaults and using that snapshot for every AE
  point call. Caught by `o11y-normalise.test.mjs`'s `example.open` case, which failed for
  exactly this reason before the fix.
- **T02-D6 — unpacking the Faro wire body.** `@grafana/faro-web-sdk`'s real transport posts
  a `TransportBody` (`{meta, exceptions?, logs?, measurements?, events?, traces?}`), not an
  array of self-contained `{type, payload, meta}` items the way `ScrubbableFaroItem` (and
  every item-shaped contract function) assumes — confirmed by reading the installed
  `@grafana/faro-core` types (`transports/types.d.ts`), not guessed. `normalise/faro.ts#processFaroBody`
  reconstructs items from the four typed arrays, sharing one `meta`; `traces` is never
  unpacked (ADR §C.4) and counts as one dropped/invalid item if present.
- **T02-D7 — query strings and user agents inside free body text.** `scrubTelemetry`'s
  `stripQueryAndFragment` only runs on discrete URL fields (`meta.page.url`, a stack
  frame's `filename`); `reduceBrowserMeta` only reduces the *structured* `meta.browser.userAgent`
  field. Neither reaches a URL or UA string merely *embedded* inside a body/message string
  (a real shape: the Sandbox SDK's stale-preview-URL warning text). This task's acceptance
  criteria ban both "over all fixtures," stricter than the contract module alone
  guarantees. `normalise/text-scrub.ts#scrubBodyText` (query/fragment strip on any embedded
  `https?://` URL, `Mozilla/<ver> (…)` UA-prefix redaction) runs on every OTLP/Faro record's
  body, after `scrubTelemetry`, never instead of it. Proven by the `forbidden-attrs.json`
  fixture test and its `Mozilla/`/`?t=1700000000` assertions.
- **T02-D8 — the rate-limit binding was addable now.** T00 left `RATE_LIMITER` out of
  `wrangler.jsonc`, believing it "needs a real namespace id from the dashboard." Measured
  false: `wrangler`'s own `config-schema.json` (`ratelimits[].namespace_id`: a free-form
  string) and a real `wrangler deploy --dry-run` (`env.RATE_LIMITER (100 requests/60s)`,
  accepted with `namespace_id: "1001"`, no dashboard resource needed). Limit `100`
  req/60s per `cf-connecting-ip` is an unmeasured starting value (see Concerns).
- **T02-D9 — the GitHub OIDC audience.** ADR §B.5 names "issuer, audience, repository,
  workflow" but the contract pins no audience string. Chose
  `https://demos.handsontable.com/telemetry/deploy` (GitHub's own "identify the intended
  recipient" recommendation) in `gates/oidc.ts#O11Y_GITHUB_OIDC_AUDIENCE` — **T10's deploy
  workflow must request its `id-token` with exactly this `audience` query parameter**, or
  every deploy event falls through to the secret fallback instead of the OIDC path.
- **T02-D10 — router precedence and duplicate-registration guard.** Not specified by
  COMMON.md interface 2 beyond "exact, or a prefix when it ends in `/*`". Implemented:
  exact match beats any prefix; among prefixes, the longest wins (so T03's exact
  `/grafana/_o11y/reopen` beats T01's catch-all `/grafana/*` regardless of registration
  order); `registerRoute` throws on a duplicate `method`+`path` rather than silently
  shadowing the first registration.
- **T02-D11 — one DO accessor, with a local-mode jurisdiction skip.**
  `env.INBOX_WRITER.idFromName("main")` and `env.INBOX_WRITER.jurisdiction("eu").idFromName("main")`
  address *different* objects — every caller (T02's own routes, T01's `GrafanaBox.recordWake`,
  T03's ledger/backlog, T04's alert cron) must go through `inbox/accessor.ts#inboxWriter(env)`,
  never repeat the two-call chain. **Measured against a real `wrangler dev`, not assumed**:
  calling `.jurisdiction("eu")` at all throws `Error: Jurisdiction restrictions are not
  implemented in workerd` under local Miniflare simulation — not a silent no-op the task
  file's own Traps section ("Jurisdiction is not enforced locally") suggested, an actual
  exception that 500'd every route until fixed. `inboxWriter` skips the call when
  `O11Y_ENV === "local"`; production is unaffected.
- **T02-D12 — size caps, unmeasured against real traffic.** `gates/limits.ts`:
  `COLLECT_MAX_BYTES = 1_000_000` (matches `LOKI_REQUEST_MAX_BYTES`), `OTLP_MAX_BYTES =
  4_000_000` (matches `PACK_AT_BYTES`), `SMALL_JSON_MAX_BYTES = 64_000` (deploy/Sentry).
  The sandbox probe was meant to measure real batch sizes; it could not reach real traffic
  at all (see Sandbox probe below), so these stay documented defaults, not derived numbers.
- **T02-D13 — the deploy record's identity and body shape (controller-pinned mid-task).**
  First draft used the *deploying* service's own identity
  (`service.name = payload.service`) as the record's resource attributes and a
  human-readable body string. The controller specified T09's Runner-overview annotation
  query is already written against a different shape: resource attributes are the **o11y
  worker's own** self-identity (`service.name = demos-o11y`, `hot.surface = o11y` — a
  deploy event is an annotation the o11y worker *reports about* a third-party deploy, the
  same pattern `o11y.ingest`'s own points use, `normalise/respond.ts#o11ySelfIdentity`),
  and the body is `JSON.stringify({event: "deploy", service, sha, cf_version_id})` —
  `event: "deploy"` is this task's own addition, not named in ADR §C.2's
  `{service, sha, cf_version_id}`, added so an annotation query can filter on it without a
  body-text regex. Implemented in `normalise/deploy.ts`; proven by a dedicated
  `o11y-routes.test.mjs` case that decodes the actual packed R2 object and asserts both the
  resource attributes and the body shape.
- **T02-D14 — a real bug in T00's file, fixed outside this task's "Owns" row
  (`packages/runtime/src/telemetry/facade.ts`).** `noopTelemetry` minted its `pageLoadId`
  eagerly, in a module-scope IIFE, calling `crypto.randomUUID()` before any request handler
  ran. Discovered running this task's own required `wrangler dev` verify step (not by
  reading source): the whole o11y Worker failed to start with `Disallowed operation called
  within global scope` — `@handsontable/demo-runtime/telemetry`'s barrel transitively
  imports `facade.ts`, so this blocked T02 from completing its own Verify block, not a
  theoretical concern. Fixed by lazy memoization (`pageLoadId()` mints on first call, cached
  after); value/stability unchanged everywhere else. COMMON.md explicitly allows a minimal,
  justified touch outside "Owns" for exactly this — a real bug blocking a required
  verification step. Regression test: `pipeline/telemetry-facade.test.mjs` (spies on
  `crypto.randomUUID`, asserts zero calls at import time, one call on first `pageLoadId()`),
  reverted and seen red (`1 !== 0`) before being restored.
- **T02-D15 — OTLP protobuf: only scalar `AnyValue` kinds decoded.** `otlp-protobuf.ts`'s
  hand-rolled decoder (wire-primitive only, `@bufbuild/protobuf/wire`'s `BinaryReader` —
  T00's pinned no-eval choice) renders `array_value`/`kvlist_value` as a placeholder string
  rather than recursively decoding them. No fixture, and no real captured Cloudflare export
  (see Sandbox probe), ever put a nested value under an allowlisted `hot.*`/`service.*`/
  `deployment.*` key — every one is a plain string by contract. Flagged for T03/whoever next
  touches this decoder if the probe is retried and observes otherwise.
- **A test-only fixture-generator bug, caught before it shipped bad fixtures**:
  `build-protobuf-fixtures.mjs`'s first draft wrapped a whole `repeated KeyValue` loop in
  one shared `tag().fork()`, instead of one tag+length-prefix per element (protobuf's actual
  wire rule) — decoded back to concatenated garbled keys with empty values. Found by
  decoding the generated `.bin` immediately after generating it (not assumed correct),
  fixed, re-verified byte-for-byte against the JSON fixture's content field-by-field.

### Sandbox probe

Deployed `handsontable-demos-o11y-probe-t02` to the sandbox account
(`e17e41cc82bda15dfa63960aa172fb87`), `--config wrangler.probe.jsonc`, after
`wrangler whoami`. Created: R2 bucket `o11y-probe-t02-inbox` (`wrangler r2 bucket create`);
the Worker itself (`workers_dev: true`, live at
`https://handsontable-demos-o11y-probe-t02.handsontable-sandbox.workers.dev`). Smoke-tested
both a 404 on an unknown path and a real `POST /telemetry/v1/logs` round trip (`204`) —
the deployed probe's own ingest pipeline works for real on Cloudflare, not just under
`wrangler dev`.

**Blocked**: could not create a Cloudflare "Workers Observability Telemetry Destination"
(`POST /accounts/{id}/workers/observability/destinations`, `logpushDataset:
"opentelemetry-logs"`) — every attempt (the `cloudflare` MCP tool's `execute`, and a raw
`curl` using wrangler's own stored OAuth token, which *did* successfully create the R2
bucket and deploy the Worker moments earlier) returned `{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}`.
Wrangler's OAuth token scope list (`~/Library/Preferences/.wrangler/config/default.toml`)
has no `workers_observability`-shaped scope at all — confirmed a missing-scope/plan
limitation, not a transient error, before stopping (COMMON.md: "record exactly what
failed and continue with the local work; do not improvise around it on another account").
Without a real destination, no real Cloudflare OTLP export body could be captured, so
content type, real batch sizing, and the forced-5xx/forced-timeout exporter behaviour
(the probe section's other asks) are **not measured** — the fixtures in
`pipeline/fixtures/otlp/` are hand-built against the OTLP proto/JSON spec, not captured
traffic. T02-D15 documents the resulting risk on the protobuf decoder specifically.

**Deleted afterward, confirmed absent**: the probe Worker (`wrangler delete`, then
`wrangler deployments list` → `10007: This Worker does not exist`) and the R2 bucket
(`wrangler r2 bucket delete`, then `wrangler r2 bucket list` → absent). **Not deletable**:
the `o11y_probe_t02_events` Analytics Engine dataset (no delete API exists for AE
datasets) — it holds exactly one synthetic `o11y.ingest` point from the smoke test, no
PII, and ages out under AE's own 3-month retention; the rate-limit namespace id `2002`
is not a provisioned resource and needed no cleanup.

**Exit criterion 15's label check — run locally instead, per the dispatch's explicit
fallback** ("record the label check as pending T01/T03 ... unless you can run it against a
plain grafana/loki container you start yourself on your port block"): started a throwaway
`grafana/loki:3.3.0` container (`docker run`, port 4310, filesystem storage, a minimal
`otlp_config.resource_attributes.attributes_config` promoting the eight §3 keys to
labels — mirroring ADR §B.4), pushed one real `buildResourceLogs()`-shaped OTLP payload
built from the `exception-code-frame.json` fixture through this task's own
`processFaroBody` (not a hand-typed payload — the actual pipeline output). Result,
queried back from Loki itself:

- `GET /loki/api/v1/labels` → exactly `["deployment_environment_name", "hot_framework",
  "hot_ht_major", "hot_outcome", "hot_surface", "hot_tier", "service_name",
  "service_version"]` — the eight contract keys, nothing else.
- `GET /loki/api/v1/series?match={hot_surface="authoring"}` → one series, all eight
  labels populated with the expected values (`hot_outcome: "none"` from the T02-D5
  default, confirming that default reaches a real label correctly).
- A `query_range` for the same series returns the stored line
  (`"ReferenceError: x is not defined"`, code frame and preview host already stripped)
  with `hot_kind: "exception"` visible as **structured metadata inline on the line**, but
  — critically — absent from the `/labels` list: confirms `hot.demo_id`/`session.id`/
  `cf.ray`/`hot.kind` reach Loki as queryable structured metadata without ever becoming
  an index label, the second half of exit criterion 15.

This is real, positive local evidence for the Faro source specifically (the only source a
plain `docker run` container lets this task push through end to end without T03's drain).
Container and its config file removed afterward (`docker rm -f`, config file deleted).
**Still pending T01/T03**: the same check against a real Cloudflare export body (blocked
above) and against the box's actual S3-backed Loki config once T01's compose stack exists.

### Test-failing-when-reverted evidence

| Reverted | Test(s) that went red |
|---|---|
| `browser.ts`: each of host/bot/size/rate-limit checks disabled one at a time | the matching case in `o11y-gates.test.mjs` |
| `secret.ts`: the "absent secret fails closed" branch removed | the "missing config fails closed" case |
| `sentry.ts`/`oidc.ts`: constant-time compare / JWT verify bypassed | the matching wrong-signature/wrong-repository cases |
| `access.ts`: `DEV_ADMIN`'s `O11Y_ENV === "local"` guard removed | the "never in production" case |
| `hash.ts`: `rawEventTime` included `receivedAtMs` instead of the raw source value | both "hashes identically across redelivery" cases in `o11y-normalise.test.mjs`, and the route-level exit-criterion-4 case |
| `otlp.ts`: `clampTimestampMs` reinstated on the OTLP path | "a real time_unix_nano is never clamped" |
| `text-scrub.ts`: `scrubBodyText` calls removed from `otlp.ts`/`faro.ts` | the `forbidden-attrs.json` query-string/UA/preview-host assertions |
| `points.ts`: `withResourceAttrDefaults` reverted to use the same bag for AE attrs (the T02-D5 bug) | the `example.open` case (`toAePoint` throws, falls through, item wrongly stored) |
| `deploy.ts`: resource identity/body reverted to the pre-T02-D13 shape | the dedicated deploy-shape route test |
| `facade.ts`: eager IIFE restored | `telemetry-facade.test.mjs` (`1 !== 0`) — reproduced, confirmed, then restored and re-verified green |
| `pack.ts`: numeric row sort reverted to raw `storage.list()` order | the "numeric row order, not lexicographic" inbox test (11-row fixture, `row:10` before `row:2` under the bug) |
| `inbox/writer.ts`: `recordWake` "mark every earlier wake over" loop removed | the `recordWake` inbox test |

### Verify — commands run, exit codes

All via `rtk proxy <command>; echo "exit=$?"` from `runner/`, per COMMON.md; rtk's own
summaries not trusted, exit codes and raw output read directly.

```
rtk proxy pnpm install                                            exit=0
rtk proxy pnpm --filter @handsontable/demo-runtime build           exit=0
rtk proxy pnpm -r run typecheck                                    exit=0 (5 of 6 workspace projects — pipeline has no typecheck script)
rtk proxy pnpm test                                                exit=1 (1299 tests, 1296 pass, 1 pre-existing unrelated failure — "the pin tracks its own major's starter bucket", confirmed the same baseline failure T00 reported — 2 todo; all 49 new o11y-* cases plus the facade regression pass)
( cd workers/o11y && npx wrangler deploy --dry-run )               exit=0
( cd workers/api && npx wrangler deploy --dry-run )                exit=0 (unaffected by this task's changes; run to confirm no cross-worker regression)
node scripts/check-test-presence.mjs feat/runner-observability     exit=0 (post-commit; see below)
```

Live `wrangler dev` round trip (the task's own Verify block, run on this task's port
block, 4300–4399, not the block's literal `8788` example):

```
( cd workers/o11y && npx wrangler dev --port 4300 --inspector-port 4301 )
O11Y_EXPORT_SECRET=<from .dev.vars> SENTRY_HOOK_SECRET=<from .dev.vars> \
  node scripts/o11y-replay-fixtures.mjs --base http://localhost:4300
```

Every fixture answered `2xx` (`204`) after the storage commit. After forcing the pack
alarm (`InboxWriter.alarm()` via a direct call, and — separately — by waiting the real
60 s and reading `/cdn-cgi/local/explorer/api/r2/buckets/handsontable-demos-o11y-inbox/objects`)
local R2 held `inbox/browser/2026-09-23/11/000000000000.ndjson.gz` and
`inbox/worker/2026-09-23/11/000000000001.ndjson.gz` — a strictly increasing shared `seq`
across tenants, valid `ResourceLogs` lines, contract resource attributes populated.

### Concerns / follow-ups

- **Test harness files exist outside this task's literal "Owns" glob**
  (`pipeline/fixtures/o11y-worker-hooks.mjs`, `o11y-harness.mjs`,
  `o11y-cloudflare-{workers,containers}-stub.mjs`): the Owns row names only the four
  `pipeline/o11y-*.test.mjs` files and the two fixture directories. Nothing else provided a
  route-level harness for the o11y worker (`workers/api`'s `worker-hooks.mjs`/`worker-harness.mjs`
  only cover that worker's own module tree), and TESTING.md's own anti-pattern #2 ("the
  untested router") is exactly what skipping this would have reproduced. Created as the
  minimum necessary infrastructure, same spirit as `workers/api`'s existing pattern, not a
  scope expansion into another task's files.
- **`pipeline/telemetry-facade.test.mjs`** is also outside this task's Owns row (T00-D9-style:
  the file didn't exist, nothing else claims it) — the regression test for T02-D14's
  cross-boundary fix.
- Size caps (T02-D12) and the rate-limit threshold (T02-D8) are unmeasured against real
  traffic — the sandbox probe that would have measured them is blocked (see above). Revisit
  once T01/T03's local box or a working observability destination lets real volume through.
- The OIDC audience (T02-D9) is this task's own choice; **T10 must match it exactly** when
  it wires the deploy CI workflow's `id-token` request.
- T02-D4's AE-only browser-attribute key convention (`hot.reason`, `hot.metric_kind`, …) has
  no other pin in the codebase; **T06 must use these exact names** or ADR-0042/session
  metrics silently never reach Analytics Engine (the record would still store fine — only
  the AE point would come back empty of that field, easy to miss in review).
- T02-D15: the protobuf decoder's `array_value`/`kvlist_value` gap is unverified against
  real Cloudflare export traffic — revisit if/when a destination can be created.
- The `o11y_probe_t02_events` Analytics Engine dataset (sandbox account) could not be
  deleted (no delete API); harmless, noted for completeness per COMMON.md's "list what was
  created and deleted."
