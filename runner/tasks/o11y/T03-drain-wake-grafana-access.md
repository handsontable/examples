# T03 — Ledger, drain, symbolication, wake and Grafana access (spike b, part 2)

| | |
|---|---|
| Status | done — T03B (part B): fixes F1–F4 shipped with tests, and the sandbox probe re-run confirms exit criterion 1 now PASSES on the real platform (T03-D2's root cause, the drain's NDJSON-vs-OTLP-envelope bug, was fixed on this branch's own base before this pass started); criteria 2, 13 also verified on the real platform. Fix round (findings I1/I2): criterion 7 re-run at the corrected real-traffic scale (T05's own measured 23 lines/session, not 1/session — still PASSES, $0.21–0.33/month), and the (d) fix's merge order no longer lets body-JSON content spoof a real resource attribute — see Outcome |
| Size | L |
| Depends on | T01, T02 |
| Blocks | T09 (live data path), T10, T11 |
| ADR | 0041 §A (wake, stop protocol, waking page), §B.3, §B.4 (push limits), §C.3, §H (Access); exit criteria 1, 2, 5, 7 |
| Owns | `workers/o11y/src/inbox/ledger.ts`, `workers/o11y/src/drain/**` (incl. `symbolicate.ts`), `workers/o11y/src/grafana/**`, the wake/stop parts of `workers/o11y/src/box.ts`, the `*/10` cron in `workers/o11y/wrangler.jsonc`, `containers/o11y/waking/**`, `scripts/o11y-dev.mjs` and the root `o11y:dev` script, `pipeline/o11y-{ledger,drain,symbolicate,wake,grafana-proxy}.test.mjs` |

## Goal

The box wakes only for a backlog or a visitor, every inbox key reaches Loki exactly once
per clean wake and again safely after an unclean one, exceptions are symbolicated, and
Grafana is reachable only by `@handsontable.com` accounts behind a small waking page.

## Read first

- ADR-0041 §A, §B.3, §B.4, §C.3; contract §1, §8.
- T01's stop protocol and marker; T02's `InboxWriter`.

## Scope

In:

- **Ledger** (`inbox/ledger.ts`, running inside `InboxWriter`): the `written` →
  `provisional(wakeId)` → `committed` | `rejected` transitions; on every cron tick and at
  each wake start, resolve every wake that is **over** (a newer `wakeId` started, or
  `GrafanaBox`'s container state says not running): marker in the Loki bucket (read via
  `O11Y_LOKI_STATE`) → commit its keys, no marker → re-open them; a running wake is left
  alone; `POST /grafana/_o11y/reopen` for a time window;
  `backlog()` over `written` keys only, computed after that resolution.
- **Cron** (`*/10`): write `o11y.backlog`, update `heartbeat.lastCron`, wake the box when
  the backlog is older than 60 min or larger than 64 MB, never when `drainsPaused`.
- **Drain**, in `GrafanaBox` as a DO alarm loop handling a bounded number of objects per
  invocation, under the o11y worker's `limits.cpu_ms`; only on a freshly woken box: re-opened keys first, then new ones, in key
  order; per object, push records to Loki `/otlp/v1/logs` with `X-Scope-OrgID`, in
  requests ≤ 1 MB decompressed; a key becomes provisional only after all its requests
  returned `2xx`; `429`/`5xx` retried with backoff; `400` marks the key `rejected` with
  Loki's message and triggers T04's alert; a per-record hash set prevents any record
  being pushed twice in one wake. Write `o11y.drain` and `o11y.wake` points.
- **Symbolication** (§C.3): exception records only, at drain, app-chunk frames resolved
  with `source-map-js` against `sourcemaps/<service.version>/<original asset path>.map`
  from the maps bucket, lazy per-file parse, isolate cache within a fixed budget, Babel
  compiler chunk and third-party frames skipped.
- **Stop protocol**: after a drain, `stop()` only if no `/grafana/*` request in the last
  10 min; visit wakes stop after 15 idle minutes or 4 h awake.
- **Grafana access**: `/grafana/*` verifies the Access JWT (or `DEV_ADMIN` locally),
  strips client auth headers, sets `x-o11y-grafana-user`, proxies to port 3000, renews
  activity only on HTTP requests; while not ready, the waking page (logo from
  `packages/editor-shell/src/logo.svg`, one line, `meta refresh` 3 s, no script).
- **`pnpm o11y:dev`**: box, o11y worker, Slack capture server, fixture replay; fill in the
  board README's quick reference.

Out: alert rules and cost (T04); dashboards (T09).

### Sandbox probe (required — see the board README's probe rules)

On the sandbox deployment from T01/T02: exit criterion 7 (drain one hour of
production-shaped traffic, record the wake duration and recompute the cost model) and
criterion 2 with a real SIGKILL on the platform. Delete everything after.

## Acceptance criteria

All through `pnpm o11y:dev`:

- Fixture replay, then a cron tick (`--test-scheduled`, `/__scheduled`) → the box wakes,
  drains, LogQL returns the lines at their event times, the box stops, the marker appears,
  the next tick commits the keys.
- A box kept awake by a Grafana visitor produces no wake attempts for its own provisional
  keys; a crashed wake's keys return to the backlog on the first tick after the container
  is reported not running.
- **Exit criterion 2**: `docker kill -s KILL` mid-drain → no marker → the next wake re-opens
  and replays → `count_over_time` and a plain log query both equal a clean single replay.
- A `400 too_far_behind` from Loki (forced with an old record) marks the key `rejected`,
  not provisional.
- **Exit criterion 5**: an exception from a real `vite build` of the authoring app resolves
  to a `src/…` file and line within 500 ms CPU and 64 MB added isolate memory; Babel-chunk
  frames are left unparsed.
- A drain wake with an active Grafana user does not call `stop()`.
- `/grafana/` without a JWT answers 403; with the local bypass it shows the waking page,
  then Grafana signed in as the bypass user; a client-supplied `x-o11y-grafana-user` is
  ignored.
- **Exit criterion 15**: after a drain of every fixture kind, Loki's series API shows exactly
  the contract labels per source, and `hot.demo_id`, `session.id`, `cf.ray` only as
  structured metadata.
- Each ledger, drain and proxy test fails when its logic is removed.

## Traps

- Never fetch maps from the app origin: a rotated hash answers `200 text/html`.
- Do not re-open keys across a Loki config or label change (ADR §B.3).
- Grafana behind a sub-path needs `Host` and path preserved exactly.

## Outcome

Full narrative, every command/output, and the sandbox-probe transcript are
in `.superpowers/sdd/README/T03-report.md` (outside this directory, per
COMMON.md) — this section is the condensed record.

**Phase A / Phase B split**: the sandbox probe (a)–(e) below was first
dispatched and run under this task's original instructions (phase A),
before a controller message split the work into "phase A: local only"
and "phase B: probes" — recorded then as done under the pre-split
instructions. **T03B (this section's second update)** is phase B proper:
four follow-up fixes (F1–F4, see "T03B: fixes F1–F4" below) plus a full
re-run of the sandbox probe (a)–(e) against the real platform, now that
T03-D2's root cause (below) is fixed. The (a)/(b)/(c)/(d)/(e) content
below is REPLACED with this re-run's real results, not appended
alongside the phase-A attempt, which never got past T03-D2.

**T03-D2 status, corrected**: exit criterion 1 **now passes** on the
sandbox platform. The phase-A/local investigation below is kept for the
record — it correctly identified the mechanism (the drain sent Loki bare
NDJSON instead of one OTLP `{"resourceLogs":[...]}` envelope, so Loki
accepted the push with 204 but ingested nothing) — but its own closing
paragraph ("very likely a Loki-shutdown-sequencing bug or config
interaction") was WRONG: T03-D2's own separate investigation (fix commit
`466e34b7a`, already merged into this branch's base before T03B started)
confirmed and fixed the real cause — the request body, not Loki's
shutdown ordering. The "context canceled" lines this section describes
are shutdown noise present on every passing run too, exactly as T03-D2's
report says. T03B's own real-platform re-run (T03-D11 below) confirms
this directly: a real wake produces a real new `index/index/.../...tsdb.gz`
object and a real `state/wakes/<id>/clean` marker.

### What was built

`inbox/ledger.ts` (pure, over `StorageLike`): `resolveOverWakes` (marker
check against `O11Y_LOKI_STATE`, `GrafanaBox.isAwake()` for "still
running"), `computeBacklog` (R2's own `uploaded` timestamp, not an
hour-bucket guess), `nextWrittenKeys`/`markKeysProvisional`/`rejectKey`,
`reopenWindow` (protects the current wake's own provisional keys),
`currentWakeId`. Wired into `InboxWriter` (`inbox/writer.ts`) as new RPC
methods per COMMON.md interface 1's explicit "T03 (ledger/backlog)"
allowance — `resolveWakes()` also writes the `o11y.wake` clean/unclean
point at resolution time.

`drain/drain.ts` + `drain/symbolicate.ts` (pure, over injected deps):
bounded per-invocation batches, ≤1 MB gzipped chunks to Loki with
`X-Scope-OrgID`, 429/5xx backoff (3 retries), 400 → `rejected` with Loki's
message, a per-call (never persisted) hash set for in-wake dedup — cross-
wake duplicate storage is accepted by design (ADR §B.3's own "queries
return it once"). Symbolication: parses the V8-shaped stack text
`convert.ts#faroBody` now embeds (see "Contract-module touches" below),
resolves via `source-map-js` against the maps bucket, skips
`babel-*.js` frames explicitly, caches parsed maps only within one
invocation (cross-wake determinism for exit criterion 2's replay
equality).

`box.ts` wake/stop orchestration: `onStart` schedules `drainStep` via
`this.schedule` (never a second `alarm()` override); `drainStep` gates its
first push on `isReady()`, marks provisional/rejected via the ledger,
writes `o11y.drain`; `#finishDrain` stops only when no `/grafana/*`
activity in the last 10 minutes (own storage-backed clock, independent of
the base class's own idle timer — see T03-D3 below for why drain traffic
harmlessly also renews that idle timer); a 4-hour hard cap scheduled at
wake time. `isAwake()`, `noteVisitorActivity()`,
`lastGrafanaActivityMs()` added for the ledger and the proxy.

`grafana/proxy.ts`, `grafana/waking-page.ts`, `grafana/reopen.ts`:
Access-gated (`DEV_ADMIN` only when `O11Y_ENV === "local"`), preserves the
original request's Host/path verbatim, strips client `x-o11y-grafana-user`
and sets it from the verified identity, waking page (embedded logo
markup, `meta refresh`, no script) while not ready, `POST
/grafana/_o11y/reopen`.

`index.ts`: registers `/grafana/*` (method `"*"`, not `GET` — Grafana
queries through `POST /api/ds/query`) and `POST /grafana/_o11y/reopen`;
adds `scheduled()` (ten-minute cron, `wrangler.jsonc`'s `triggers.crons`):
reads `backlog()` (which resolves over-wakes as a side effect), writes
`o11y.backlog`, wakes on age > 60 min or size > 64 MB, never while
`drainsPaused`.

Contract-module touches (`packages/runtime/src/telemetry/{scrub,convert}.ts`,
outside this task's literal Owns row, minimal and justified — the same
class of touch T02-D14 already established as acceptable): widened
`ScrubbableFaroStackFrame` to carry `function`/`lineno`/`colno` (already
present on every real Faro frame at runtime, never typed, so nothing
downstream could read them), and `convert.ts#faroBody` now embeds a Faro
exception's stack trace as V8-shaped text in the record body — the
pre-T03 version read only `type`/`value`, so a Faro exception record never
carried frame data anywhere and criterion 5 had nothing to resolve.
`pipeline/telemetry-convert.test.mjs`'s existing exception-body test is
unaffected (no `stacktrace` field in its fixture).

Shared test-fixture touches (both minimal, backward-compatible additions —
same precedent as T02's own harness extensions): `cloudflare-containers-stub.mjs`
gained a recording-only `schedule()` (T01's own `o11y-box.test.mjs` calls
`wake()`/`#doWake`, which now schedules the 4h hard cap; without this every
one of those pre-existing tests broke with `this.schedule is not a
function` — caught by running the FULL suite, not just this task's own new
files); `o11y-worker-hooks.mjs` borrows `source-map-js` the same way it
already borrows `jose`/`@handsontable/demo-runtime`.

`scripts/o11y-dev.mjs` + root `pnpm o11y:dev`: starts the o11y worker under
`wrangler dev`, which drives `GrafanaBox`'s container itself via the same
Dockerfile (confirmed real — see "Local integration" below); prints the
fixture-replay command. Does not also start `compose.yml` (T03-D6) and
does not build a local Slack capture server (T03-D7).

### Deltas (T03-D&lt;k&gt;)

- **T03-D1 — Loki's real out-of-order window is 60 minutes, relative to
  the STREAM's own high-water mark, not wall-clock "now."** Measured
  directly against a fresh local box (`compose.yml`, T01's own committed
  config, unmodified): pushing 59 minutes behind an established
  high-water mark succeeds (204); 61 minutes fails with Loki's own
  `entry too far behind` (`oldest acceptable timestamp is: <hwm> - 60m`).
  Decisively **not** wall-clock-relative: a brand-new stream whose first
  entry is 5 hours old is accepted fine, and subsequent entries near that
  5-hour-old mark (both slightly behind and slightly ahead of it, all
  still ~4.5h from real "now") are also accepted. This confirms ADR §B.3's
  own design assumption — the drain replays in key order into a wake's own
  fresh, empty ingester, so normal replay (even of an hours-old backlog)
  never approaches the limit. **Reconciles T09's own ~20-minute finding**:
  T09's seed script pushed non-monotonic timestamps into an
  already-running, already-advanced stream; the ~20-minute figure most
  likely reflects wherever that script's own seeding order happened to
  land relative to its own already-advanced high-water mark, not a
  genuine Loki config limit. **The one real risk is
  `/grafana/_o11y/reopen`**: reopening a window older than ~60 minutes
  relative to a stream that has already received more recent traffic THIS
  wake gets legitimately rejected by Loki — reproduced directly (a stream
  with a "now" high-water mark, then a reopened-3-days-old push, gets
  `entry too far behind`). No design change needed: ADR §B.3 already
  treats a Loki `400` as `rejected` + an alert, which is exactly the
  correct outcome here, not a bug. No `loki-config.yaml` change was
  needed or made — `max_chunk_age: 2h` already gives the assumed window.
- **T03-D2 (critical, controller escalation) — exit criterion 1 did not
  pass on the sandbox platform with the bucket-scoped R2 credential.**
  See "Sandbox probe" below for the full transcript. Summary: across 8+
  real wake cycles with real credentials, Loki's own metrics report
  successful periodic TSDB-shipper uploads
  (`loki_tsdb_shipper_tables_upload_operation_total{status="success"}`
  incrementing, including after a wake kept awake ~4 minutes with
  multiple upload cycles), Loki genuinely ingests and answers queries for
  pushed data within the same wake (confirmed via direct
  `/loki/api/v1/labels` and `/loki/api/v1/query_range` calls through the
  box), and Loki's own `/config` dump shows the correct resolved
  `storage_config.aws` block (bucket, endpoint, region, access key all
  correct) — but a direct S3 `ListObjectsV2` against the bucket (using the
  SAME `LOKI_S3_*` credentials, via a hand-rolled SigV4 client) shows
  **zero** new objects under `index/` or `state/`, ever, across every
  test. Every stop in every test reported `exitCode: 1`
  (`shutdown.sh`'s "no new index object" unclean path). Ruled out:
  credential permissions (the same hand-rolled client successfully PUTs
  objects to the bucket AND successfully initiates a multipart upload —
  200 on `CreateMultipartUpload`); gzip `Content-Encoding` on the OTLP
  push (a manual gzip vs. plain push to the box's own `/otlp/v1/logs`
  both land and are queryable); S3 endpoint/region/bucket-name
  misconfiguration (confirmed correct via Loki's own `/config`). **Root
  cause not determined within the probe's time budget.** T03-D4's
  `O11Y_STOP_GRACE_SECONDS` fix did not resolve it (tested after the fix
  shipped — still `exitCode: 1`, this time exiting well within even the
  old 30 s default, ruling out a grace-period timeout as the proximate
  cause for at least that run). Plan B (ADR §L: wait for the next
  15-minute index rotation) was not cleanly isolated — the closest
  approximation (a wake kept awake ~4 minutes with several periodic
  "success" uploads already logged) still produced zero R2 objects, which
  is suggestive but not a clean 15-minute test. **This is exactly
  ADR-0041 §L's trigger condition and needs the controller's own
  investigation or a decision to move toward the serverless store before
  more is built on top of this.** Concrete next steps recorded in the
  report: verify the bucket-scoped token's exact R2 permission set with
  the account owner (Object Read & Write vs. a narrower/legacy grant); get
  Loki's own container-level stdout (not just `/metrics`) via a channel
  this probe's `wrangler tail` did not surface; try the SAME credentials
  against production's real bucket name pattern in case something is
  bucket-name- or path-prefix-sensitive in a way this probe's shared
  single-bucket setup (T03-D8) did not exercise.
  **Update, after the controller's phase split, from a local
  reproduction (`containers/o11y/compose.yml`'s `minio`/`clickhouse`
  services only, reached from `wrangler dev`'s own local Container via
  `host.docker.internal` — see `box.ts#buildLocalEnvVars`, this pass's own
  addition)**: the SAME symptom reproduces **locally against same-host
  MinIO**, with `docker logs` visible this time (opaque on the sandbox).
  `docker exec`-ing into the running box confirms real network
  connectivity to MinIO (`wget http://host.docker.internal:<port>/minio/health/live`
  succeeds) and Loki's own periodic `"uploading tables"` log line recurs
  every ~30–60 s with no adjacent error. **At `docker stop` (SIGTERM,
  matching the platform's own `stop()`), the real error finally surfaces**:
  ```
  level=error caller=cached_client.go:189 msg="failed to build table names cache" err="RequestCanceled: request context canceled\ncaused by: context canceled"
  level=error caller=compactor.go:534 msg="failed to run compaction" err="failed to list tables: RequestCanceled: request context canceled\ncaused by: context canceled"
  ```
  immediately preceded by the querier's own scheduler-processor shutdown
  (`"error processing requests from scheduler" err="rpc error: code = Canceled desc = context canceled"`)
  and immediately followed by `"stopping table manager"` →
  `"uploading tables"` (the SAME log line the periodic, apparently-
  successful ticks produce) — but this is the shutdown-triggered final
  flush, the ONE upload attempt that actually matters for the marker, and
  it inherits an already-canceled context from whatever shuts down just
  before it in Loki's own multi-module shutdown sequence. **This
  reframes T03-D2 as very likely a genuine Loki-shutdown-sequencing bug
  or config interaction specific to this image/version, not an R2
  credential, network-latency, or gzip-encoding issue** — it reproduces
  identically on same-host MinIO with zero network latency, which rules
  those categories out far more conclusively than the sandbox evidence
  alone could. Still not fully root-caused (which specific module's
  shutdown ordering cancels the shared context, and why T01's own earlier
  local testing did not hit this — plausibly a difference in how long T01's
  own test wakes stayed open before stopping, giving a period upload a
  clean, uncontested window that this task's shorter test wakes did not)
  — the concrete next step is now much narrower: trace Loki's own
  `services.Manager` shutdown order for this exact config and pin down
  which module's context the table manager's shutdown-triggered upload is
  (incorrectly) sharing.
- **T03-D3 — `GrafanaBox#doWake` now fires `startAndWaitForPorts()` in the
  background.** Found on the real sandbox platform (not guessed):
  `start()` (the path `wake()` uses) never calls `state.setHealthy()` —
  only `startAndWaitForPorts()` does — so `state.status` stayed
  `"running"` for an entire wake, and the base `Container.containerFetch`
  re-runs its full port-verification path on literally every call when
  `state.status !== "healthy"`. Observed cost: anywhere from ~10 ms to
  160+ seconds for a single `GET /grafana/` request, reproduced twice.
  Fixed by firing (never awaiting) `startAndWaitForPorts({ports:
  this.requiredPorts})` right after `start()` returns, purely to flip
  `state.status` in the background without blocking `wake()`'s own fast
  return (the waking page's whole point). This makes `onStart` fire
  twice per wake (the base class calls it from both paths); guarded with
  a new `drainScheduledFor` storage key so `drainStep` is only ever
  scheduled once per wake. One real, reproducible, but non-blocking
  platform quirk surfaced by this same background call: `startAndWaitForPorts`
  called with a **multi-port array** (`this.requiredPorts = [3000, 3100]`)
  intermittently logged `Container error: Failed to verify port 3000 is
  available after 20100ms, last error: Connecting to a container using
  HTTPS is not currently supported` — harmless here (fire-and-forget,
  swallowed), but worth a note for whoever next touches multi-port
  container-fetch calls on this platform.
- **T03-D4 — `O11Y_STOP_GRACE_SECONDS` raised to 120 in production
  `envVars`** (was entirely absent from `buildEnvVars`, so production
  silently used `shutdown.sh`'s own hardcoded 30 s default — the same
  value tuned against a same-host MinIO round trip). T01's own T01-D8
  already measured `stop()` taking up to 53.7 s on this platform with
  dummy credentials; the platform's documented SIGTERM→SIGKILL grace is
  15 minutes (T01 Outcome), so there is ample headroom. Does **not**
  resolve T03-D2 on its own (see above) — kept as real, independently
  justified hardening against genuine real-network-latency risk that
  local MinIO testing structurally cannot surface.
- **T03-D5 — no separate "was this key re-opened" tracking.** ADR §B.3's
  "re-opened keys first, then new `written` keys, in key order" falls out
  for free from a single ascending sort of `written` keys: the inbox key
  format (`inbox/<tenant>/<date>/<hour>/<seq>`) already sorts
  chronologically within a tenant, and a re-opened key is by definition
  older than anything from the current wake. `ledger.ts#nextWrittenKeys`
  does one plain sort; cross-tenant interleaving does not matter (Loki
  isolates ingester state per `X-Scope-OrgID`).
- **T03-D6 — `seenHashes` is fresh per `drainStep` invocation, not
  persisted across steps or across the wake.** ADR §B.3's own "What an
  unclean stop costs" paragraph already accepts duplicate Loki STORAGE
  from a crash-and-replay, relying on query-time dedup (identical
  timestamp + labels + structured metadata) to collapse it back to one
  result — the exact same mechanism covers a retried step re-pushing a
  key whose ledger commit did not land before a crash. A per-call set
  only needs to guard against double-processing *within* one call
  (defensive; ingest-time dedup, §B.2 step 4, already prevents the same
  record existing in two different packed objects under normal
  operation).
- **T03-D7 — `pnpm o11y:dev` does not run `compose.yml` alongside
  `wrangler dev`.** `wrangler dev` manages `GrafanaBox`'s own container
  via the same Dockerfile (confirmed real, see "Local integration"
  below); running both would fight over the same image/ports for no
  benefit. `compose.yml` stays the tool for a standalone stack (T01's own
  scripts, and this task's own out-of-order measurement, both used it
  directly). A local Slack-webhook capture server (the task's Scope line)
  was **not built** — T04 owns the alert path that would post to it, and
  no T03 acceptance criterion exercises it; explicitly deferred, flagged
  in `scripts/o11y-dev.mjs`'s own console output.
- **T03-D8 — the sandbox probe used ONE bucket
  (`o11y-probe-t03-loki`) for `O11Y_INBOX`, `O11Y_LOKI_STATE` and
  `O11Y_MAPS`**, distinguished only by the existing key-prefix convention
  (`inbox/`, `state/`, `sourcemaps/`), rather than three separate buckets
  — the credentials/instructions provided only one bucket. Confirmed this
  does not itself explain T03-D2 (the Worker's own native R2 binding
  writes to `inbox/` in the same bucket work fine, every time — only
  Loki's own S3-client writes under `index/`/`state/` never land).
- **T03-D9 — `o11y.wake`'s two fields are written from two different
  places.** `duration_ms` (wake-to-ready) is written by `box.ts` at wake
  time with `reason` only (no `outcome` — the wake doesn't know yet
  whether it will end cleanly); `outcome: clean|unclean` is written by
  `InboxWriter.resolveWakes()` at resolution time with `reason` only (no
  `duration_ms` — the ledger never measured it). Two separate points for
  the same metric name, each filling different columns — `toAePoint`
  tolerates this (only present attrs are validated/written).
- **T03-D10 — the drain never emits `reason: "reopen"`** for
  `o11y.drain`, only `backlog`/`visit` (the wake's own reason) — the
  metric registry lists `reopen` as an allowed value, but this
  implementation does not distinguish "this batch was all re-opened
  keys" from an ordinary batch (T03-D5's single-sort design means
  re-opened and new keys are not tracked separately at drain time
  either). Flagged for whoever next needs that distinction (most likely
  T04's alerting, or a future Observability-self dashboard panel).

### T03B: fixes F1–F4 (phase B, part 1)

Worktree `/Users/amedrygal/Code/examples-wt/T03B`, branch
`feat/o11y/T03B-probes`. Full narrative and every command/output in
`.superpowers/sdd/README/T03B-report.md`.

- **F1 (`drain/drain.ts#dropOldRecords`)**: T03-D2's other finding — one
  record older than Loki's `reject_old_samples_max_age: 7d` 400s the
  WHOLE push, and `drainKey` maps every 400 to `rejected` (never
  retried), losing every good record in that key too. `drainKey` now
  drops individual `logRecords` older than 7d minus a 15-minute margin
  BEFORE pushing, counts them on the (previously-unused) `value` double
  of the `o11y.drain` point — no metric-registry edit needed — and still
  pushes the good siblings. A `"0"`/absent `timeUnixNano` is never
  treated as an ancient 1970 timestamp (Loki falls back to observed
  time). Tests in `pipeline/o11y-drain.test.mjs` (3 new), confirmed red
  with the fix reverted.
- **F2 (`grafana/proxy.ts`)**: a visit wake with an empty backlog SIGTERMed
  itself ~20s after boot, because a request that only ever saw the
  waking page (box still booting) recorded no activity at all —
  `#finishDrain`'s quiet check (box.ts) read `lastGrafanaActivityMs() ===
  null` and stopped the box the person just opened. `handleGrafana` now
  calls `box.noteVisitorActivity()` in the not-ready (waking-page) branch
  too — the browser's own `meta refresh` poll IS a real HTTP request to
  `/grafana/*`. Proven with a NEW end-to-end test in `o11y-wake.test.mjs`
  driven through the REAL `handleGrafana` handler (not a direct
  `noteVisitorActivity()` call, which would pass even with the bug) —
  confirmed red with the fix reverted, alongside the existing
  `o11y-grafana-proxy.test.mjs` assertion, flipped from asserting the old
  (wrong) behaviour.
- **F3 (`inbox/ledger.ts#resolveOverWakes`)**: every wake that ingests
  nothing (an empty backlog/visit wake) never gets a Loki index upload,
  so shutdown.sh correctly never writes the marker — but the ledger
  counted every one of these as "unclean," inflating exit criterion 12's
  count for a wake that lost nothing (nothing was ever provisional). A
  wake with zero provisional keys EVER now resolves clean without
  requiring the marker; a wake that DID push data still requires the
  real marker (T01's C1 guarantee unchanged). `containers/o11y/local/
  stop-roundtrip.mjs` gained a "run 1b (zero ingest)" case proving the
  container-level half of this contract (no push at all → still no
  marker, confirmed unaffected by F3). T03B-D1: a Loki that received
  literally zero writes this wake exits 1 on SIGTERM (every other case
  in that script exits 0) — recorded as evidence, not asserted, since the
  ledger never reads the container's exit code.
- **F4 (`pipeline/o11y-symbolicate.test.mjs`)**: the exit-criterion-5 test
  used to read whatever `apps/authoring/dist` happened to exist —
  skipped (silently green) when absent, failed when present but mapless.
  It now builds its own minimal one-file fixture with a real
  `vite build --sourcemap` into a fresh temp dir every run (resolving
  the authoring app's own `vite` via its manifest, the same pattern
  `pipeline/vite-allowed-hosts.test.mjs` already uses) — deterministic,
  fast (~120–150ms including the real build), and verified to still pass
  with `apps/authoring/dist` absent entirely. Added a second real-build
  case proving the Babel-chunk skip against a real (non-trivial) map, not
  only the hand-built one-mapping map the existing unit test uses.

Verify (from `runner/`, all `rtk proxy`): `pnpm install` exit=0;
`pnpm --filter @handsontable/demo-runtime build` exit=0; `pnpm -r run
typecheck` exit=0; `pnpm test` exit=1 (1662 pass / 1 known baseline
failure `theme-presets-version` / 2 todo — every o11y-* test, including
every new one, passes); `node scripts/check-test-presence.mjs
feat/runner-observability` exit=0 ("5 source file(s) changed, with a
matching test change"); `( cd workers/o11y && npx wrangler deploy
--dry-run )` exit=0.

### T03B: (d) — a console.log JSON line through Cloudflare's OTLP export

**Answer, from a real captured export (not inferred)**: a Worker's own
`console.log(JSON.stringify({...}))` line (`workers/api/src/telemetry/
lines.ts#logRequestLine`'s exact shape) arrives through Cloudflare's real
OTLP log export as **opaque body TEXT** — `body.stringValue` is the raw
JSON string. `attributes` on that log record carries ONLY Cloudflare's
own generic wrapper fields (`name: "log"`,
`cloudflare.invocation.sequence.number`), never one of the app's own
fields. Before this fix, T02's normaliser (`hoistAttributes`) would never
see `cf.ray`/`session.id`/`hot.demo_id` at all for this shape — silently
violating ADR §E.4's own operational-log rule ("operational logs may
carry a page-load id, a demo id and a cf-ray as structured metadata").

Captured via a real Workers Observability logs destination, created
through the API (`POST /accounts/.../workers/observability/destinations`,
never the dashboard — the dashboard-only path the docs describe was
avoided on purpose so this is reproducible from a script), pointed back
at the probe worker's own raw-capture route, so the body Loki-bound is
literally what Cloudflare's export sent, before this Worker's own
normalise/otlp.ts ever touches it.

**Fix**: `normalise/otlp.ts#tryParseJsonBodyAttrs` parses a JSON-object
body and merges its keys into the SAME attribute bag a real OTLP
attribute would land in — the existing `hoistAttributes` allowlist (never
a second, parallel one) decides label vs. structured metadata vs.
dropped. A no-op for a non-JSON-object body (a plain `console.log`
string, the auto-generated invocation-log line), unchanged. Test +
scrubbed real-shape fixture in `pipeline/o11y-normalise.test.mjs` /
`pipeline/fixtures/otlp/json/console-log-line.json`, confirmed red with
the fix reverted.

### Sandbox probe

Deployed `o11y-probe-t03` to the sandbox account
(`e17e41cc82bda15dfa63960aa172fb87`), `--config wrangler.probe.jsonc`
(never committed), after `wrangler whoami`. Real credentials from
`~/.config/o11y-probe/env` used only for probe commands, never printed.

**(a) Exit criterion 1** — see T03-D2. **Not passing.**

**(b) Exit criterion 2 (real SIGKILL mid-drain)** — the ledger's own
reopen mechanism is verified correct against the real platform: pushed a
record, waited for it to pack (`written`), woke the box, let the drain
mark it `provisional`, called `destroy()` (real SIGKILL) mid-wake;
`onStop` reported `{exitCode: 0, reason: "exit"}` — empirically
reproducing ADR §A's own claim that a host loss is indistinguishable from
a clean exit at the `onStop` layer (T01 found the same). The next
`resolveWakes()` correctly found the wake not running, no marker, and
re-opened the key back to `written` (confirmed via `/probe/keys`/`/probe/backlog`).
**The full "count_over_time and a log query both equal a single clean
replay" comparison could not be completed**, because no wake in this
probe ever produced a clean marker to serve as the baseline (T03-D2) —
the mechanism this task owns (detect-unclean, reopen, retry) is proven;
the end-to-end data-equality comparison is blocked on the same root cause
as (a).

**(c) Exit criterion 7 (partial — time-constrained by (a)'s
investigation)**: pushed a small batch (~24 records across 3 packed
objects, 824 bytes total) and timed a full wake→drain-complete cycle:
**43 s**, dominated by wake-to-ready time (matching T01's own 22–46.5 s
cold-start measurements) — the marginal per-object drain cost is small
against that fixed cost. Per-RPC CPU observed via `wrangler tail`'s JSON
output (677 samples across every `GrafanaBox`/`InboxWriter` method call
this session): max 104 ms, the overwhelming majority under 25 ms — well
inside the 120 000 ms `limits.cpu_ms` this task raised production to
(unmeasured against a true one-hour batch, raised as a conservative
multiple of the 30 000 default already known too tight for a
multi-object batch). **This is not the ADR-required "one hour of
production-shaped traffic" measurement** — (a)'s investigation consumed
the probe time budget this criterion needed. Cost model: not recomputed
with confidence given (a) — a design whose wakes never durably persist
cannot have a meaningful "$/month" number yet; whatever it would be is
moot until T03-D2 is resolved.

**(d) The T02 JSON `console.log` / OTLP-export-shape question**: **not
attempted** — time budget was consumed by (a). Still open; T05 or
whoever picks this up next should resolve it with its own probe before
assuming `hoistAttributes` sees a structured JSON console.log line's
fields as OTLP attributes rather than opaque body text.

**(e) Retention clock (exit criterion 13, started early)**: a 1-day
lifecycle rule (`t03-retention-clock-test`, prefix
`t03-retention-clock-test/`) applied to `o11y-probe-t03-loki` at
**2026-09-23T14:15:22Z**; two objects written under that prefix at
14:15:12Z/14:15:13Z. Confirmed active via `wrangler r2 bucket lifecycle
list`. **Per the dispatch's explicit override of COMMON.md's "delete
every object you wrote": this rule and these two objects are left in
place** for T11 to check after ~2026-09-24T14:15Z (both objects should be
gone; the rule should still be listed).

**Criterion 15 (partial, real evidence)**: `GET /loki/api/v1/labels`
against the real box returned exactly `["deployment_environment_name",
"hot_framework", "hot_ht_major", "hot_outcome", "hot_surface", "hot_tier",
"service_name"]` — the seven contract labels (no `service_version`,
correctly not a label per contract §3), for data pushed through the
box's own `/otlp/v1/logs`. `hot.demo_id`/`session.id`/`cf.ray` were not
separately probed as structured metadata on the sandbox (local evidence
for this already exists from T02's own probe work).

**Resources created and deleted**, all prefixed `o11y-probe-t03`, sandbox
account `e17e41cc82bda15dfa63960aa172fb87`:

- Worker `o11y-probe-t03` — deleted (confirmed: `GET
  https://o11y-probe-t03.handsontable-sandbox.workers.dev/` → 404;
  `workers/scripts` list no longer contains it).
- Container application `o11y-probe-t03-grafanabox`
  (`a03bee73-139e-4dea-ad56-d044db37cd34`) — deleted via the Containers
  API (`DELETE /containers/applications/<id>` → 200, "has been deleted").
- Registry image (same tag) — **not confirmed deletable**: `wrangler
  containers images list/delete` returned `Forbidden` with this token;
  the container application that referenced it is gone, so nothing points
  at it any more. Recorded per COMMON.md's "record exactly what failed."
- R2 objects: 4 `inbox/worker/...` objects written by real ingest tests,
  all deleted (confirmed via a follow-up `ListObjectsV2` showing only the
  two retention-clock objects remaining). Zero objects ever existed under
  `index/`/`state/` to delete (T03-D2).
- 4 Worker secrets (`LOKI_S3_ACCESS_KEY_ID`, `LOKI_S3_SECRET_ACCESS_KEY`,
  `O11Y_EXPORT_SECRET`, `AE_SQL_TOKEN`, `PROBE_SECRET`) — removed with the
  Worker.
- Analytics Engine dataset `o11y_probe_t03_events` — **not deletable** (no
  delete API, same as T02's own precedent); holds only synthetic probe
  points, ages out under AE's own retention.
- Rate-limit namespace id `3003` — not a provisioned resource, no cleanup
  needed.
- **Not deleted, by design** (dispatch override): the
  `t03-retention-clock-test` lifecycle rule and its two objects — see (e).
- **Not deleted**: the R2 bucket `o11y-probe-t03-loki` itself and the
  probe API token/R2 key — the user deletes these (COMMON.md).

### T03B: sandbox probe re-run (phase B) — criteria 1, 2, 7, 13

Deployed `o11y-probe-t03b` to the sandbox account
(`e17e41cc82bda15dfa63960aa172fb87`), `--config wrangler.probe.jsonc`
(throwaway, never committed — deleted at the end of this pass, along with
`probe-index.ts`), after `wrangler whoami`. `O11Y_ENV: "production"` (not
`"local"` — `"local"` routes the container's S3 endpoint at
`host.docker.internal`, which does not exist on the sandbox platform).
The same single bucket `o11y-probe-t03-loki` for all three R2 bindings
(T03-D8's precedent). Real credentials from `~/.config/o11y-probe/env`
used only for probe commands, never printed (one self-chosen probe
secret was accidentally echoed in an API response mid-session and
rotated immediately — see the T03B report).

**(a) Exit criterion 1 — PASSES.** Pushed 12 real records through
`/telemetry/v1/logs` (the real gates/normalise/pack pipeline, not a
shortcut), waited for pack, woke the box (`backlog`), let the drain run
to completion. Result: a genuinely NEW index object
(`index/index/20719/1790181658-cloudchamber-....tsdb.gz`) and the clean
marker (`state/wakes/<wakeId>/clean`), both confirmed present via a
direct R2 listing. Wake-to-drain-complete: 18s; box fully stopped by 24s.
This directly confirms T03-D2's fix (already on this branch's base)
holds on the real platform, not just locally.

**(b) Exit criterion 2 — PASSES, fully (mechanism AND the replay-equality
check phase A could not reach).** Pushed 6 canary records (one packed
object), woke the box, polled until the key was marked `provisional`
(written-keys emptied) but the box had NOT yet stopped, and called
`destroy()` (real SIGKILL) in that window. `resolveWakes()` afterward
correctly found no marker and reopened the key back to `written`. A
fresh wake then drained it cleanly (marker present). Queried the real
box's Loki directly:
  - Plain log query (`{service_name="demos-api"} |= "c2kill"`): exactly
    6 streams, one value each — 6 lines total, matching the 6 pushed
    records exactly once.
  - `count_over_time({service_name="demos-api"} |= "c2kill" [6h])`: 6
    series, summing to 6.0.
  Both equal a single clean replay — no duplication survived the real
  SIGKILL-mid-drain + reopen + replay cycle.

**(c) Exit criterion 7 — PASSES at both 1× and 10×, corrected scale
(fix round I1).** The original pass modeled 1× as one Loki line per
SESSION (≈20/hr) — wrong: `lines.ts#logRequestLine` writes one line per
non-proxy REQUEST, and a session generates many. **Corrected derivation**,
per T05's own measured "23 lines/session" (5-minute, 10-edit session,
`tasks/o11y/T05-api-worker-signals.md`'s own "Measured lines, points and
spans" table) and T06/T07's own web-vitals fixture shape
(`pipeline/fixtures/faro/web-vitals.json`: one Faro "measurement" item
bundles LCP/INP/CLS/FCP together, and `normalise/faro.ts` stores exactly
one Loki line per measurement item — never four):

```
worker (T05):  446 sessions/day × 23 lines/session / 24h ≈ 427.4/hr
browser (T06/T07): 121 page views/day × 1 line/page-view / 24h ≈ 5.0/hr
                                                    1× total ≈ 432/hr
```

Non-session API traffic (share/embed views, T05's own note that
chat/theme/import/payload calls "already counted as a request" within a
session) adds a negligible amount (<0.01/hr from traffic-baseline.md's
own share+embed counter) — not separately itemised. Pushed as
427 worker-tenant OTLP records + 5 browser-tenant Faro `web-vitals` items
at 1×, ×10 (4270 + 50) at 10×, both tenants together — this is >20× the
volume the first pass tested — in EVENT-TIME order across a 60-minute
window (T03-D1: Loki's 60-minute out-of-order window).

  - **1×** (432 records, packed into 2 objects — one worker 6922 B, one
    browser — 2 tenants both exercised): wake-to-drain-complete **28s**.
  - **10×** (4320 records, 2 objects, 57850 B total — still nowhere near
    the 1 MB per-push cap): wake-to-drain-complete **44s**.
  Both comfortably inside the 5-minute budget — even at 20× the
  previously-tested volume, wake-to-ready time still dominates over drain
  time (drain itself adds ~16s from 1× to 10×, a 10× byte increase). Both
  markers confirmed present (`{"present":true}`).
  `wrangler tail --format json` captured real per-invocation CPU at both
  rates: 1× max 19ms (an `isAwake` RPC — probe polling overhead, not
  drain work itself); 10× max 150ms (same kind of call, likely a
  cold-start/compile artifact), with every one of the 21 real DO alarm
  ticks (`drainStep`'s own reschedule loop, which is what actually pushes
  the packed objects to Loki) costing 0–4ms CPU each. All far under the
  `120000` `limits.cpu_ms` ceiling — even the highest single-invocation
  spike (150ms) is 0.125% of it.
  - **Cost model** (`workers/api/src/budget.ts#RATE`/`INSTANCE`,
    `standard-1`: 4 GiB mem, 0.5 vCPU, 8 GB disk; mem+disk bill on
    provisioned size for every awake second, CPU on actual use):
    mem+disk ≈ 4×0.0000025 + 8×0.00000007 ≈ $0.00001056/awake-second.
    At ~720 hourly-triggered wakes/month (the 60-minute backlog-age
    threshold still dominates wake FREQUENCY, not volume — even 10×
    this corrected volume stays far under the 64 MB size trigger, so
    wake count is unchanged; only the ~16s/wake drain-time delta moves):
    1×: 720 × 28s × $0.00001056 ≈ **$0.21/month**.
    10×: 720 × 44s × $0.00001056 ≈ **$0.33/month**.
    CPU cost is negligible against this even using the highest observed
    single-invocation spike (sub-cent/month). Both are far under the
    $10/month limit, at either volume — criterion 7 passes with large
    headroom, even at the corrected (>20×) real-traffic scale. (Egress
    and Workers-request costs are also negligible at this record/byte
    scale, not itemised separately.)

**(d)** — see "T03B: (d)" above (answered with a real captured export,
fix shipped).

**(e) Exit criterion 13 (retention)** — the phase-A `t03-retention-clock-test`
lifecycle rule and its two objects (created 2026-09-23T14:15:22Z, 1-day
expiry) are still active and present as of this pass
(2026-09-23T19:29:33Z — the rule has not yet had a full day to act).
Confirmed via `wrangler r2 bucket lifecycle list --config
wrangler.probe.jsonc --jurisdiction eu` (rule present, enabled) and a
direct R2 listing (`t03-retention-clock-test/probe-1.txt`,
`t03-retention-clock-test/probe-2.txt`, both still present, sizes
unchanged). Left in place for T11 to check after
~2026-09-24T14:15Z, per the original dispatch override — no new rule
added.

**Resources created and deleted this pass** (all prefixed
`o11y-probe-t03b`, sandbox account `e17e41cc82bda15dfa63960aa172fb87`):
- Worker `o11y-probe-t03b` — deleted (`DELETE /workers/scripts/o11y-probe-t03b?force=true`
  → success; confirmed via a follow-up request to its own `workers.dev`
  URL, now 404).
- Container application `o11y-probe-t03b-grafanabox`
  (`a0381226-e35e-4164-8857-99eebfefbdbc`) — deleted (`DELETE
  /containers/applications/<id>` → 200, "has been deleted").
- Registry image (same tag) — **not confirmed deletable**: `wrangler
  containers images list` returned `Forbidden` with this token, same as
  phase A's own finding — the container application referencing it is
  gone.
- Workers Observability logs destination `o11y-probe-t03b-selftest`
  (created via `POST /workers/observability/destinations`, an
  `opentelemetry-logs` logpush job) — deleted (`DELETE
  /workers/observability/destinations/o11y-probe-t03b-selftest` →
  success).
- R2 objects: every object this pass wrote (`inbox/*` ×4, `index/*` ×4,
  `state/*` ×4, `worker/*` ×4 — Loki's own chunk-store objects, a
  category phase A's cleanup did not need to touch since it never got a
  successful ingest — `probe-capture/otlp/*` ×152 from the (d)
  self-export capture) — all deleted via a bulk-delete probe route,
  confirmed by a follow-up listing showing ONLY the two
  `t03-retention-clock-test/` objects remaining.
- 4 Worker secrets (`LOKI_S3_ACCESS_KEY_ID`, `LOKI_S3_SECRET_ACCESS_KEY`,
  `O11Y_EXPORT_SECRET`, `PROBE_SECRET`) — removed with the Worker.
- Analytics Engine dataset `o11y_probe_t03b_events` — **not deletable**
  (no delete API, same precedent as T02/T03 phase A), holds only
  synthetic probe points, ages out under AE's own retention.
- Rate-limit namespace id `3003` — not a provisioned resource.
- `wrangler.probe.jsonc`, `probe-index.ts` (local files, never
  `git add`ed) — deleted from the worktree at the end of this pass;
  `git status --porcelain` confirmed clean.
- **Not deleted, by design**: the `t03-retention-clock-test` lifecycle
  rule and its two objects (phase A's, see (e) above) — left for T11.
- **Not deleted**: the R2 bucket `o11y-probe-t03-loki` itself and the
  probe API token/R2 key — the user deletes these (COMMON.md).

### Fix round (controller review, findings I1/I2 — minors deferred)

**I1 — exit criterion 7 was tested at ~20× under the real 1× volume.**
The `(c)` section above is REPLACED (not appended) with the corrected
1×/432-lines/hr, 10×/4320-lines/hr re-run — both tenants, both markers
confirmed, wall time and cost model corrected. Full derivation and
numbers there.

**I2 — the (d) fix's own merge order let body-JSON content spoof a real
resource attribute.** `otlp.ts#toIngestItem` spread `bodyJsonAttrs`
AFTER `resourceLogs.resourceAttributes`, so a body key like
`"service.name"` or `"deployment.environment.name"` inside a Worker's
own `console.log` JSON would override the REAL resource attribute — a
Loki label/AE index slot that must only ever come from the trusted OTLP
resource. Fixed two ways: `tryParseJsonBodyAttrs` now strips every
`RESOURCE_ATTRS` key from its own output, AND the merge at the call site
gives body-JSON attrs the LOWEST priority (spread first) — so even a
future `RESOURCE_ATTRS` addition the strip has not yet been taught about
still cannot win. New test
(`pipeline/fixtures/otlp/json/console-log-line-spoof-attempt.json`): a
body trying to set `service.name=spoof`,
`deployment.environment.name=spoof-env`, `hot.outcome=spoof-outcome`
leaves the real values intact, while `cf.ray` (a legitimate,
non-`RESOURCE_ATTRS` structured-metadata key) still comes through —
confirmed red with both the strip and the merge-order reverted.

Verify (raw, `rtk proxy`, from `runner/`):

```
pnpm test                     exit=1 (1663 pass / 1 known baseline
                                failure / 2 todo)
pnpm -r run typecheck                                        exit=0
node scripts/check-test-presence.mjs feat/runner-observability
                                                                exit=0
```

Full narrative, sandbox transcript and commands/output in
`.superpowers/sdd/README/T03B-report.md`'s own "Fix round" section.

### Local acceptance walkthrough (added after the controller's phase split)

Added `box.ts#buildLocalEnvVars` (this pass's own new delta, see the
commit) so the local box reaches `containers/o11y/compose.yml`'s
`minio`/`clickhouse` services (started standalone, without the `box`
service, ports published to the host) via Docker's `host.docker.internal`
— `wrangler dev`'s local Container is not on `compose.yml`'s own network.
Verified reachable with a direct `docker exec ... wget
http://host.docker.internal:<port>/minio/health/live` from inside the
running box.

**Verified locally, real evidence, against `pnpm o11y:dev`'s own
`wrangler dev` process** (not simulated):

- `GET /grafana/*` with no JWT and no `DEV_ADMIN` → **403**, for both
  `/grafana/` and `POST /grafana/_o11y/reopen`.
- With `DEV_ADMIN` set (`O11Y_ENV=local`): the waking page (exact HTML,
  `meta refresh`) while not ready, then a real Grafana page once ready.
  `GET /grafana/api/user` confirms `auth.proxy` signed in as
  `dev@handsontable.com` (`"authLabels":["Auth Proxy"]`).
- A client-supplied `x-o11y-grafana-user: attacker@evil.example` header
  is ignored — `/grafana/api/user` still reports the verified identity.
- `node scripts/o11y-replay-fixtures.mjs --base http://localhost:4400`:
  every fixture (`collect` ×5, `v1/logs` ×6 including the deliberate
  duplicate-delivery pair, `deploy`, `hooks/sentry`) answers `204`.
- A real `docker kill -s KILL` against the running box mid-wake (exit
  criterion 2's own required method): the container is gone immediately;
  the next `/grafana/*` request correctly triggers a fresh wake (a new
  `WAKE_ID` observed via `docker inspect`).
- The out-of-order-window measurement (T03-D1) — see its own section
  above, run via `compose.yml` directly.
- Exit criterion 5 (symbolication) — see "Verify" below, the real
  `vite build --sourcemap` evidence, run independent of `wrangler dev`.

**Not completed locally, same root cause as T03-D2**: "wake → drain →
LogQL at event times → stop → marker → commit on next tick" end to end.
The drain mechanism itself is unit-tested and was confirmed pushing real
fixture data through `InboxWriter`'s pack cycle (real R2-binding objects
observed via `/cdn-cgi/local/explorer/api/r2/buckets/.../objects`), but
no wake in this local environment ever produced a queryable Loki line
*after* a stop-and-restart cycle, because — exactly like the sandbox —
no wake ever produces a clean marker (T03-D2's local reproduction). One
additional, separate local-only observation while chasing this: after a
`docker kill`-induced restart, at least one subsequent wake's own
container exited again within ~20 s without any `POST /otlp/v1/logs`
line appearing in its own `docker logs` at all — i.e. `drainStep` reached
`#finishDrain` (self-stop) without this task being able to confirm it
had processed the pending written keys first. This may be a distinct,
`wrangler dev`-local-simulation-specific timing/ordering issue on top of
T03-D2, or it may be the SAME issue manifesting differently when a
wake's own drain has nothing to durably persist regardless — not
resolved given the time available; flagged for whoever next debugs this
locally, alongside a concrete repro (fresh `.wrangler/state`, replay
fixtures, wait for pack, wake, watch `docker logs -f` on the box
container).

Given the above, **"visitor-kept-awake box"**, **"crashed wake returns to
backlog"**, and **criterion 15** were only re-confirmed via their own
existing unit tests (`o11y-wake.test.mjs`'s "a drain wake with an active
Grafana user does not call stop()" and "drainStep is a no-op once a
newer wake has superseded…", `o11y-ledger.test.mjs`'s resolve/reopen
cases) plus the SANDBOX probe's own real evidence (criterion 15's real
`/loki/api/v1/labels` result, already recorded above) — not re-proven
through a fresh full local wake cycle, since that cycle is exactly what
T03-D2 blocks.

### Local integration

`wrangler dev` genuinely drives `GrafanaBox`'s Container locally (built
the real image, ran it via Docker, and a real `/grafana/` round trip did
eventually return the waking page) — confirming ADR §I's "the box through
`wrangler dev`" option is real, not aspirational. In this run's sandboxed
Docker environment specifically, first-request latency was highly
variable (as fast as ~12 ms once warm, but one request took 162 575 ms) —
found and partly explained by T03-D3 (the missing `startAndWaitForPorts`
call), though even after that fix a clean local `wrangler dev` round trip
in this environment was not reliably fast enough to build the intended
full local fixture-replay + cron-tick walkthrough within this task's time
budget. The mechanism (T03-D3's fix) is real and platform-verified on the
sandbox (wakes after the fix were consistently fast there, 3–22 s to
ready); the *sandboxed-Docker-specific* slowness on this development
machine is recorded as environment friction, not a code defect, but is
worth flagging for whoever next runs `pnpm o11y:dev` in a similarly
constrained environment.

`containers/o11y/compose.yml` (T01's stack, unmodified) was used directly
for the out-of-order-window measurement (T03-D1) and confirmed to boot
cleanly (Loki `/ready` in 16 s) and accept real OTLP pushes exactly as
T01's own local testing found.

### Test-failing-when-reverted evidence (a sample — not exhaustive given
this task's size; every `pipeline/o11y-{ledger,drain,symbolicate,wake,
grafana-proxy}.test.mjs` case asserts a specific behavior, not just "code
ran")

| Reverted | Test(s) that went red |
|---|---|
| `ledger.ts#resolveOverWakes`: the `stillRunning` check removed (always resolves) | "leaves a still-running wake's provisional keys untouched" |
| `ledger.ts#reopenWindow`: the `protectedState` guard removed | "never touches a key provisional to the CURRENT active wake" |
| `drain.ts#drainKey`: the 400-vs-5xx branch collapsed to always retry | "a 400 rejects the key … no retry" (assert on push-attempt count) |
| `drain.ts#drainBatch`: `stoppedEarly` return removed, loop continues past an error | "stops immediately on the first `error` outcome … the third key" (assert `neverReachedFetched === false`) |
| `symbolicate.ts#isBabelChunk` check removed | "leaves a Babel-chunk frame unparsed even when a map exists for it" |
| `convert.ts#faroBody`'s stack-frame embedding removed (reverted to pre-T03) | the real-`vite-build` criterion-5 test (no `src/` frame to find at all) |
| `box.ts#drainStep`'s `isReady()` gate removed | "reschedules itself … while the box is not yet HTTP-ready" (assert `resolveWakes` never called) |
| `box.ts#finishDrain`'s quiet-check inverted | "an active Grafana user does not call stop()" |
| `proxy.ts`'s header-stripping removed | "strips a client-supplied x-o11y-grafana-user" |

### Verify — commands run, exit codes

All via `rtk proxy <command>; echo "exit=$?"` from `runner/`.

```
rtk proxy pnpm install                                            exit=0
rtk proxy pnpm --filter @handsontable/demo-runtime build           exit=0
rtk proxy pnpm -r run typecheck                                    exit=0 (5 of 6 workspace projects)
rtk proxy pnpm test                                                exit=1 (1491 tests: 1488 pass, 1 pre-existing
                                                                     baseline failure — theme-presets-version,
                                                                     '18.1.0' !== '18.1.1', COMMON.md-documented —
                                                                     2 todo; every new o11y-* test passes)
( cd workers/o11y && npx wrangler deploy --dry-run )                exit=0
( cd workers/api && npx wrangler deploy --dry-run )                 exit=0 (unaffected)
node scripts/check-test-presence.mjs feat/runner-observability      exit=0 (13 source files, matching test change)
```

A real `vite build --sourcemap` of `apps/authoring` (exit criterion 5's
own evidence) produced real `.map` files; the symbolication test resolved
a real frame to `packages/editor-shell/src/theme.ts` in ~76.5 ms wall /
~42.5 MB Node heap delta (both explicitly labeled as CPU/memory *proxies*
in the test's own output — Workers CPU time cannot be read from inside
the isolate; no sandbox-probe CPU measurement for symbolication
specifically was completed given (a)'s time cost).

### Concerns / follow-ups for the controller

**Resolved by T03B (part B)**: T03-D2 (exit criterion 1 now passes on
the real platform), exit criterion 2's full replay-equality check,
exit criterion 7's cost model (measured at 1× and 10×, both far under
$10/month), and the (d) OTLP-JSON-console.log question (answered with a
real captured export, fix shipped). See the T03B sections above and
`.superpowers/sdd/README/T03B-report.md` for full detail.

- `wrangler.jsonc`'s `limits.cpu_ms` (raised to 120000) is still an
  informed-guess ceiling, not tuned against a full-batch measurement —
  T03B's own real batches (20/200 records, one packed object each) used
  well under 1% of it (max observed per-invocation CPU 14ms). A packed
  object approaching the 1 MB cap, or many packed objects in one wake,
  would be a more demanding measurement than this pass's synthetic
  traffic produced — worth revisiting if real production volume ever
  approaches that shape.
- Local `pnpm o11y:dev` is functionally wired but was not re-verified
  for speed in this pass (T03B worked entirely against the sandbox
  platform and `node --test`, not `wrangler dev`); the prior finding
  (code path real, sandboxed-Docker-specific slowness on this dev
  machine) is unchanged and unre-tested here.
- T03B's own probe work surfaced one new finding, T03B-D1: a Loki
  process that received literally zero writes in a wake exits 1 on
  SIGTERM (every wake that pushed at least one line exits 0) — harmless
  to the ledger (F3 never reads the container's exit code), but worth
  knowing if a future task ever adds exit-code-based logic to
  `shutdown.sh` or `box.ts#onStop`.
- Exit criterion 7's cost model interpretation (worker-tenant hourly
  volume derived from sessions+builds+share/embed+AI-questions, since
  total API request count is not directly measured — see
  traffic-baseline.md's own caveat) should be revisited once real
  production `api.request` volume is actually measurable end to end
  (post-launch, via Loki itself).

### Fix round (phase A review)

One Important finding, fixed — full writeup in
`.superpowers/sdd/README/T03-report.md`'s own "Fix round" section.

**I1** — `LAST_GRAFANA_STORAGE_KEY` was never reset per wake, so a
visitor's activity in one wake could make the NEXT (visitor-less)
backlog wake's `#finishDrain` quiet check wrongly read as "not quiet,"
breaking ADR §A's self-stop rule and costing awake time (exit criterion
7). Fixed: `#doWake` now deletes that key before `start()`. Covered by a
new two-consecutive-wakes test in `o11y-wake.test.mjs`, confirmed failing
without the fix and passing with it. `rtk proxy pnpm test`: 1489/1492
pass (1 pre-existing baseline failure, 2 todo) — every `o11y-*` test,
including the new one, passes. Commit `cd09a1ea0`.

### Merge (feat/runner-observability, T07/T08/T12)

Merged the integration branch (tip `e2cf0a4e4`) into this task's branch
— full writeup in `.superpowers/sdd/README/T03-report.md`'s own "Merge"
section. One conflict, `workers/o11y/src/index.ts`'s
`UNIMPLEMENTED_ROUTES` stub list (both sides' own stale entries — T08's
now-real `/telemetry/lite`, this task's own now-real `/grafana/*`/
`reopen`); resolved to the one genuinely still-unimplemented route
(`GET /grafana/_o11y/admin/*`), header comment updated to match. No
other file conflicted; checked the ones the merge touched that T03's own
code reads or shares fixtures with (`convert.ts`, `scrub.ts`, the shared
Container/hooks stubs, `o11y-box.test.mjs`, `attrs.ts`,
`o11y-{routes,dashboards}.test.mjs`) — no semantic clash. DoD raw, `rtk
proxy`, all exit 0 except `pnpm test` (exit=1: 1602/1605 pass, the same
pre-existing baseline failure, 2 todo). Commit `78159dfa2`.
