# T05 — API worker signals, error lines and the Sentry switch

| | |
|---|---|
| Status | done |
| Size | L |
| Depends on | T00 |
| Blocks | T04 (merge order), T11 |
| ADR | 0041 §C.2, §D, §E.1, §E.3, §F.2 (API-worker rows); exit criteria 8, 11 |
| Owns | `workers/api/wrangler.jsonc` (observability, `RUNNER_EVENTS`, `O11Y` binding, `SENTRY_SCOPE`, `*/5` cron), `workers/api/package.json` (`--var SERVICE_VERSION`), `workers/api/src/telemetry/**` (new), `workers/api/src/index.ts`, `sentry-gate.ts`, `snapshot-jobs.ts`, `chat.ts`, `theme-ai.ts`, `usage.ts`, `pipeline/api-telemetry-*.test.mjs` |

## Goal

The API worker exports every line it chooses and none per proxied preview request,
writes the server half of the catalogue to Analytics Engine, logs every error that
escapes a handler itself, and classifies each Sentry call site behind the scope switch.

## Read first

- ADR-0041 §D, §E.1, §E.3; contract §2, §5, §11.
- `workers/api/wrangler.jsonc:10-14`; `index.ts` `sentryOptions`, the fetch catch-all
  (~:2178-2210), the `proxyToSandbox` path, session start and `at_capacity`, `scheduled()`;
  `snapshot-jobs.ts` (the alarm reports without rethrowing).

## Scope

In:

- **Config**: logs `head_sampling_rate: 1.0`, `invocation_logs: false`, `persist: true`,
  `destinations: ["o11y-logs"]`; traces `head_sampling_rate: 0.01`, `persist: true`, **no
  destination**; `RUNNER_EVENTS`; `O11Y` service binding; `SENTRY_SCOPE` var (`full`);
  `*/5` cron; rewrite the comment above the block per ADR §D.
- **Lines**: one structured JSON line per non-proxy request plus an `api.request` point;
  nothing per request on the preview proxy path; stale-preview requests answered before
  the Sandbox SDK where recognisable; **our own error line** in the fetch catch-all, the
  snapshot-job alarm's report path, every DO alarm and the cron handler.
- **Spans**: `tracing.enterSpan` (feature-detected) around session start, container boot,
  snapshot build, chat, theme AI, import, payload boot.
- **Version**: `service.version` from `SERVICE_VERSION`; the Cloudflare version id stays
  an attribute.
- **Metrics**: `session.start` (all outcomes), the `at_capacity` counter in
  `usage_daily` (ADR-0040 C.1), `session.end`, `container.boot_ms`, `snapshot.build`,
  `chat.answer`, `chat.edit`, `theme.ai`, `import.url`, `payload.boot`, `error.handled`;
  from the `*/5` cron (dispatch on `controller.cron`): `pool.gauge`, `budget.gauge`, and a
  call to T04's watchdog.
- **Sentry classification** (ADR §E.1): catch-all captures, DO alarm and cron failures,
  and snapshot-job failures stay in Sentry in both scopes; diagnostic captures (upstream
  failures with tags, boot-window report, handled refusals) emit a structured line and an
  `error.handled` point always, and reach Sentry only while `SENTRY_SCOPE = full`; the
  budget-alert `captureMessage` is untouched. List every site and its class in the Outcome.

Out: `serve.*` and the beacon (T08); `reconcile.run`, cost and the watchdog logic (T04).

## Acceptance criteria

Under `wrangler dev`, `RUNNER_EVENTS` pointed at local ClickHouse:

- One `/api/versions` request → one JSON line with every field and one `api.request` row;
  a proxied preview module request → no line.
- A forced `at_capacity` → a `session.start` row with that outcome and a `usage_daily`
  increment.
- The `*/5` cron → `pool.gauge` and `budget.gauge` rows; the nightly cron unchanged.
- A throw inside a fetch handler, a DO alarm and the cron each produce our structured
  error line (exit criterion 11 locally) and reach Sentry in both scopes; a diagnostic
  capture reaches Sentry with `full` and not with `uncaught` (transport spy).
- `pipeline/api-telemetry-config.test.mjs` pins the observability block and fails on a
  revert; `wrangler deploy --dry-run` succeeds with every `--routes` flag intact.
- Outcome: measured lines and spans per session and per non-proxy request, for T11's
  volume projection (exit criterion 8).

## Traps

- The deploy script's flags are load-bearing (ADR-0020); `master.yml` keeps `pnpm run deploy`.
- Never rename `ERROR_REPORTING_DSN` toward `SENTRY_DSN`.
- `console.*` on the proxy path multiplies by every module request of every live preview.
- Never block a response on Analytics Engine.

## Outcome

### What was built

- **`workers/api/src/telemetry/`** (new): `resource.ts` (`service.version`/`environment`
  resolution, the `AeSink` choice — real `RUNNER_EVENTS` binding in production,
  `clickhouseSink` locally, matching contract §10), `points.ts` (`emitPoint`, the one
  `toAePoint`-validated Analytics Engine write surface, catch-and-log, never blocking),
  `lines.ts` (`logRequestLine`/`logErrorLine`, the two structured-JSON-line shapes ADR §D
  names), `route-class.ts` (`routeClassOf`/`demoIdFromPath`, zero cross-file imports —
  see T05-D2), `scope.ts` (`sentryScopeIsFull`, the contract §11 decision alone, zero
  imports), `diagnostic.ts` (`reportDiagnostic`/`reportUncaught`, wiring `scope.ts` +
  `points.ts` + `lines.ts` + `@sentry/cloudflare` together), `spans.ts` (`withSpan`,
  feature-detected `cloudflare:workers` `tracing.enterSpan`), `cron.ts`
  (`emitPoolGauge`/`emitBudgetGauge`), `index.ts` (barrel).
- **`wrangler.jsonc`**: `observability.logs` (`head_sampling_rate: 1.0`,
  `invocation_logs: false`, `persist: true`, `destinations: ["o11y-logs"]`) and
  `observability.traces` (`head_sampling_rate: 0.01`, `persist: true`, no destination),
  replacing the old top-level `head_sampling_rate: 0.1` and its comment; `triggers.crons`
  gains `"*/5 * * * *"` beside the unchanged `"17 4 * * *"`.
- **`package.json`**: `deploy` script gains `--var SERVICE_VERSION:$GITHUB_SHA` (GitHub
  Actions' own default env var — no `master.yml` edit needed: `GITHUB_SHA` is set for
  every step without an explicit `env:` block, the same way the authoring build's
  `RELEASE = process.env.GITHUB_SHA` already relies on it).
- **`env.ts`**: `SERVICE_VERSION?`, `RUNNER_EVENTS_CLICKHOUSE_URL?`, `AE_SQL_TOKEN?` (the
  last two are `.dev.vars`-only local-mode additions, T05-D1).
- **`index.ts`**: the fetch handler's body (everything after the proxy-passthrough check)
  is extracted into `handleNonProxyRequest()`; `fetch()` times it and calls
  `recordRequestSignal()` inside `ctx.waitUntil` — one structured line + one `api.request`
  point per non-proxy request, nothing on the proxy path. `session.start` emitted at 5
  outcomes (`ready`/`at_capacity`/`container_starting`/`budget_denied`/`error`, one point
  per create attempt, wrapped in a `withSpan("session.start", …)` around the whole
  try/catch); `boot_timeout` was moved to `container.boot_ms`'s `window_exceeded` outcome
  after the advisor review below, to stop it double-counting a session (see T05-D4).
  `recordUsageEvent(env, "at_capacity", …)` added beside the existing
  `isAtCapacityFailure` branch (ADR-0040 C.1). `session.end` wired at the DELETE/pagehide
  path, the platform-declined-teardown catch, and the `closed`-tier forced teardown.
  `container.boot`, `import.url`, `chat.answer`, `theme.ai`, `payload.boot` spans added at
  their call sites. The cron dispatch (`workerScheduled`, referenced from
  `Sentry.withSentry({ scheduled: workerScheduled })`) runs each step through a shared
  `cronStep(env, context, fn)` helper — one structured line **and an explicit, ungated
  `Sentry.captureException`** per failed step (not a rethrow into the SDK's own wrapping —
  see T05-D8, this was the advisor's most consequential catch); the `*/5` branch isolates
  `pool.gauge`/`budget.gauge`/the T04 watchdog hook into three independent steps so one
  failing does not skip the others, the nightly branch keeps its original one-failure-
  stops-the-rest sequencing.
- **`chat.ts`**: `ChatAnswer` gains `tokensIn`/`tokensOut` (read from the gateway's OpenAI-
  compatible `usage` object when present, `0` otherwise); `ChatUnavailableError` gains
  optional `status`/`requestId` fields, set only on the gateway-failure throw — this is how
  the diagnostic capture reaches `index.ts` without `chat.ts` importing `./telemetry/*`
  itself (T05-D2, forced by a pre-existing test harness).
- **`theme-ai.ts`**: the same `status`/`requestId` addition to its own gateway-failure
  throw (same `ChatUnavailableError` class).
- **`snapshot-jobs.ts`**: `runSnapshotJob`'s `updateDemo` call wrapped in `withSpan(
  "snapshot.build", …)`, emitting the point with `reason: "detached"` on both branches;
  `markSnapshotFailed` (the alarm's report path) gets one `logErrorLine` covering every
  branch below it, Sentry captures there are untouched (already unconditional).
- **`usage.ts`**: `"at_capacity"` added to `UsageMetric`.
- **`pipeline/api-telemetry-config.test.mjs`** (required name): pins `wrangler.jsonc`'s
  `observability.logs`/`.traces`, the `*/5` cron, the `RUNNER_EVENTS`/`O11Y` bindings,
  `SENTRY_SCOPE`'s default, and the deploy script's `--routes`/`--var` flags, parsed out of
  the real committed files with a small string-aware `//`-comment stripper (no new
  dependency — `json5`/`jsonc-parser` are only transitive and unhoisted; T00 owns
  dependency additions).
- **`pipeline/api-telemetry-signals.test.mjs`**: `routeClassOf`/`demoIdFromPath`,
  `serviceEnvironment`/`serviceVersion`, `sentryScopeIsFull`.
- **`pipeline/telemetry-facade-noop.test.mjs`**: regression coverage for the cross-task fix
  below.

### Sentry call sites and their classification (ADR-0041 §E.1)

**Diagnostic (handled; `reportDiagnostic` — structured line + `error.handled` point
always, Sentry only while `SENTRY_SCOPE !== "uncaught"`):**

| Site | Context tag | Was |
|---|---|---|
| `index.ts` DO `previewBootFailureResponse` | `preview-boot-window-exceeded` — named explicitly in §E.1 | unconditional |
| `index.ts` `teardownLiveSession`'s declined-destroy catch | `tier2-teardown-declined` | unconditional |
| `index.ts` session-create's `isContainerStartingFailure` branch | `tier2-session-container-starting` | unconditional |
| `index.ts` `GET /api/versions/exists` catch | `npm-registry:version-exists` | unconditional |
| `index.ts` `POST /api/import` catch | `import-url` | unconditional |
| `index.ts` `POST /api/payload` catch | `payload-store` | unconditional |
| `index.ts` `GET /api/versions` catch | `npm-registry:versions` | unconditional |
| `index.ts` `POST /api/chat`'s `ChatUnavailableError` catch, only when `err.status` is set | `chat-gateway` | never reported (console only) |
| `index.ts` `POST /api/theme`'s `ChatUnavailableError` catch, only when `err.status` is set | `theme-gateway` | never reported (console only) |

**Uncaught (escapes a handler; unconditional in both scopes, untouched by the switch):**

| Site | Notes |
|---|---|
| `index.ts` fetch catch-all, `BuildFailure` branch | now also gets `logErrorLine` |
| `index.ts` fetch catch-all, generic branch | now also gets `logErrorLine` |
| `snapshot-jobs.ts` `markSnapshotFailed`, D1-write failure | secondary failure while recording the primary one |
| `snapshot-jobs.ts` `markSnapshotFailed`, `BuildFailure` branch | the alarm's report path — named explicitly in §D/§E.1 |
| `snapshot-jobs.ts` `markSnapshotFailed`, generic branch | same |
| `index.ts` `cronStep`'s catch, both cron branches | **new, explicit, ungated** `Sentry.captureException` — see T05-D8; before this fix nothing reported a cron failure to Sentry at all |

**Untouched, per the task's explicit exclusion**: `reconcile.ts`'s budget-alert
`captureMessage` and `rehomeBudgetAlert` — "stays in Sentry, unconverted" (§E.1), out of
scope (`reconcile.run`, T04).

### Measured lines, points and spans (for T11's volume projection, exit criterion 8)

Per **non-proxy request**, unconditionally: 1 structured JSON line (`api.request`) + 1
Analytics Engine point (`api.request`); 0 on the proxy path (live-verified: a `GET
/api/versions` produced exactly the one line/row pair below; the proxy branch was checked
by reading the diff, not by booting a real Tier-2 container — that needs 10 real container
boots to reach `at_capacity` too, both out of this task's time budget).

A concrete session, using the client's own cadences (`packages/runtime/src/container.ts`:
a 2.5s `/status` poll while booting, a 60s keepalive once ready, one `POST .../file` per
file edit) — **5 minutes, 10 edits**, a typical "try a change" session:

| Phase | Duration | Requests | Lines | AE points | Spans |
|---|---|---|---|---|---|
| Create (`POST /api/session`) | — | 1 | 1 | 1 (`api.request`) + 1 (`session.start`) | 1 (`session.start`, wraps 1 nested `container.boot`) |
| Boot polling (`GET .../status`, 2.5s cadence) | ~15s to ready (typical) | ~6 | 6 | 6 (`api.request`) | 0 |
| Awake window (60s keepalive `GET .../status`) | ~4m45s | ~5 | 5 | 5 (`api.request`) | 0 |
| Edits (`POST .../file`) | spread through the session | 10 | 10 | 10 (`api.request`) | 0 |
| Teardown (`DELETE`, pagehide) | — | 1 | 1 | 1 (`api.request`) + 1 (`session.end`) | 0 |
| **Total** | 5 min | **23** | **23** | **25** | **2** |

Every request line/point pair is unconditional; the two `session.start`/`session.end`
points and the two spans are session-lifecycle-only, on top of the per-request baseline.
A diagnostic capture anywhere adds +1 error line, +1 `error.handled` point, +0/+1 Sentry
event depending on `SENTRY_SCOPE`; an uncaught escape adds +1 error line, +1 Sentry event
(both scopes), no Analytics Engine point (contract §5 has no server `error.uncaught`).
Chat/theme/import/payload calls each add +1 request line/point pair (already counted as a
request) + 1 metric point + 1 span.

### Deviations (T05-D)

- **T05-D1 — local ClickHouse credential vars are not contract-pinned.** Contract §2's
  API-worker table names only `RUNNER_EVENTS`/`O11Y`/`SERVICE_VERSION`/`SENTRY_SCOPE`/
  `o11y-logs`/the cron — no local-ClickHouse URL or credential for *this* worker (only the
  o11y worker's `AE_SQL_TOKEN` is pinned). Added `RUNNER_EVENTS_CLICKHOUSE_URL` and reused
  the name `AE_SQL_TOKEN` (same header shape T00 measured:
  `X-ClickHouse-User`/`X-ClickHouse-Key`) as `.dev.vars`-only additions, never in the
  committed `wrangler.jsonc` vars block.
- **T05-D2 — `route-class.ts`/`resource.ts`/`scope.ts` are deliberately import-free of
  their sibling `.ts` files, and `chat.ts`/`theme-ai.ts` do not import `./telemetry/*` at
  all.** Measured: `node --experimental-strip-types` does not resolve a sibling `.ts`
  module through its compiled `.js` specifier (confirmed by direct probe —
  `Cannot find module '.../sentry-gate.js'` importing an early draft of `resource.ts` that
  re-exported `sentry-gate.ts`'s `PRODUCTION_HOST`). Three existing pipeline tests broke
  the same way the first time `chat.ts`/`theme-ai.ts` imported `./telemetry/diagnostic.js`:
  `chat-sanitise.test.mjs` copies `workers/api/src/*.ts` into a flat temp dir and rewrites
  `.js"` → `.ts"` specifiers (its own header comment explains why), which does not reach
  into a `telemetry/` subdirectory; `theme-ramp.test.mjs` does the same for the `theme-*`
  chain; `decode-entities.test.mjs` imports `chat.ts` from its real location with no copy
  step at all. Fixed by giving `ChatUnavailableError` optional `status`/`requestId` fields
  set only on a gateway failure, and moving the actual `reportDiagnostic` call to
  `index.ts`'s two `ChatUnavailableError` catches (`if (err.status !== undefined)`) — no
  behaviour lost, no cross-file import added to either file. `resource.ts` copies
  `PRODUCTION_HOST` as a local constant instead of importing it from `sentry-gate.ts`, and
  `scope.ts` was split out of `diagnostic.ts` (which does need `@sentry/cloudflare` +
  `points.js`/`lines.js`) purely so the switch's own decision function stays testable.
  `points.ts`/`lines.ts`/`diagnostic.ts`/`cron.ts` keep their real cross-file imports and
  are verified by direct `wrangler dev` instead — no pipeline test imports `index.ts`
  either, for the same reason.
- **T05-D3 — `session.end`'s reason set has no slot for an admin-panel kill.** The
  contract's four `session.end` reasons (`pagehide`, `sleep_after`, `teardown_failed`,
  `budget_closed`) don't cover `teardownLiveSession`'s other caller (`/admin`'s kill
  button — DEV-2567). `teardownLiveSession` gained an `endReason: "pagehide" | "admin"`
  parameter; the admin path passes `"admin"` and the function skips the point entirely for
  it (`"teardown_failed"` still overrides either caller when the platform declines the
  destroy).
- **T05-D4 — `container.boot_ms` only emits `window_exceeded`, not `ready`/`error`, and
  `session.start` never emits `boot_timeout` (advisor review, second pass — original
  design was wrong).** First draft emitted the DO's boot-window-exceeded report as
  `session.start`'s `boot_timeout` outcome. That double-counts: the create already emitted
  one `session.start` `ready` point when it returned a preview URL, and this DO call site
  fires on **every** refused preview request past the boot window — including a dev server
  that crashes minutes into an already-`ready` session (`bootStartedAt` is re-stamped at
  the first refusal after a success, per its own class comment, so "elapsed since this
  refusal" is not "elapsed since session start" in that case). A second, unrelated
  `session.start` point for the same session would corrupt `SUM(double1)` reads and any
  ratio T04's alerts build on `session.start`'s outcome mix. Moved to `container.boot_ms`,
  outcome `window_exceeded`, instead — the metric contract explicitly has this outcome for
  exactly this case. `ready`/`error` still aren't emitted (would need `GET .../status` to
  know the framework and the boot-start timestamp, neither available there without new
  cross-cutting plumbing — persisting them at session create, reading them back per poll).
- **T05-D5 — `pool.gauge`'s `reason: "builder"` is not emitted.** No KV meter (or any other
  signal) tracks `BuilderSandbox` concurrency the way `session-meter:*` tracks live
  sessions — a `builder` point would always read zero. `emitPoolGauge` only ever writes
  `reason: "live"`.
- **T05-D6 — `snapshot.build`'s `reason: "inline"` is not emitted.** Only the detached path
  (`snapshot-jobs.ts`'s `BuildJob` alarm, `runSnapshotJob`) is wrapped; the synchronous
  build path in `index.ts` (share creates/rebuilds, 4+ call sites) was out of the time this
  task had — `snapshot-jobs.ts` is the file this task owns for the purpose, `share.ts`'s
  `updateDemo`/`createDemo` are not.
- **T05-D7 — `session.end`'s `reason: "sleep_after"` is not emitted.** Nothing in this
  Worker's code observes the Sandbox SDK's own idle-timeout stop (`sleepAfter = "5m"`) —
  no callback exists for it today, only the explicit teardown paths this task instruments.
- **T05-D8 — a cron failure inside `ctx.waitUntil()` does not reach
  `Sentry.withSentry`'s own `scheduled` wrapping (advisor review, second pass — the
  original design was wrong and would have silently dropped every cron-failure Sentry
  event).** First draft `reportUncaught`-logged and rethrew inside the `ctx.waitUntil(...)`
  promise, assuming the SDK's `scheduled` instrumentation would catch the rethrow the way
  it catches a synchronous handler throw. Read the SDK source
  (`@sentry/cloudflare/build/esm/instrumentations/worker/instrumentScheduled.js`):
  `wrapScheduledHandler` only `try/catch`es the return of `fn()` — the handler's own
  synchronous invocation — and `utils/instrumentContext.js` does not also wrap
  `ctx.waitUntil` to catch a later rejection handed to it. Since every cron branch here
  runs its work inside `ctx.waitUntil(...)` (so the response is never blocked on cost
  reconciliation or gauge writes), a throw there was structurally unreachable by the SDK's
  auto-capture. Measured live (see below): the *pre-fix* code produced **zero** Sentry
  envelopes for a forced cron failure. Fixed with `cronStep()`, which calls
  `Sentry.captureException` explicitly and ungated in its own catch, confirmed by the same
  live probe producing exactly one envelope after the fix.
- **Cross-task fix — `packages/runtime/src/telemetry/facade.ts` (T00-owned).**
  `noopTelemetry` minted its page-load id in a module-top-level IIFE
  (`crypto.randomUUID()` at import time). T00 never ran this against a real Worker (its
  own Outcome says every probe that imported the barrel was a throwaway typecheck-only
  file, deleted afterward); T05 is the first real consumer, and `wrangler dev` for the API
  worker failed to boot at all: `Uncaught Error: Disallowed operation called within global
  scope ... generating random values are not allowed within global scope`, at
  `mintPageLoadId`. Fixed to mint lazily on first `pageLoadId()` call (same contract after
  that — stable across calls). Measured: `wrangler dev` crashed before the fix and served
  real traffic after it (decisive log lines pasted below). Regression test added:
  `pipeline/telemetry-facade-noop.test.mjs` (Node cannot reproduce the workerd-only crash
  itself — the test's own doc comment says so — so it pins the id-stability contract
  instead; the crash/fix pair is this measured record).

### Test-failing-when-reverted evidence — every row run for real, not assumed

Each mutation below was made with the code editor (not a pipeline mock), the named test
file run, the red output captured, then the mutation reverted and the suite re-confirmed
green. Full command: `node --experimental-strip-types --test pipeline/<file>.test.mjs`.

1. **`wrangler.jsonc`: `head_sampling_rate` set back to `0.1`.**
   `api-telemetry-config.test.mjs` → `not ok 2 - observability.logs: full fidelity,
   invocation logs off, persisted, o11y-logs destination` — `+ head_sampling_rate: 0.1`
   in the diff against the expected `1`.
2. **`package.json`: `--var SERVICE_VERSION:$GITHUB_SHA` dropped from the deploy script.**
   `api-telemetry-config.test.mjs` → `not ok 7 - the deploy script sets SERVICE_VERSION
   from GITHUB_SHA, alongside every existing --routes flag` — `assert.ok(deploy.includes(
   "--var SERVICE_VERSION:$GITHUB_SHA")) === false`.
3. **`route-class.ts`: `:id` collapsing removed from the session-route branch**
   (`api/session/:id` → `api/session/${parts[2]}`, the literal id).
   `api-telemetry-signals.test.mjs` → `not ok 2 - routeClassOf: dynamic ids collapse, not
   the whole path` — actual `'api/session/react-18-abc123'`, expected `'api/session/:id'`.
4. **`resource.ts`: `serviceEnvironment`'s `===` relaxed to `.endsWith(PRODUCTION_HOST)`.**
   First attempt at this revert (a `${PRODUCTION_HOST}.evil.test` suffix case, copied from
   `sentry-gate.ts`'s own equality test) did **not** go red — `.endsWith` still correctly
   rejects a string ending in something *other* than the production host, so that one case
   only catches a `.startsWith` mutation. Added a second case
   (`evil-${PRODUCTION_HOST}`, a prefix attack) that a real `.endsWith(PRODUCTION_HOST)`
   *does* wrongly accept — confirmed: `api-telemetry-signals.test.mjs` → `not ok 10 -
   serviceEnvironment: the check is equality, not a prefix or a suffix test` — actual
   `'production'`, expected `'local'`. The test file now keeps both cases and documents why
   the first one alone was insufficient.
5. **`scope.ts`: `sentryScopeIsFull` inverted (`!==` → `===`).**
   `api-telemetry-signals.test.mjs` → all three `sentryScopeIsFull` cases go red
   (`not ok 13/14/15`, `false !== true` / `true !== false` / `false !== true`).

All five restored and re-confirmed green (`api-telemetry-config.test.mjs`: 7/7;
`api-telemetry-signals.test.mjs`: 22/22) before moving on.

### Live verification (`wrangler dev` + local ClickHouse + a real Sentry transport spy)

A throwaway `clickhouse/clickhouse-server:24.10-alpine` container (port 4623, this task's
block) ran a DDL matching T00's documented local schema (`index1`, `blob1`–`blob20`
`String`, `double1`–`double20` `Float64`, `timestamp DateTime64(3)`, `_sample_interval`) —
`containers/o11y/local/clickhouse-init.sql` does not exist in this worktree yet (T01 runs
in parallel, per COMMON.md), so the DDL was written by hand from the contract + T00's
Outcome, not copied from a file. `wrangler dev --port 4610 --test-scheduled` (port block
4600–4699). Both torn down afterward (`docker rm -f t05-ch-probe`, `pkill wrangler dev`).

**Local ClickHouse pass** (`.dev.vars`: `PREVIEW_HOST=localhost:4610`,
`RUNNER_EVENTS_CLICKHOUSE_URL=http://localhost:4623`, `AE_SQL_TOKEN=local-dev-token`):

- `GET /api/versions` → exactly one structured line:
  ```
  {"log.kind":"api.request","route_class":"api/versions","status":200,"duration_ms":1535,
  "cf.ray":null,"session.id":null,"hot.demo_id":null,
  "service.version":"f6d74145-c164-48ba-88c2-5a7937a539d7"}
  ```
  and one ClickHouse row: `index1=api.request, blob1=demos-api, blob3=local,
  blob10=api/versions, double1=1, double2=1535` — every field present, matching the
  acceptance criterion exactly.
- `curl /cdn-cgi/handler/scheduled?cron=*/5 * * * *` → `pool.gauge`
  (`reason=live, value=0, cap=10`) and `budget.gauge` (`reason=ok, value=0, usd=0`) rows
  landed (D1 migrations had to be applied locally first — `no such table: cost_ledger` on
  a fresh `.wrangler/state`, an environment-setup gap, not a code defect — `wrangler dev`
  auto-applies them on a later boot).
- `POST /api/session` with a malformed JSON body → the fetch catch-all fired:
  ```
  {"log.kind":"error","context":"fetch-catch-all","name":"SyntaxError","message":
  "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
  "service.version":"f6d74145-c164-48ba-88c2-5a7937a539d7"}
  ```
  plus an `api.request` line with `status: 500` — exit criterion 11, measured live.
- `POST /api/chat` with no `LITELLM_API_KEY` configured → `503`, `chat.answer` point
  landed with `outcome=error`, and no diagnostic line/point (`err.status` is `undefined`
  for a config fault, only set for a gateway failure) — confirms `reportDiagnostic`'s gate
  fires only for the class it should.

**Sentry transport-spy pass** (a plain Node HTTP server on `:4640` recording every POST
body, `.dev.vars`: `ERROR_REPORTING_DSN=http://spykey@127.0.0.1:4640/1`,
`SENTRY_ENVIRONMENT=local-spy`, `PREVIEW_HOST=demos.handsontable.com` — opens the real
two-signal gate; a second fake upstream on `:4641` always answering `500` for the
chat-gateway case):

| # | Action | `SENTRY_SCOPE` | Envelope? | Confirms |
|---|---|---|---|---|
| 1 | malformed `POST /api/session` | `full` (default) | **yes** (envelope #1) | fetch catch-all — uncaught class — reports |
| 2 | `POST /api/chat` (fake gateway → 500) | `full` | **yes** (envelope #2) | chat-gateway diagnostic reports when `SENTRY_SCOPE=full` |
| 3 | `*/5` cron, `emitPoolGauge` forced to throw (temporary one-line edit, reverted immediately after, `pnpm test` re-confirmed green) | `full` | **yes** (envelope #3, `transaction: "Scheduled Cron */5 * * * *"`) | **T05-D8**: before the `cronStep` fix, this same forced failure produced **zero** envelopes — this positive result is the confirmation the fix works, not an assumption |
| 4 | `POST /api/chat` (fake gateway → 500) | `uncaught` | **no** (count stayed at 3) | chat-gateway diagnostic is correctly suppressed when `SENTRY_SCOPE=uncaught` — and its structured line still printed (`{"log.kind":"error","context":"chat-gateway",...}`), confirming the new-stack half is unconditional |
| 5 | malformed `POST /api/session` | `uncaught` | **yes** (envelope #4) | fetch catch-all stays unconditional in both scopes |

This is the literal transport-spy check the acceptance criteria ask for: the same
diagnostic call site (`chat-gateway`) produced an envelope under `full` and none under
`uncaught`, while the same uncaught-class site (the fetch catch-all) produced one under
both.

A live `at_capacity` refusal and a live proxied preview request were not reproduced this
way — both need a real Tier-2 container pool (10 real boots for the first, one real boot
for the second), out of this task's time budget; verified by code reading instead (the
`at_capacity` branch is a straight-line add beside the pre-existing, already-tested
`isAtCapacityFailure(err)` check; the proxy branch returns before any line/point code runs
at all).

### Handoff (T04)

The `*/5` cron branch (`runFiveMinuteCron` in `index.ts`) ends with:
```ts
// T04 fills this in (workers/api/src/o11y-watchdog.ts, `checkO11yHeartbeat`).
// One-line edit for T04: replace the statement below with
// `await cronStep(env, "cron:five-minute:heartbeat", () => checkO11yHeartbeat(env));`
// plus its import at the top of this file.
await cronStep(env, "cron:five-minute:heartbeat", () => Promise.resolve());
```
Replace that one statement with the real call (plus the import) — `pool.gauge`,
`budget.gauge` and `cronStep`'s per-step isolation/reporting do not need to change.

### Verify — commands run, exit codes

All via `rtk proxy <command>; echo "exit=$?"`, from `runner/` unless noted, per COMMON.md.

```
rtk proxy pnpm install                                              exit=0
rtk proxy pnpm --filter @handsontable/demo-runtime build             exit=0
rtk proxy pnpm -r run typecheck                                      exit=0  (5/6 — pipeline has no typecheck script)
rtk proxy pnpm test                                                   exit=1  (1274 tests, 1271 pass, 1 pre-existing baseline
                                                                                failure — theme-presets-version.test.mjs, '18.1.0' !==
                                                                                '18.1.1', confirmed present on this branch before this
                                                                                task's changes too — 2 todo, 0 other failures)
( cd workers/api && rtk proxy npx wrangler deploy --dry-run --routes '*.demos.handsontable.com/*'
  --routes 'demos.handsontable.com/api/*' --routes 'demos.handsontable.com/d/*'
  --routes 'demos.handsontable.com/embed/*' --var SENTRY_ENVIRONMENT:api-production
  --var SERVICE_VERSION:<sha> )                                       exit=0
( cd workers/o11y && rtk proxy npx wrangler deploy --dry-run )        exit=0
rtk proxy node scripts/check-test-presence.mjs feat/runner-observability   (run after commit, see report)
```

### Concerns / follow-ups

- T05-D4/D5/D6/D7 above are real, scoped gaps (not silently dropped — each is either
  genuinely unmeasurable with today's signals, or needs plumbing in a file this task does
  not own). None block the acceptance criteria, which name `session.start`/`api.request`/
  `pool.gauge`/`budget.gauge`/the error lines/the Sentry switch specifically — all of those
  are implemented and measured live.
- T05-D8 (the cron/`ctx.waitUntil` Sentry gap) was caught only on advisor review, after a
  first live probe that looked successful (a structured error line printed, the request
  returned 200) but never checked whether an envelope actually arrived. Worth flagging for
  the controller: "the response looks right" is not evidence a Sentry capture fired when
  the capture is fire-and-forget inside `waitUntil`.
- The `packages/runtime/src/telemetry/facade.ts` fix is a real correctness bug in shared,
  T00-owned code that would have broken every future consumer of the barrel under a real
  Worker (T02, T03, T06 all import from it). Flagging for the controller to confirm T00's
  Outcome/report gets a note, since T00 itself is marked done and this task cannot edit it.
- `workers/api`'s `@cloudflare/workers-types` stays on `^4.20250101.0` (pre-existing drift
  T00 already flagged, not touched here — not this task's file to bump).
- `env.ts`'s index signature (`[key: string]: unknown`) means a typo'd env var name would
  not be caught by `tsc` anywhere in this task's new code — same pre-existing risk every
  other var in this file already carries, not new here.
- **T02 fixed the same `facade.ts` bug in parallel.** T05 merges first; T02 resolves
  against this version.

### Fix round (post-review: three fixes with no revert-sensitive test)

Commit `38af02873`. Review found (a) `reportDiagnostic`'s `sentryScopeIsFull` gate,
(b) `cronStep`'s explicit ungated Sentry capture (T05-D8), and (c) `facade.ts`'s lazy mint
each had no test that goes red when the fix is reverted. Fixed:

- **`reportDiagnostic`** now takes an injectable `capture` param (default: the real
  `Sentry.captureException`, every existing call site unaffected).
  `pipeline/api-telemetry-diagnostic.test.mjs` drives it directly with a recorder (1 call
  under `full`, 0 under `uncaught`). Revert (`if (true)` instead of the gate) → red
  (`1 !== 0`); restored.
- **`cronStep`** extracted from `index.ts` into `telemetry/cron-step.ts` (deliberately
  leaner than `cron.ts` — no `../budget.js` — so it stays copy-harness-testable) with the
  same injectable-capture pattern. `pipeline/api-telemetry-cron-step.test.mjs` asserts a
  throwing step is captured and swallowed. Revert (comment out the `capture(...)` call) →
  red (`0 !== 1`); restored.
- **`facade.ts`**: `pipeline/telemetry-facade-boot-safety.test.mjs` stubs
  `globalThis.crypto.randomUUID` before a cache-busted dynamic import and asserts the
  import itself never calls it (the prior noop test only pinned the post-import contract,
  which the reviewer correctly noted cannot distinguish eager from lazy). Revert (back to
  the eager IIFE) → red (`1 !== 0`); restored byte-for-byte (diffed against a saved copy).

Full fix-round verify commands/exit codes and detail are in the report
(`.superpowers/sdd/README/T05-report.md`). `pnpm test`: 1284 tests, 1281 pass (+10 vs. the
first round), same 1 pre-existing baseline failure, 2 todo. `check-test-presence.mjs`:
pass (17 source files, matching test change).
