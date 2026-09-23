# T05 — API worker signals, error lines and the Sentry switch

| | |
|---|---|
| Status | todo |
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

_Filled in when done._
