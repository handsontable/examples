# T03 — Ledger, drain, symbolication, wake and Grafana access (spike b, part 2)

| | |
|---|---|
| Status | done — see Outcome: T03-D2 (exit criterion 1 fails on the sandbox platform) needs controller escalation before ADR-0041 is treated as accepted |
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

**Mid-task controller change**: the sandbox probe (a)–(e) below was
dispatched and completed (with cleanup) under this task's original
instructions before a controller message arrived splitting the work into
"phase A: local only" (this pass) and a future "phase B: probes." The
probe work below is therefore **already done**, not "pending phase B" —
recorded here for the controller's own review rather than repeated. No
new sandbox probe was started or is in flight after the split message
arrived, per its own instruction.

**Controller attention required before this is treated as accepted**:
exit criterion 1 does not pass — reproduced **both** on the sandbox
platform with the bucket-scoped R2 credential AND locally against
same-host MinIO (T03-D2, refined with the local reproduction's more
precise root-cause signature below) — ADR-0041 §L's own trigger
condition. Everything else (ledger, drain, symbolication, wake
orchestration, Grafana proxy, Access gating, the fixture replay, the
out-of-order-window measurement, all unit tests) is built, tested and
passing, including fresh local, non-probe evidence gathered after the
phase split (see "Local acceptance walkthrough" below).

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

- **T03-D2 is the headline concern** — see above. This task's own
  Verify block and every acceptance criterion phrased as "all through
  `pnpm o11y:dev`" pass at the *mechanism* level (ledger, drain retry/
  rejection logic, symbolication, proxy, waking page — all real,
  platform-tested where the sandbox probe reached them) but the
  *durability* half of exit criterion 1 does not hold on the one real
  platform test that exists.
- Exit criterion 7's cost model is unmeasured at real scale (time
  constraint, not a design gap) and moot pending T03-D2.
- The (d) OTLP-JSON-console.log question remains open from T02.
- `wrangler.jsonc`'s `limits.cpu_ms` (raised to 120000) is an informed
  guess from partial CPU-per-call data, not a full-batch measurement —
  revisit once T03-D2 unblocks a real one-hour drain.
- Local `pnpm o11y:dev` is functionally wired but was not proven
  reliably fast in this session's own sandboxed Docker environment; the
  code path is real (confirmed on the actual sandbox platform).

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
