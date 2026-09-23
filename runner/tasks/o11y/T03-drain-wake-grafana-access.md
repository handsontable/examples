# T03 — Ledger, drain, symbolication, wake and Grafana access (spike b, part 2)

| | |
|---|---|
| Status | todo |
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

_Filled in when done._
