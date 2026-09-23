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
- `workers/o11y/wrangler.probe.jsonc` — **not in the tree** (removed in the fix round per the
  controller: probe configs are throwaway and should not be committed, and the first version
  carried a plaintext probe secret). See "Fix round" below for how the probe was actually run.
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

**Originally blocked, then unblocked and re-run — see "Fix round: sandbox probe re-run"
below for the full transcript.** The first pass could not create a Cloudflare "Workers
Observability Telemetry Destination" (`POST /accounts/{id}/workers/observability/destinations`)
with wrangler's own OAuth token, which lacked the scope — confirmed a missing-scope
limitation, not a transient error, and reported as blocked per COMMON.md at the time. The
user subsequently created a properly-scoped sandbox API token (COMMON.md's "Probe
credentials" section), and the probe was re-run to completion in the fix round: a real
export destination, a real captured Cloudflare OTLP export body (content type, batch
sizing, attribute placement, forced-5xx exporter behaviour all measured), two real
contract-conformance bugs found and fixed (T02-D16, T02-D17), and exit criterion 15
re-confirmed against the real captured (scrubbed) data. The hand-built fixtures in
`pipeline/fixtures/otlp/` remain as the deliberate edge-case set (zero-timestamp, oversize,
forbidden-attributes); `pipeline/fixtures/otlp/json/cloudflare-invocation-log.json` is the
new real-captured-and-scrubbed one, added in the fix round.

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
- T02-D15: the protobuf decoder's `array_value`/`kvlist_value` gap is still unverified
  against real Cloudflare export traffic — every real sample captured in the fix round's
  probe re-run was `application/json` (gzip-encoded), never protobuf; see the Fix round
  section.
- The `o11y_probe_t02_events` Analytics Engine dataset (sandbox account, first probe pass)
  could not be deleted (no delete API); harmless, noted for completeness per COMMON.md's
  "list what was created and deleted." The fix round's re-run used a differently-named
  dataset region (its own `RUNNER_EVENTS` binding pointed at the real `runner_events`
  local-mode fallback was not exercised — the probe never wrote to Analytics Engine in the
  second pass, only R2).
- **Open question for T05**: whether the API worker's own hand-authored `console.log`
  JSON line (ADR §D's structured line, meant to carry `route_class`/`status`/`duration`/
  `cf.ray`/`session.id`/`hot.demo_id`/`service.version`) arrives at this Worker's
  `/telemetry/v1/logs` with those fields as real OTLP record **attributes** (this task's
  `hoistAttributes`-based decode would then find them), or embedded only inside
  `body.stringValue` as opaque JSON text (in which case none of them would reach storage as
  attributes at all, and T05's own console.log call would need to change shape, or this
  task's `otlp.ts` would need a body-JSON-parsing step). A deliberate test of this (a
  temporary probe Worker with one `console.log(JSON.stringify({...}))` call, attached to
  the same real export destination) was set up in the fix round but could not be completed
  — the sandbox account's automation guardrails declined a further background polling
  command against cloud resources mid-experiment ("Modify Shared Resources"), and per that
  guardrail's own instruction this was not worked around. Every other real capture in this
  task (Cloudflare's own automatic `invocation_logs` summaries, captured extensively) is
  conclusively answered; this one console.log-specific question is not. T05 should
  either resolve this with its own probe before assuming `hoistAttributes` sees its fields,
  or send the required fields as real OTLP attributes explicitly (not relying on this being
  parsed from body text, which `otlp.ts` does not do).

## Fix round (controller review)

Findings I1–I3 plus a controller addition (remove `wrangler.probe.jsonc`) and a follow-up
message unblocking the sandbox probe with a properly-scoped API token. Commit `735ea1e4d`.

### I1 — GitHub OIDC gate missing the `workflow` check

ADR §B.5's `deploy` row names four checks ("issuer, audience, repository, workflow"); the
first pass implemented only three. Fixed in `gates/oidc.ts`: `checkGithubOidc` now also
compares the token's `workflow_ref` claim against a new `env.GITHUB_OIDC_WORKFLOW_REF`
(added to `env.ts`, `wrangler.jsonc`'s `vars`, and the test harness/fixtures), exact match.

**T02-D16 — the expected `workflow_ref` value.** GitHub's OIDC `workflow_ref` claim shape
is `<owner>/<repo>/<workflow file path>@<ref>`; for a workflow that runs directly (not via
`workflow_call`) this equals `job_workflow_ref` too, so `workflow_ref` alone is checked.
Pinned value: `handsontable/examples/.github/workflows/master.yml@refs/heads/master` — a
var, not a secret, so T10 can read it back and must request its `id-token` from exactly
this workflow/ref or every deploy event falls through to the `x-o11y-secret` fallback.

**A real test-validity bug, found by the revert check itself, not by inspection.**
`gates/oidc.ts#githubJwks()` caches the remote JWKS fetcher in a `Map` keyed by the
constant issuer string. `jose`'s remote key set has its own ~30 s no-refetch cooldown on a
`kid` miss. The gate test file signs a *fresh* RS256 key pair per test case — so every test
after the first was reusing an earlier test's now-wrong cached key set, and would fail JWT
verification with `JWKSNoMatchingKey` (an unrelated reason) while still asserting
`ok: false` / `reason: "oidc"`, passing whether or not the actual `workflow_ref`/`repository`
check under test was even present. Caught during I1's own revert check: commenting out the
new workflow check kept the "wrong workflow" test green. Fixed with an exported
`_resetGithubJwksCacheForTests()`, called at the top of every `signGithubToken()` call in
`o11y-gates.test.mjs`. After the fix, the same revert (workflow check removed) turned the
test red for the right reason (`true !== false`).

### I2 — the Faro ingest path never enforced the 256 KB record cap

`normalise/otlp.ts` already dropped records over `INBOX_RECORD_MAX_BYTES` before this fix
(§B.2 step 1: "drop records over 256 KB"); `normalise/faro.ts` did not, even though
`pack.ts`'s row-chunking and the contract's own §8 rule assume normalise enforces this on
every path. Fixed: `processOneItem` now checks the serialized record size the same way
`otlp.ts` does, returning `{ aePoints, oversize: true }` instead of an `ingestItem` when
over the cap. `ProcessedFaroItem` gained an `oversize` field, distinct from `invalid` (see
I3). `index.ts`'s `handleCollect` now checks `p.oversize` alongside `p.invalid`.

### I3 — oversize drops were recorded as `invalid_item`, not `size`

Both paths' oversize drops went through `recordInvalidItem` (`reason: "invalid_item"`),
even though the task's own Scope text and `otlp.ts`'s own doc comment already said
`reason=size`. A real observability gap: an operator querying `o11y.ingest` filtered on
`reason="size"` to watch for oversized payloads would have seen nothing. Fixed:
`normalise/respond.ts#recordOversizeDrop` (new), writing `reason: "size"`; both
`handleCollect`'s Faro-oversize branch and `handleOtlpLogs`'s `droppedOversize` loop now
call it instead of `recordInvalidItem`.

### Controller addition — `wrangler.probe.jsonc` removed from the tree

`git rm`'d. Probe configs are throwaway (COMMON.md) and this one carried a plaintext probe
secret in its first version. The fix round's probe re-run (below) used a temporary,
never-committed config (`workers/o11y/.probe-scratch/`, deleted at the end of the session)
and a real `wrangler secret put` for its export secret instead of a plaintext var.

### Fix round: sandbox probe re-run (unblocked)

The user created a sandbox API token scoped for Workers Scripts, Workers Observability, R2
and Containers (COMMON.md's "Probe credentials" section, `~/.config/o11y-probe/env`,
sourced per command, never printed, per its own rules). Re-ran the previously-blocked
half of the probe:

**Setup** (all prefixed `o11y-probe-t02`, all sandbox account
`e17e41cc82bda15dfa63960aa172fb87`): a real ingest-routes Worker
(`handsontable-demos-o11y-probe-t02`, this task's actual `src/index.ts`, `workers_dev:
true`, `observability.logs.invocation_logs: true` — diverging from production's `false` on
purpose, to generate real exportable content, since this task's own routes never
`console.log` on well-formed traffic by design) with its `O11Y_EXPORT_SECRET` set via a
real `wrangler secret put` (piped from a freshly generated value, never printed); a
separate, minimal raw-capture Worker (`o11y-probe-t02-capture`, not this task's code at
all — just stores whatever bytes/headers it receives into R2) as the actual destination
target, so captured bodies are Cloudflare's real wire format, untouched by this task's own
scrub pipeline; a Workers Observability Telemetry Destination
(`POST /accounts/{id}/workers/observability/destinations`, `logpushDataset:
"opentelemetry-logs"`, `skipPreflightCheck: true`) pointed at the capture Worker with the
same secret as an `x-o11y-secret` header, attached to the source Worker via its
`observability.logs.destinations` config field (confirmed attached via
`GET /workers/scripts/.../settings`, not just assumed from the wrangler config).

**A credential-handling mistake, corrected.** Twice, the destination-create/patch API
response's `configuration.destination_conf` field (not `configuration.headers`, which was
correctly redacted both times) embedded the export secret in plaintext as a URL query
parameter, and a redaction filter that only stripped `headers` let it print to the
transcript both times. Both times the secret was rotated immediately afterward (a fresh
`wrangler secret put` + a `PATCH` of the destination with the new value) before continuing,
and the destination and both probe Workers were deleted at the end of the session regardless
(see Cleanup) — no persisting resource was ever reachable with the leaked value. Recorded
here in full rather than omitted, per the "never print" rule this violated.

**Real findings, content type and shape:**

- Every captured export body was `Content-Type: application/json`, `Content-Encoding:
  gzip` — never protobuf in any sample (7 real captures, one forced-error, one
  console.log-JSON-line probe). Confirms `normalise/read-body.ts#readCappedBytes`'s
  transparent gzip handling on the ingest side was necessary, not defensive over-caution.
- Real batch sizes: one `resourceLogs` entry per Worker invocation (never batched under one
  shared `resource`), 5–13 records per delivered object across bursts of 15–30 requests —
  batching correlates with recent volume/time, not a fixed count; a genuine "batches per
  minute" figure needs sustained production-shaped load this synthetic burst does not
  represent.
- `timeUnixNano` and `observedTimeUnixNano` are both always present with real nanosecond
  precision on every captured record; `severityNumber` (e.g. `9`) is present,
  `severityText` is always absent (`null`) — `normalise/otlp.ts` already treats
  `severityText` as optional, so no change needed there.
- **Attribute placement, confirmed real**: `url.full`, `user_agent.original`, `geo.timezone`,
  `geo.continent.code`, `geo.country.code`, `geo.locality.name`, `geo.locality.region`,
  `cloudflare.asn` all arrive as **record** attributes (not resource), and none of them
  match a contract-allowlisted key — confirmed correctly dropped by `hoistAttributes`
  already, no change needed. Resource attributes never include *any* `hot.*` key or
  `service.version` — Cloudflare's own automatic export has no way to know either;
  `withResourceAttrDefaults` filling both is the actual, load-bearing mechanism for exit
  criterion 15 on this source, not a defensive nicety (T02-D5 is now measured-necessary,
  not assumed).
- **T02-D17 (new) — `cloudflare.ray_id`, not `cf.ray`.** The real ray id arrives under the
  Cloudflare semantic-convention key `cloudflare.ray_id`; the contract's own key
  (`cf.ray`) never appears. Without a remap, `hoistAttributes` (which only recognises the
  contract's own key names) silently dropped it — a real gap, since `cf.ray` is explicitly
  named as structured metadata every record should carry when available (§3). Fixed:
  `normalise/otlp.ts#CLOUDFLARE_KEY_REMAP`/`remapCloudflareKeys`, applied before
  `hoistAttributes`. Only this one key was found needing a remap in the captured samples.
- **T02-D18 (new) — `service.version` is never present in a real Cloudflare export.**
  Confirmed directly (not inferred): every one of the 7 real captures' resource attributes
  omitted `service.version` entirely, even though `service.name` was always present.
  `withResourceAttrDefaults` (`normalise/points.ts`) now defaults it to `"unknown"`, the
  same pattern as the other seven §3 keys it already defaulted (T02-D5).
- **Forced 5xx, real exporter behaviour**: redeployed the capture Worker to always answer
  `500`, generated traffic against the source Worker, and within about 90 seconds the
  destination's `jobStatus` recorded `last_error: "2026-09-23T12:26:53Z"`,
  `error_message: "error 500: error pushing: error uploading to https: status:500"` — a
  clear, timestamped, single-attempt failure record (not a crash, not a silent drop).
  Forced-timeout behaviour (a capture Worker that hangs 30 s) was implemented
  (`FAIL_MODE=hang` in the scratch capture worker) but not exercised before cleanup — no
  `jobStatus` change was observed for it; unmeasured, noted as a gap.
- One captured sample was Cloudflare's own destination-creation "pre-flight check" ping
  (`service.name: cloudflare-workers-observability`, body `"Hello from Cloudflare 👋
  (o11y-probe-t02-dest)"`), sent automatically even with `skipPreflightCheck: true` in the
  create request — informational, not used as a fixture.

**Real fixture added**: `pipeline/fixtures/otlp/json/cloudflare-invocation-log.json` — one
real captured `resourceLogs` entry, scrubbed (script name → `handsontable-demos-api`,
version ids → zeroed placeholders, ray id/invocation id → zeroed placeholders, `url.full`/
`server.address`/`url.path` repointed at a fictitious demo URL, `user_agent.original` →
a generic placeholder, `geo.*`/`cloudflare.asn` → generic/zeroed, `cloudflare.colo` in the
*log record* → `"XXX"`; the *resource*-level `cloudflare.colo: "FRA"` — the serving
datacenter, not visitor-identifying — was left as captured). Exercised by a new
`o11y-normalise.test.mjs` case proving the `cloudflare.ray_id` remap, the `service.version`
default, and that every forbidden field is still dropped, all against this real-shaped
input, not just hand-built ones.

**Exit criterion 15, re-confirmed against real data.** Ran this task's own
`processOtlpBody` over the real (scrubbed) fixture, built the resulting `ResourceLogs`, and
pushed it into a second throwaway local `grafana/loki` container (same `otlp_config` as the
first local check). `GET /loki/api/v1/labels` returned exactly the eight contract keys;
the series carried `service_version: "unknown"` and `hot_tier`/`hot_framework`/
`hot_ht_major`/`hot_outcome: "none"` — the T02-D5/D18 defaults, correctly surfacing as real
labels. `cf_ray` appeared inline on the queried line (structured metadata) but was absent
from `/labels` — confirmed not a label. Container removed afterward.

**Cleanup — everything created, everything deleted, confirmed:**

| Resource | Action | Confirmed |
|---|---|---|
| Export destination `o11y-probe-t02-dest` | `DELETE /workers/observability/destinations/o11y-probe-t02-dest` | `GET` list → `[]` |
| Worker `o11y-probe-t02-capture` | `DELETE /workers/scripts/o11y-probe-t02-capture` | `GET` scripts list → absent |
| Worker `o11y-probe-t02-consolelog` | `DELETE /workers/scripts/o11y-probe-t02-consolelog` | `GET` scripts list → absent |
| Worker `handsontable-demos-o11y-probe-t02` | `DELETE /workers/scripts/handsontable-demos-o11y-probe-t02` | `GET` scripts list → absent |
| R2 bucket `o11y-probe-t02-capture` | objects deleted, then `DELETE /r2/buckets/o11y-probe-t02-capture` | `GET` buckets list → absent |
| R2 bucket `o11y-probe-t02-inbox` | objects deleted, then `DELETE /r2/buckets/o11y-probe-t02-inbox` | `GET` buckets list → absent |
| Local scratch (`workers/o11y/.probe-scratch/`, capture files, temp secret file) | `rm -rf` | not committed, not present in the tree |
| Shared bucket `o11y-probe-t03-loki` (COMMON.md's) | **not touched** — this probe never needed Loki S3 storage | n/a |

**Console-log attribute-placement experiment — incomplete, documented as an open question
for T05** (see Concerns above): a temporary probe Worker with a `console.log(JSON.stringify(...))`
call was deployed and attached to the same destination, but the session's own automation
guardrails declined a further background polling command against sandbox resources before a
delivery could be captured and inspected. Not retried. The Worker
(`o11y-probe-t02-consolelog`) was still deleted in cleanup above.

### Revert evidence (fix round)

| Reverted | Test(s) that went red |
|---|---|
| `gates/oidc.ts`: the `workflow_ref` check removed | the new "wrong workflow" case in `o11y-gates.test.mjs` (initially stayed green due to the JWKS-cache bug above; red after that bug was also fixed) |
| `normalise/faro.ts`: the 256 KB size check removed | the new Faro-oversize case in `o11y-normalise.test.mjs`, and the route-level "reason=size" case in `o11y-routes.test.mjs` |
| `index.ts`: both `recordOversizeDrop` calls reverted to `recordInvalidItem` | both new route-level "reason=size, not invalid_item" cases in `o11y-routes.test.mjs` |
| `normalise/otlp.ts`: `CLOUDFLARE_KEY_REMAP` lookup bypassed | the new real-fixture case in `o11y-normalise.test.mjs` ("cf.ray survives the cloudflare.ray_id remap …") |
| `normalise/points.ts`: the `service.version` default removed | the same real-fixture case |

Every revert was applied in place (not via `git checkout`, after an earlier `git checkout --`
in this same session accidentally discarded an in-progress uncommitted fix — noted so the
mistake isn't repeated), confirmed red for the stated reason, then restored and reconfirmed
green before moving on.

### Fix round — verify, exit codes

```
rtk proxy pnpm --filter @handsontable/demo-runtime build          exit=0
rtk proxy pnpm -r run typecheck                                   exit=0
rtk proxy pnpm test                                                exit=1 (1304 tests, 1301 pass, 1 pre-existing baseline failure, 2 todo)
( cd workers/o11y && npx wrangler deploy --dry-run )               exit=0
( cd workers/api && npx wrangler deploy --dry-run )                exit=0
node scripts/check-test-presence.mjs feat/runner-observability     exit=0 (30 source files, matching test change)
node --experimental-strip-types --test pipeline/o11y-*.test.mjs pipeline/telemetry-facade.test.mjs   exit=0 (56/56)
```
