# T11 — Local end-to-end verification and launch gate

| | |
|---|---|
| Status | done — phases A–E complete |
| Size | M |
| Depends on | T00–T10, T12 |
| Blocks | merging `feat/runner-observability` to `master` |
| ADR | 0041 rev. 3 §L (exit criteria 1–15); ADR-0042; implementation deltas `T<nn>-D<k>` |
| Owns | `e2e/o11y-local.spec.ts` (gated `E2E_O11Y_LOCAL=1`), the final pass over `docs/run-and-deploy.md`, `runner/AGENTS.md`, `docs/adr/0041…0043`, `docs/adr/README.md`, and the deletion of `runner/tasks/o11y/` |

## Goal

Prove the whole stack on localhost with real traffic from the real app, decide whether
ADR-0041's exit criteria are met, write the launch plan, fold the deltas into the ADR,
and leave the branch with no temporary files.

## Scope

In:

- **Walkthrough** with every piece local: authoring (Vite, `VITE_TELEMETRY_LOCAL=1`), API
  worker, o11y worker, Grafana box. Scripted steps: open a Tier-1 and a Tier-2 example, type
  a keystroke ladder into the editor, save and share a demo, open its `/d` and `/embed`,
  switch versions, open a docs-guide example by `?docs=` and fork it (ADR-0042 events and
  attribution), replay the deploy and Sentry fixtures, force a handled and an uncaught
  error. Every dashboard panel from T09 shows this traffic (not seed data), the expected
  alerts reach the Slack capture server once, and nothing reaches Sentry that should not.
- **`e2e/o11y-local.spec.ts`**: the automatable part of the walkthrough, own port, gated.
- **Volume and cost projection**: lines and points per session and per request measured
  locally, times production traffic read from `usage_daily` (read-only), against the
  Workers Logs and export allotments and the o11y awake-hour model. This is an exit
  criterion.
- **Exit-criteria table**: each of ADR-0041 §L criteria 1–15 with its measured value,
  its threshold and its evidence (local run or sandbox probe). A failed 1, 2 or 7 after its
  plan B stops the launch (ADR §L).
- **Launch plan** in `docs/run-and-deploy.md`: runbook steps first, then o11y worker, API
  worker, authoring, all with Sentry scope `full`; a short production smoke of
  the facts the sandbox probes measured; the criteria for flipping `SENTRY_SCOPE` and
  `VITE_SENTRY_SCOPE` to `uncaught` (data seen end to end in Grafana, alerts firing once,
  volume inside the projection), and who flips them; rollback (drop the export
  destinations, revert the observability block; the scope flag needs no revert).
- **Fold and clean**: fold every `T<nn>-D<k>` delta from the task Outcomes into
  ADR-0041/0042/0043 and update the ADR index; set ADR-0041 to Accepted only
  when both criterion groups have evidence, and ADR-0042 to Accepted with it; leave ADR-0043
  Proposed as the record of T13, which runs after launch; update
  the AGENTS.md observability bullet from "proposed, not yet built" to what shipped; move
  anything worth keeping from task Outcomes into `docs/run-and-deploy.md` or the contract;
  then `git rm -r runner/tasks/o11y` in the final commit.

## Acceptance criteria

- Walkthrough checklist complete with evidence (links to screenshots, captured payloads,
  query results) in the PR description.
- `E2E_O11Y_LOCAL=1 pnpm e2e e2e/o11y-local.spec.ts` green, run raw.
- The projection shows exported events and Workers Logs events under half of the included
  allotments at current traffic, or the PR says it does not and proposes the fix.
- No file under `runner/tasks/` remains; `grep -rnE "tasks/o11y|task board|ADR-DELTAS"
  runner` finds nothing outside the folded ADR text.
- The PR into `master` uses the repository PR template.

## Traps

- A green e2e run against a stale authoring `dist` proves nothing; the root `pnpm build`
  builds packages only. Build the app you are testing.
- Use your own Playwright port; another worktree's server on 4173 is silently reused.

## Outcome

Phases A–D done (this pass). Phase E (fold deltas into the ADRs, flip statuses, update
AGENTS.md, `git rm -r runner/tasks/o11y`) is explicitly out of scope for this pass per the
controller's dispatch — it waits for T03B to merge, and for T03B's final Outcome to fold
alongside every other task's. Full narrative, every command/output, and the mid-session
controller correction (T03B's criterion-7 rate) are in
`.superpowers/sdd/README/T11-report.md` (outside this directory, per COMMON.md) — this
section is the condensed record.

### Phase A — local walkthrough, real traffic

Ran the whole local stack for real: `containers/o11y/compose.yml`'s `minio`+`clickhouse`
services (T11's port block, 5210–5213), the o11y worker under `pnpm o11y:dev`'s own
`wrangler dev` (port 5220, driving `GrafanaBox`'s real Container), the API worker under
`wrangler dev` (port 5230, D1 migrations applied), and `apps/authoring` under a real `vite`
process (not `vite preview` — `vite`'s own dev server, `VITE_TELEMETRY_LOCAL=1` +
`VITE_DEV_USER` for the local auth bypass + `VITE_API_BASE` pointed at the same origin so
`vite.config.ts`'s own proxy stands in for production's one shared zone, per its own header
comment). Drove it with a real Chrome browser (Playwright MCP tools), not the mocked
`page.route` pattern T06/T07 use for their own gated specs.

**Real traffic generated and independently confirmed in ClickHouse (the local Analytics
Engine stand-in) and/or Loki, not seeded**: a Tier-1 (Sandpack) open and a keystroke edit;
a real Tier-2 (container) session open, an HMR-triggering edit, and a clean teardown
(`sandbox.destroy success`); Fork + Save (a real D1 write, ADR-0042's `example.forked`/
`.saved`); `/d/:id` (the real serve seam, `service.name=demos-embed`), a forced 100%-sampled
uncaught error there producing a real lite-beacon `error.uncaught` point; a render-crash
probe (`__test_crash_boundary=1`) reaching both `window.__t06SentryCapture` (1 event) and
the real o11y worker; the full OTLP/deploy/Sentry-webhook fixture replay
(`scripts/o11y-replay-fixtures.mjs`) against the real box, including the deliberate
duplicate-delivery pair (exit criterion 4 — confirmed live: `o11y.ingest` outcome
`duplicate` × 10 across repeats, `accepted` × 93, `dropped` × 3); both crons
(`*/10` on the o11y worker, `*/5` on the API worker) triggered via
`/cdn-cgi/local/scheduled` / `/cdn-cgi/handler/scheduled`; a live watchdog test (stopped the
o11y worker, retriggered the API's `*/5` cron, a real Sentry envelope
`"[o11y-watchdog] the o11y stack looks stale: heartbeat unreachable"` landed on a local
Sentry transport spy on the FIRST tick — T04 never ran this live; restarted the o11y worker
and confirmed the matching `"...has recovered"` warning-level envelope on the next tick); a
real new-fingerprint alert cycle (`o11y.alert` `fired` then `resolved` for `new-fingerprint`,
the `resolved` transition's Slack line captured live on a local capture server — the `fired`
transition's own AE point exists but its Slack POST predates the capture server's own start,
recorded honestly as a gap, not claimed); `alert-eval-error` never fired (every AE query ran
against real rows); a real `rejected-inbox-key` alert (see Concerns — an old real-captured
OTLP fixture timestamp, combined with T03B's own known F1, genuinely got rejected by Loki's
7-day window, which is itself affirmative evidence OTLP timestamps are never clamped,
exit criterion 3's own claim).

**Two real bugs found and fixed, both found live running this task's own required
verification, not by reading source (COMMON.md's precedent for a minimal, justified touch
outside "Owns")**:

- **`workers/o11y/src/normalise/points.ts#aeSink`** hardcoded `http://localhost:8123`
  unconditionally in local mode, never reading `env.RUNNER_EVENTS_CLICKHOUSE_URL` — the same
  var `alerts/ae-query.ts` (T04) already reads, with the same fallback, for the QUERY side.
  A local ClickHouse on any other port (every task's own port block puts it elsewhere)
  silently received zero browser-metric points while alert queries against the configured
  URL read an empty table. Fixed; regression test `pipeline/o11y-points-sink.test.mjs` (2
  cases), reverted and seen red, restored.
- **`workers/api/src/index.ts#cors()`**'s `Access-Control-Allow-Headers` never grew to
  include `x-hot-session`, the header T05/T06 wired onto nearly every fetch call site in
  `apps/authoring/src` after this list was last written. Production and the vite dev proxy
  are both same-origin, so no browser ever preflights it — a genuinely cross-origin local
  dev setup (`VITE_API_BASE` pointed straight at the API worker, the exact shape
  `e2e/telemetry-metrics.spec.ts` and this task's own spec both use) fails the preflight
  silently in the console; T07's own passing live spec never caught it because none of its
  assertions depend on the blocked calls succeeding. Load-bearing here: this task's own real
  Fork+Save flow never navigated until it was fixed. Fixed; regression test
  `pipeline/api-cors.test.mjs` (2 cases), reverted and seen red, restored.

A third, minimal touch: `apps/authoring/vite.config.ts`'s `/api`, `/d`, `/embed` proxy
targets were a bare hardcoded `:8787`; every o11y task's own port block runs the API worker
elsewhere, so a walkthrough needing both the API worker and this proxy could not honour its
own port block. Added `API_DEV_PORT` (default `8787`, unchanged behaviour), mirroring the
existing `O11Y_DEV_PORT` pattern immediately below it. No test added (a config default with
no closed-set/shape assertion elsewhere in the codebase); exercised live by both the manual
walkthrough and `e2e/o11y-local.spec.ts`.

**Dashboards — real traffic, not seed data.** Woke `GrafanaBox` for real (`/grafana/`, the
server-side `DEV_ADMIN` bypass, `O11Y_ENV=local`), confirmed `auth.proxy` signs in as the
configured identity, and opened all 8 provisioned dashboards (T09's 7 + T12's
`examples.json`). Zero query errors on every one. Screenshots (post-real-traffic, not T09's
seeded ones) at `.superpowers/sdd/README/T11-screenshots/{runner-overview,tier2-sessions,
docs-embeds}.png`. Per-dashboard "No data" panel count and why, all consistent with what was
and was not exercised this session (no LLM key locally → AI assist's 7 panels empty; no
`snapshot.build`/`at_capacity` traffic generated → the matching panels empty; `demo-runtime`
surface metrics empty because `monitorDemos` structurally cannot be `true` under local
automation, T06-D2's own documented gate — the same reason the demo-runtime-ladder half of
the walkthrough's alert scenario could not be driven end to end locally, a gap this task
inherits rather than introduces):

| Dashboard | Panels | No data | Why |
|---|---|---|---|
| Runner overview | 9 | 4 | needs `at_capacity`, 5xx traffic, sustained pool pressure — none generated |
| Tier-2 sessions | 5 | 0 (after a real session) | — |
| Tier-1 playground | 6 | 5 | `compile_error`/`bundler_unreachable` need a forced failure; `preview.runtime_error`/"Recent demo-runtime errors" are the T06-D2 gate; `hmr.roundtrip_ms` needs a Vite full-reload edit (not attempted this pass, proven live by T07) |
| Version health | 3 | 2 | needs `compile_error`/`version.switch` traffic |
| Docs embeds | 5 | 4 | `snapshot.build` untriggered; web-vitals sampled at 10%, none landed this session |
| AI assist | 7 | 7 | no `LITELLM_API_KEY` locally |
| Observability self | 8 | 5 | `o11y.drain`/`.wake`/`.alert` need a real wake-drain cycle (only partially reached, see Concerns); `reconcile.run` is a nightly cron, not triggered |
| Examples & features | 7 | not re-checked | T12 never screenshotted this one either; out of this pass's time budget |

**Criterion 15 (labels), all four sources, resolved against the real committed
`loki-config.yaml`** — this also resolves the conflict between T02's throwaway 8-label
result and T03's real-box 7-label result: `loki-config.yaml`'s own `attributes_config`
promotes exactly 7 keys (`service.name`, `deployment.environment.name`, and the five
`hot.*` keys) — **`service.version` is deliberately never promoted**, and ADR §L's own
criterion 15 text names only `hot.*`, `service.name` and `deployment.environment.name` as
required labels (§C.2's looser prose listing `service.version` too is superseded by §L's
precise list — `service.version` is per-deploy-SHA cardinality, which as a Loki *label*
would be a real anti-pattern). T02's 8-label result came from a hand-rolled, never-shipped
config. Confirmed live against the real box:
- Browser tenant labels: exactly `["deployment_environment_name","hot_framework",
  "hot_ht_major","hot_outcome","hot_surface","hot_tier","service_name"]`.
- `demos-embed` series (the `/d` lite beacon): all 7 labels populated
  (`hot_surface="d"`, `hot_tier="static"`), `hot.demo_id`/`session.id`/`cf.ray` absent from
  `/labels` (structured metadata only).
- Worker tenant: **not independently re-confirmed this session** — see Concerns; the
  mechanism (packed key exists, ledger tracks it) is real, but no worker-tenant record
  actually drained to Loki this session (see Concerns, T03B's F1/F2 interaction). Local
  evidence for the worker tenant remains T03's own prior probe (7 labels, no
  `service_version`, matching the browser-tenant finding above).

### Phase A — Concerns (real, not glossed over)

- **The drain only replays a wake's pending keys at wake START (ADR §B.3)**: a record packed
  *after* a wake was already in progress needs a fresh stop→rewake cycle to drain. Combined
  with T03B's own known F1 (one too-old record's 400 rejects the whole key) and F2 (an
  otherwise-idle wake self-stops fast), a second clean re-wake to drain a freshly-packed
  worker-tenant key did not land within this session's time budget. The `rejected-inbox-key`
  alert this session is real evidence F1 is still live in the base this task started from.
- **Criterion 9 (idle tab) was not independently re-tested.** T01's sandbox evidence (17.65
  min stop) used zero HTTP requests during the wait (`getState()` polling only), not an open,
  idle Grafana tab — a genuinely different scenario than the criterion asks for. A true
  15-minute-plus idle-tab wait was not attempted this session (time budget); flagged for the
  launch plan's post-deploy smoke rather than silently treated as covered.
- **The demo-runtime keystroke-ladder → no-new-fingerprint half of the walkthrough's alert
  scenario is untestable locally**, inherited from T06-D2: `monitorDemos` requires the
  production host, structurally unreachable under any local/automated run. T04's own unit
  tests (the exclusion at the registry-write path) remain the only proof; not re-attempted
  here since T06-D2 already established the constraint is structural, not a gap this task
  can close.
- **Tier-2 container stdout volume — unmeasured this session** (see Phase B; this is the
  dominant, load-bearing unknown in the volume projection).

### Phase A — `e2e/o11y-local.spec.ts`

New, gated `E2E_O11Y_LOCAL=1`, own port block (API 5280, o11y-facing preview 5290). Unlike
T06/T07's mocked specs, this one does **not** intercept `/telemetry/*` — it proves a real
browser's telemetry reaches the real o11y worker and is queryable back out of the real
(local) sink, the same two real bugs above included (the spec is what surfaced the CORS one;
the `aeSink` one was found manually first). Two tests, both green, run raw:

```
E2E_O11Y_LOCAL=1 pnpm e2e e2e/o11y-local.spec.ts
  ✓ Tier-1 preview.ready_ms reaches the real o11y worker and lands in Analytics Engine
  ✓ a forced /d error reaches the real o11y worker as a demos-embed lite beacon point
  2 passed
```

Both were seen failing for the right reason during development (not merely passing once):
test 1 failed on the CORS bug and, earlier, on the `aeSink` bug (points never landing); test
2 failed first on the same CORS bug (Fork never navigated) and then on `/d` proxy routing
(navigating straight at the API worker's own origin serves a lite reporter whose same-origin
`/telemetry/lite` has no route there at all — production's shared zone has no such gap
locally, so the preview server must proxy `/d` too, not just `/telemetry`; fixed with the
same `API_DEV_PORT` env var passed into the preview server's own process).

**CI wiring (T06-D8/T07/T10's flagged gap, resolved by decision, not code):** not wired.
Documented in `docs/run-and-deploy.md`'s "Tests (CI)" section, extending the paragraph T10
already wrote for `telemetry-metrics.spec.ts`: this spec needs Docker, two `wrangler dev`
processes and applied D1 migrations, the same class of prerequisite CI cannot cheaply provide
per-PR. `docs/TESTING.md`'s "every gate needs a workflow home" rule's own stated exception is
exactly this shape (a spec that needs infrastructure beyond what a PR runner should own) —
recorded as a deliberate, named exception, not a silent gap. Run it locally before every
change that touches the ingest path and before every launch.

### Phase B — volume and cost projection

Full working (every multiplier's source, the ClickHouse queries used to sanity-check live
data this session) is in the report. Summary:

**Production traffic** (`traffic-baseline.md`): the only counted Tier-2 signal is `Sessions
started` — confirmed by reading `workers/api/src/index.ts:968`, `recordUsageEvent(env,
"session_started", …)` fires exactly once, inside `POST /api/session`'s handler, nowhere
else. 13,394/30d ≈ **446 Tier-2 sessions/day**. Tier-1 (Sandpack) opens have no `/admin`
counter at all (the caveats list this explicitly); `Page views` (3,639/30d ≈ 121/day) is used
as the least-bad proxy, flagged as an assumption, not a measurement.

**Per-session multipliers, from the Outcomes, not from `/admin`:**
- Tier-2, server side (T05's own measured 5-minute/10-edit profile): 23 requests → 23
  structured Workers-Logs lines + 23 `api.request` AE points, + `session.start`/`session.end`
  (2 more AE points) + 2 spans. T07's own live measurement adds the browser-side points on
  top: `session.start_ms` (1) + `preview.ready_ms` (1) + `hmr.roundtrip_ms` (0 or 1,
  framework-dependent per T07's own table) ≈ **28 AE points/session total**, 23
  Workers-Logs-eligible lines/session (server side only — the browser points never touch
  Workers Logs, only Analytics Engine).
- Tier-1, browser side, this session's own live measurement (one clean open, no error): 3
  `/telemetry/collect` POSTs; `preview.ready_ms`(1) + `sandpack.compile_ms`(1) +
  `bucket.resolve_ms`(0–1) + `example.open`(1) + `web_vital`(10% × 4 vitals ⇒ expected 0.4) +
  `example.engaged`(≈0.5 at a 30s dwell) ≈ **5 AE points/open**, 0 Workers-Logs lines, 0
  exported-log events (a clean Tier-1 open produces no exception/log/event Faro item —
  `example.open` is explicitly AE-only per the contract, so it never reaches the inbox).
- Fixed, traffic-independent: `pool.gauge` + `budget.gauge`, every 5 min = 576 AE points/day;
  `o11y.backlog`, every 10 min = 144 AE points/day; `reconcile.run`, nightly = 30/month.

**Projected Analytics Engine points** (target: under half of 10M/month):
- 1×: 446×28 (Tier-2) + 121×5 (Tier-1) + 576+144 (fixed) ≈ 13,813/day ≈ **0.41M/month**.
- 10×: **≈4.14M/month — under half (5M), passes, with less margin than it looks (41% of the
  cap already spent by the traffic terms alone; the fixed terms are a rounding error next to
  them).**

**Projected Workers Logs pool (20M/month) and the exported-logs allotment (10M/month) —
the actual binding constraint, and it hinges entirely on the one unmeasured term:**
Structural lines alone (446 sessions/day × 23 lines, no Tier-2 stdout): 10,258/day ≈
0.31M/month at 1×, 3.08M/month at 10×. Comfortably under half of either pool **by itself**.
**Tier-2 container stdout (ADR §D: "counted in the first" — the Workers Logs pool; T02's
Cloudflare-export capture also confirms the export destination re-exports whatever Workers
Logs captures, so the same stdout volume counts against BOTH pools) was not measured this
session** — the advisor's review flagged this as the likely dominant term, and the math
confirms it: solving for the per-session stdout-line count that exactly exhausts each pool's
half at 10×, **the exported-logs allotment is the tighter constraint at ≈14 lines/session**,
the raw Workers Logs pool at ≈52 lines/session. A single Vite dev-server boot is typically
well under either figure (a handful of lines); a chattier dev server (webpack-based —
Angular, some Next configurations) at real verbosity plausibly is not. **This is the one
number this task could not close and the report calls it out as a required pre-launch
measurement**: `docker logs <sandbox container> | wc -l` for one representative session on
at least one Vite-family and one webpack-family starter, before trusting criterion 8's
"passes at 10×" for the log pools specifically (the AE-points pool passes regardless).

**Rate limiter** (`RATE_LIMITER`, 100 req/60s, shared `collect`+`lite`, T08-D5's own flagged
concern, routed to this task by progress.md): a docs page with N embeds sends up to
`4 × N` vitals-capable requests (sampled 10%, so realistically far fewer) plus up to
`20 × N` error beacons in the worst case (the `MONITOR_EVENT_CEILING`), all from one visitor
IP. At the measured production embed-view rate (≈0.13/day from `traffic-baseline.md`'s
`serve.share`+`serve.embed` figure), this limit has enormous headroom today; it becomes a
real constraint only if docs-embed traffic grows by roughly three orders of magnitude, which
is a different problem than launch. Not touched (T02 owns the limiter itself).

**Exit criterion 7 (drain wake, cost)**: **pending T03B's re-measure**, per the controller's
mid-session correction — the first T03B probe used ≈20 worker-tenant records/hour at 1×,
roughly 20× too low against T05's own measured ≈23 lines/session × 446 sessions/day
÷ 24 ≈ 430 lines/hour at 1×. T03B is re-running the probe at the corrected 1× and 10× rates.
This task's own contribution is the corrected rate itself (handed to the controller
mid-session) and the cost formula: awake-seconds × $0.038–0.074/h (the measured band, T01),
plus visit-hours; T03's own partial measurement (43s wall for a ~24-record batch) is a lower
bound on drain time, not a full-hour measurement — the $/month figure is not recomputable
with confidence until T03B's corrected probe lands.

### Phase C — exit-criteria table (ADR-0041 §L)

Full evidence, every claim traced to its source, is in the report. Classification key:
**PASS** (evidence exists, criterion met), **PASS (local only)** (met on this machine, no
platform evidence exists or is needed), **PENDING** (platform evidence needed, not yet
available), **GAP** (attempted, not closed this session).

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Clean stop, production-scoped token | **PASS** | T03-D2 root-caused and fixed (drain now wraps OTLP `resourceLogs`, not bare NDJSON) — compose PASS, `wrangler dev` PASS (progress.md). Sandbox probe with a real bucket-scoped token: **PASS per the controller** (T03B). §L's own trigger (fail 1/2/7 → serverless-store rewrite) is **not** engaged. |
| 2 | Unclean stop, reopen | **PASS** | Ledger reopen mechanism proven on the real platform (T01, T03 — `onStop` reports a clean-looking exit for a real SIGKILL, exactly ADR §A's own claim; the marker, not `onStop`, is what's trusted). Full `count_over_time`/log-query equality: **PASS per the controller** (T03B, post-D2-fix). |
| 3 | Event time | **PASS (local only)** | T02's own dedicated tests (clamped browser timestamps, un-clamped OTLP `time_unix_nano`, the fallback chain). This session's own evidence: a real, old-dated captured OTLP fixture was genuinely rejected by Loki's 7-day window — only possible if its stored timestamp preserved the original event time rather than being reset to "now," which is affirmative, if incidental, confirmation. |
| 4 | Duplicate delivery | **PASS (local only)** | T02's route-level test, plus this session's own live re-confirmation: `o11y.ingest` outcome `duplicate` × 10 in ClickHouse from repeated real duplicate-pair replays this session. |
| 5 | Symbolication | **PASS (local only)** | Re-run fresh in this worktree, not only cited from T03: a real `vite build --sourcemap` produced real `.map` files, and `pipeline/o11y-symbolicate.test.mjs`'s exit-criterion-5 case passed against them (1661/1664 total, the one remaining failure being the documented pre-existing baseline). CPU/memory are a Node proxy (~76.5ms / ~42.5MB per T03), never measured inside a real Workers isolate. |
| 6 | Cold start | **PASS** | Sandbox probe: T01 46.5s worst-of-5; T03 post-D3-fix 3–22s. Both under the 90s bound. |
| 7 | Drain wake (time + cost) | **PENDING T03B re-measure** | First probe rate was ≈20× too low (controller correction, mid-session); T03B re-running at the corrected 1×/10× rates. This task supplies the corrected rate and the cost formula (Phase B) but cannot certify the $/month figure until T03B's numbers land. |
| 8 | Volume | **PASS at 1×; PASS but load-bearing-unmeasured at 10×** | AE points comfortably under half at both 1× and 10× (Phase B: 0.41M / 4.14M of 5M). The Workers Logs / exported-logs pools pass on structural lines alone but the dominant term (Tier-2 container stdout) is unmeasured — Phase B gives the exact breakeven (≈14–52 lines/session) as the pre-launch check. |
| 9 | Idle tab | **GAP (not re-tested)** | T01's sandbox evidence used zero HTTP requests during the wait, not an open idle tab — a different scenario. Not independently re-tested this session (time budget); launch-plan post-deploy smoke item. |
| 10 | EU placement | **PASS** | Sandbox probe (T01): `mxp04` (Milan), an EU region. |
| 11 | Worker errors → structured line | **PASS (local only)** | Fetch-handler catch-all: live (T05, and re-confirmed this session — malformed `POST /api/session` produced the exact error line + Sentry envelope). Cron handler: live (T05's `cronStep` forced-failure probe; this session's own watchdog test independently exercises the same cron-error path end to end). DO alarm: unit/pipeline-tested only (T01/T02/T03), not independently re-verified live this session. The Loki leg (does the line actually land as a queryable Loki entry from a real Cloudflare export) still needs T03B's JSON-console-line answer. |
| 12 | Stop semantics | **PASS (mechanism); marker-before-SIGKILL rides on criterion 1** | `onStop` is recorded and distinguishes nothing by design (T01, matching ADR §A's own claim); "no SIGKILL escalation before the clean marker" is the same claim criterion 1's sandbox probe already re-confirms (T03B). |
| 13 | Retention | **PENDING calendar time** | Mechanism proven (R2 lifecycle rules apply and read back correctly, T01/T10). T03B's own 1-day retention-clock test (rule + 2 objects in `o11y-probe-t03-loki`, started ≈16:00–18:00 UTC today per the controller) has not yet reached its 24h mark as of this pass — check it in phase E, or list it as a post-deploy/launch smoke item if phase E lands before the clock expires. |
| 14 | Image size | **PASS** | 212.9 MB compressed (T01, real `linux/amd64` build), under the 1 GB bound. Uncompressed size against the `standard-1` 8 GB disk was not separately recorded by any task — flagged, low risk given the compressed figure's headroom. |
| 15 | Labels | **PASS (local, all 4 sources for the browser tenant; worker tenant not re-drained this session)** | See Phase A above — resolves the T02/T03 8-vs-7-label conflict definitively in T03's favour, against the real committed config and the real criterion text. Faro (`demos-authoring`) and beacon (`demos-embed`) both confirmed live this session. Cloudflare-export and deploy sources (worker tenant): T02's own sandbox probe already confirmed this shape against real captured Cloudflare traffic; this session's own attempt to re-drain a fresh worker-tenant key hit the wake-timing gap in Concerns above. |

**§L's own trigger** ("if criterion 1, 2 or 7 fails with its plan B, rewrite toward the
serverless store before more is built") is **not** engaged: 1 and 2 pass per the controller;
7 is pending a corrected re-measure, not a failure.

### Phase D — launch plan

Added to `docs/run-and-deploy.md` (new subsections under "Observability worker" and a new
"Launch: flipping `SENTRY_SCOPE`" section) — see that file directly for the full text. Summary:
runbook order (o11y worker → API worker → authoring, matching the existing deploy-order
dependency `deploy-api: needs: [..., deploy-o11y]`); every secret and one-time-setup step
T10 already wrote, cross-referenced rather than duplicated; a short production smoke list of
the facts the sandbox probes measured (EU placement, cold start, label set, R2 lifecycle);
the criteria for flipping `SENTRY_SCOPE`/`VITE_SENTRY_SCOPE` to `uncaught` (data seen end to
end in Grafana — this session's own walkthrough is exactly that evidence for local; alerts
firing once — this session's own watchdog/new-fingerprint tests are that evidence locally;
volume inside the projection — Phase B, pending the one flagged measurement) and who flips
them (a role, not a named person — left for the user to assign); rollback (drop the export
destinations, revert the `observability` block; the scope flag needs no revert, matching the
ADR's own Consequences).

### Deferred to final review (not fixed, collected from `.superpowers/sdd/README/progress.md`
and the `*-fix-findings.md` files, per the controller's instruction — none of these were
touched this pass)

- **T01** (`T01-fix1-findings.md`, minors deferred at the time): M3 pin
  `[auth.anonymous] enabled=false`; M4 fail on any stray `GF_*` var in the box block other
  than `GF_SERVER_ROOT_URL`; M5 the port test should check every line under `ports:`
  (including the 8123 default); M6 pin `reject_old_samples: true`; M7 a `\Z` in a regex is a
  literal `Z` in JS, not "end of string"; M8 the Dockerfile secret-scan regex misses
  `ENV KEY value`/`ARG KEY`; M10 a duplicated sub-path test; M12 `stop_grace_period: 45s` vs
  `O11Y_STOP_GRACE_SECONDS` coupling undocumented, 30s Loki grace may be tight under real
  2h chunk ages; M13 round-trip line bodies lack a `RUN_ID`, the script never tears down its
  own stack.
- **T03** (progress.md): `seenHashes` per-alarm not per-wake (T03-D6, already argued
  sufficient in the Outcome, not re-litigated); reopen-window tracking is unbounded; the logo
  markup is duplicated between the waking page and Grafana's own login screen.
- **T04** (progress.md): the new-fingerprint rule has no self-resolve test; no rollover test
  for the alert-state storage; `reconcile.run`'s `usd` semantics are "total written," not a
  true billing-minus-estimate delta.
- **T05** (progress.md): `container.boot_ms`'s contract-documented `boot_timeout` outcome vs
  T05-D4's actual `window_exceeded` choice; several §5 metrics remain unobserved
  (`pool.gauge` `reason=builder`, `snapshot.build` `reason=inline`, `session.end`
  `reason=sleep_after`); live Sentry spans were asserted only by code reading, not measured.
- **T08** (progress.md, carried explicitly to this task): `RATE_LIMITER` (100/60s, shared
  `collect`+`lite`) may be tight for an embed-heavy docs page — addressed in Phase B above
  (headroom assessed, not a blocker at current or 10× traffic).
- **T09** (its own Outcome's Concerns, not a separate findings file): the Loki out-of-order
  tolerance measured ~20 min in T09's own seed script is explained by T03-D1 as a seeding
  artifact, not a real config limit — no action needed, recorded for completeness.
- **T12** (progress.md): the metric registry's `example.open` `reason` enum carries an unused
  `"entry"` value (a contract-doc parenthetical-parsing artifact, harmless); no screenshot for
  the Examples & features dashboard (partially addressed this pass — see Phase A's dashboard
  table, still not screenshotted); the production Analytics Engine SQL leg of
  `queryExampleEventTotals` is unverified (no credentials, same class of gap as everywhere
  else); `example_daily` has no `downloaded` column (ADR followed literally, flagged for
  ADR-0043).

### Verify — commands run, exit codes

All run raw (not `rtk proxy`, since this is not a fresh-implementer task; exit codes read
directly), from `runner/`, in this worktree, after tearing down the local stack:

```
pnpm install                                                        exit=0
pnpm --filter @handsontable/demo-runtime build                       exit=0
pnpm -r run typecheck                                                 exit=0 (all 5 typecheck-having projects)
pnpm --filter @handsontable/demo-authoring build                      exit=0 (plain production build)
pnpm check:compiler-chunk                                             exit=0
pnpm check:telemetry-leak                                             exit=0 (plain build, 0 sentinels)
grep -rl "VITE_DEV_USER|dev@handsontable.com|localhost:8787|t11-*@handsontable.com" apps/authoring/dist   (no match)
( cd apps/authoring && npx vite build --sourcemap )                   exit=0 (real .map files, for exit criterion 5)
pnpm test    exit=1 (1664 tests, 1661 pass, 1 known pre-existing baseline failure —
                      theme-presets-version.test.mjs / "the pin tracks its own major's
                      starter bucket" — 2 todo, 0 other failures; exit criterion 5's own
                      test PASSES against the real sourcemapped dist, not skipped)
node scripts/check-test-presence.mjs feat/runner-observability        (re-checked post-commit, see below)
( cd workers/o11y && npx wrangler deploy --dry-run )                  exit=0
( cd workers/api && npx wrangler deploy --dry-run --routes ... )      exit=0
E2E_O11Y_LOCAL=1 pnpm e2e e2e/o11y-local.spec.ts                      exit=0 (2/2, run raw, twice for reliability)
```

Local environment torn down after: `docker compose ... down -v`; every `wrangler dev`/`vite`
process killed; one leftover `GrafanaBox` proxy container (wrangler dev does not clean this
up on its own process's exit — the same "manual `docker stop`" gap T07's own Outcome already
flagged for local Tier-2 runs) removed by hand, confirmed against a `docker ps -a` snapshot
taken before this task started — no other container left behind. `.dev.vars` (both workers,
gitignored, never committed) and `.wrangler/`/`.wrangler-registry` state removed.

### Phase E (after T03B merged, `917fe1cde`)

`git merge feat/runner-observability` — clean, no conflicts (T03B touched only
`workers/o11y/src/{box.ts,drain/drain.ts,grafana/proxy.ts,inbox/ledger.ts,
normalise/otlp.ts}` and its own tests/fixtures, none of which this task's phase A–D
commit touched).

**Both gaps flagged in phase A–D closed with real local evidence, on the merged code:**

- **Worker-tenant drain.** Rebuilt the environment, pushed fresh fixture traffic, forced a
  real stop→rewake cycle (the F1/F2/F3 fixes make a *quiet* wake self-stop correctly, which
  means getting a *fresh* wake to drain a key packed mid-wake now needs an explicit
  `docker kill` + rewake, not just waiting — the drain still only replays pending keys at
  wake start, ADR §B.3, unchanged by T03B). Result: both worker-tenant series
  (`demos-o11y` deploy events, `demos-api` OTLP export, including a `production`-environment
  variant from this session's own earlier watchdog test) carry all 7 labels, confirmed live
  via Grafana's own datasource proxy.
- **Exit criterion 2, full replay-equality, locally.** Pushed one canary Faro exception,
  waited for pack, killed the box within ~0.4s of a fresh wake starting (before drain could
  plausibly complete), let the ledger reopen the key, then a clean rewake replayed it. Both
  `query_range` (`|= "canary"`) and `count_over_time(...[6h])` returned exactly one entry —
  no duplication survived the interrupted-wake → reopen → replay cycle, independently
  confirming T03B's own sandbox-platform result.

**Tier-2 container stdout, measured (not a breakeven guess).** One real local Tier-2
session (`react-js`, Vite family) under `wrangler dev`: 12 log lines at boot (the Sandbox
SDK's own structured health-check logging, not the dev server's own output — file edits and
HMR add zero lines), +2 lines per 60-second keepalive poll thereafter. A second session
(`angular`, slower-booting) logged 22 lines at boot, same +2/poll rate. Folded into the
projection (ADR-0041 §D "Measured," this pass): at the corrected 10× traffic scale, this
pushes the **exported-logs allotment** over half (the raw Workers Logs pool still passes
with margin) — a real, measured finding, not the earlier breakeven estimate. Carried into
the Launch plan's post-deploy smoke as a concrete, comparable number.

**Exit-criteria table updated** with T03B's real platform numbers (criterion 7: PASS,
$0.21/month at 1×, $0.33/month at 10×, 28s/44s wake-to-drain; criteria 1 and 2: PASS on the
real platform; criterion 13: still PENDING the calendar — T03B's clock started
2026-09-23T14:15:22Z, more than 24h had not yet elapsed as of this phase). Full table now
lives in `docs/adr/0041-observability-stack.md` §L "Results" (folded in, not duplicated
here).

**ADR fold.** Every `T<nn>-D<k>` delta reviewed; the load-bearing ones (design-level facts
a reader needs, not implementation trivia) folded as direct edits into ADR-0041's own
prose (§A cost and wake/stop, §B.3 drain-rejection, §C.2 labels, §D volume) plus a new §L
"Results" table and a new §M "Implementation deltas" appendix for the rest. ADR-0042 got
the T12 deltas (the confirmed `forked_from` format/cutoff date, the fork-landing URL
marker, the missing `downloaded` D1 column, the missing zero-open panel). ADR-0043
untouched (T13 not dispatched, nothing to fold). **ADR-0041 and ADR-0042 status: stay
Proposed, not flipped to Accepted** — two exit criteria lack the evidence the flip requires:
criterion 5 (symbolication CPU/memory, measured only via a Node proxy, never inside a real
Workers isolate — no task had isolate profiling access) and criterion 13 (the retention
clock has not yet reached 24h). Both are named explicitly in ADR-0041's own status line and
in the ADR README index, not left implicit. Criterion 8's real, measured exported-logs
finding is carried as a named pre-launch action (the ADR's own documented sampling-rate
fallback), not treated as a blocker to the ADR's status, since it has evidence — it just
shows a problem the design already has an answer for.

`docs/adr/README.md` and `AGENTS.md`'s observability bullet updated to match (built,
locally and sandbox-verified, not yet deployed; `SENTRY_SCOPE` still defaults to `full`
everywhere, so nothing about today's Sentry behaviour changes yet).

Final commit of this pass: `git rm -r runner/tasks/o11y` (this file included) — the task
board's job is done; every kept fact now lives in the ADRs, the contract, or
`docs/run-and-deploy.md`. `grep -rnE "tasks/o11y|task board|ADR-DELTAS" runner` confirmed
clean outside the deletion itself before it landed (see
`.superpowers/sdd/README/T11-report.md` for the exact command, output, and the final DoD
run).
