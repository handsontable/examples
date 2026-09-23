# T12 — ADR-0042 example analytics

| | |
|---|---|
| Status | done |
| Size | M |
| Depends on | T02 (ingest, AE extraction), T06 (facade); `App.tsx` edits merge after T06 and T07; the rollup call merges after T04 |
| Blocks | T11 |
| Runs in parallel with | T03, T04, T08, T09 |
| ADR | [0042](../../docs/adr/0042-example-analytics.md) revision 2 in full |
| Owns | `example.*` emission at the example-resolve path in `App.tsx`; the `forked_from` format check; a D1 migration for `example_daily`; the rollup module called from the reconcile cron; `containers/o11y/grafana/dashboards/examples.json`; `pipeline/example-analytics-*.test.mjs`; `e2e/example-analytics.spec.ts` |

## Goal

Count which docs guides and starters people open and engage with, attribute saved demos
through the existing `forked_from`, and keep a permanent daily record.

## Scope

- Events per ADR-0042 §1–2, with `entry` derived in the app; contract slots `kind`
  (`blob17`), `ref` (`blob18`) and `area` (`blob19`) are already assigned.
- Confirm the exact `forked_from` format for docs examples and the first date from which
  every save carries it; record both in the Outcome and use the date for `unknown`.
- `example_daily` (with an `area` column) and primary key `(day, kind, ref, framework,
  ht_major)`, recomputed for
  the previous full UTC day with `INSERT OR REPLACE`.
- The Examples & features dashboard over Analytics Engine (ADR-0042 §6).

## Acceptance criteria

- A test drives the real resolve path: one `example.open` per resolved example, with the
  guide, area and framework read from the loaded docs-example entry, none on re-render.
- A test proves `example.*` never reaches the inbox or Loki.
- Running the rollup twice for one day yields identical rows.
- `e2e/example-analytics.spec.ts` (gated `E2E_TELEMETRY=1`) opens a docs example by
  `?docs=` and one from the picker and captures `entry = deep-link` and `picker`.

## Verify

```bash
cd runner
pnpm --filter @handsontable/demo-runtime build
pnpm -r run typecheck
pnpm test
( cd workers/api && npx wrangler d1 migrations apply handsontable-demos --local )
VITE_TELEMETRY_LOCAL=1 pnpm --filter @handsontable/demo-authoring build
E2E_TELEMETRY=1 pnpm e2e e2e/example-analytics.spec.ts
```

## Traps

- Opening an example never reaches the API worker; the event comes from the browser.
- Read taxonomy from the loaded entry, never from the URL.
- Never hard-code a docs bucket minor in a spec.
- Counts only: no page-load id, no user id, no referrer.

## Outcome

### `forked_from` format and first date (determined from code + git history, not production data)

Docs-example saves carry `forked_from = docs:<bucket>:<content-path>` (e.g.
`docs:18.1:guides/accessibility/accessibility/react/example1.tsx`), written at
`apps/authoring/src/App.tsx`'s `loadWorkspace` call sites. `git log -S'docs:'`
on `App.tsx` shows this exact 3-segment shape landed in commit `3277a52a4`
("feat(docs): load versioned example buckets"), **2026-07-17 13:38:35
+0200** — before that commit, a docs save carried the 2-segment
`docs:<content-path>` (no bucket). This matches the ADR's own "review:
2026-07-17" note exactly. `forked_from` for the other kinds: `catalog:<framework>`
(starter), `import:<provider>`, `payload:theme-builder`, and (from the MCP
service, unrelated to this task) `mcp:<framework>`.

No code in this task performs the `demos.forked_from` ↔ `/d`/`/embed`-view
join the ADR describes (§ Decision 3) — re-reading ADR-0042 closely, that
join is not part of `example_daily`'s own column list (no `forked_from`-derived
column exists there) and no dashboard panel in §6 needs it either; it reads as
groundwork for a future (ADR-0043) capability, not a T12 deliverable. Recorded
here as the task asked ("confirm... and record both in the Outcome"); **use
2026-07-17 as the cutoff for "unknown"** in whatever later reads `forked_from`
for docs attribution — a save before that date has no bucket segment and its
`ref` cannot be resolved back to a guide.

### What was built

- **The AE-only attribute wall (T02-D4's channel, extended).** `packages/runtime/
  src/telemetry/attrs.ts`: `ATTR_HOT_METRIC_KIND`/`ATTR_HOT_REF`/`ATTR_HOT_AREA`
  added to `AE_ONLY_ATTRIBUTE_KEYS` (merged with T07's `bucket`/`reason`/
  `fingerprint` entries in the same category after `feat/runner-observability`
  was merged into this branch — see "T07 merge" below). Without this, the
  browser-side scrub (`scrubTelemetry`'s allowlist, run in `beforeSend` BEFORE
  the request leaves the tab) silently stripped `kind`/`ref`/`area` from every
  `example.*` event; T02's own `o11y-normalise.test.mjs` fixture test could not
  catch this because it starts downstream of the browser (see
  `pipeline/example-analytics-ingest.test.mjs`). `apps/authoring/src/telemetry/
  faro.ts`: `DOTTED_ATTR_KEY` maps `kind`→`hot.metric_kind` (`hot.kind` is
  reserved for the Faro item kind), `ref`→`hot.ref`, `area`→`hot.area`.
- **`apps/authoring/src/exampleAnalytics.ts`** (new, import-free, same
  discipline as `tier1Report.ts`/`demoEventReport.ts`): `kindOfLineage`,
  `exampleTaxonomy` (ref = the loaded docs entry's `guide`, never `docsPath`/
  the URL; area = its `breadcrumb[0]`; framework = its own `framework`, more
  precise than the app's catalog framework for docs), `exampleOpenAttrs`,
  `exampleActionAttrs`, `exampleOpenKey` (dedup key: `lineage` + pinned
  version).
- **`App.tsx` wiring**, confined to `loadWorkspace` (the one function every
  resolve path — starter, docs, import, payload, saved demo — already funnels
  through, DEV-2859) plus its six call sites: an optional `exampleOpen`
  parameter carries `reason`/`version`/`bucket`/`docs` explicitly from the
  caller (never read off component state inside the callback — the saved-demo
  path calls `setVersion(pinnedVersion)` immediately before `loadWorkspace`,
  which would otherwise race a stale closure). `entry` classification:
  `deep-link` (`?docs=`/`?example=` at boot, import, payload, saved-demo
  reopen), `picker` (`selectExample`, the docs picker leaf), `switch` (the
  framework-tab docs switcher, `onFrameworkChange`), `version-switch` (a
  bucket-crossing version change for an already-open example, both the docs
  bucket-resolve effect and the starter effect). `example.engaged` fires once
  per workspace on the first code edit (`markDirty`) or preview-ready + 30s
  (whichever first); `example.forked`/`.saved`/`.shared`/`.downloaded` fire
  from `onFork`/`onSave`/`onEmbed`/`downloadZip`.
- **`workers/api/migrations/0008_example_daily.sql`** + **`reconcile.ts`**
  (`queryExampleEventTotals`, `pivotExampleDaily`, `writeExampleDaily`,
  `rollupExampleDaily`) + one line in `index.ts#runNightlyCron`.
- **`containers/o11y/grafana/dashboards/examples.json`** — 7 panels (see
  Concerns for the 8th).
- Tests: `pipeline/example-analytics-taxonomy.test.mjs` (12),
  `pipeline/example-analytics-ingest.test.mjs` (3),
  `pipeline/example-daily-rollup.test.mjs` (9), `e2e/example-analytics.spec.ts`
  (2), plus one line in `pipeline/o11y-dashboards.test.mjs`'s own fixed
  dashboard-title list.

### T07 merge

T07 (browser metrics) merged into `feat/runner-observability` mid-task
(commit `eeae290f9`), per the controller's message. Merged it into this
branch (`git merge feat/runner-observability`); two expected conflicts, both
exactly where T07 and this task independently extended the same
`AE_ONLY_ATTRIBUTE_KEYS` array/`DOTTED_ATTR_KEY` map (T07: `bucket`/`reason`/
`fingerprint`; T12: `kind`/`ref`/`area`) — a straightforward union, resolved
by hand, both halves kept, doc comments merged to describe all six. `App.tsx`
merged clean (no textual overlap — T07's own edits landed in the mount effect/
`changeVersion`/bucket-resolve effects, this task's in `loadWorkspace` and its
call sites). Full repo typecheck + `pnpm test` re-run clean after the merge
(only the one pre-existing baseline failure).

### Deviations (`T12-D<k>`)

- **T12-D1 — the bare-`/` default is not counted.** Landing on `/` with no
  `?example=` at all defaults `framework` to `"react"` with nothing in the
  URL — that silent default is not a visitor reaching for the react starter,
  and counting it would swamp the starter ranking on every plain visit.
  Suppressed via a new `hadUrlExample` ref (same pattern as the existing
  `hadUrlVersion`). Empirically load-bearing, not just a nicety: the picker
  e2e test's own `example.open` count would have been ambiguous without it
  (see the e2e commit's revert-evidence note).
- **T12-D2 — FIXED in the fix round (review finding).** Originally: a
  post-fork landing on the new demo's own `/edit/:id` read as a plain
  `deep-link`, not the ADR's closed `fork` value — skewing the §6
  deep-link-share panel. Fixed with a one-shot URL marker, never browser
  storage (the contract keeps this path off `localStorage`/`sessionStorage`):
  `onFork` appends `?fork=1` to its `location.href` navigation (a full
  reload — the same hard-navigation pattern this app already uses for every
  other route change, so no in-memory flag survives it either, which is why
  the "client-side" branch the review's fix instructions offered does not
  apply here). `exampleAnalytics.ts#consumeForkMarker` (new, pure — reads
  and strips the marker from a `location.search`-shaped string, unit-tested
  in `pipeline/example-analytics-taxonomy.test.mjs`) is called at the top of
  the saved-demo load effect, synchronously, before the async fetch —
  stripped via `history.replaceState` immediately, so a manual reload of the
  same URL is never re-read as a fork. `example.forked` itself (the action
  metric on the demo `onFork` is forking FROM) was already correct and is
  unaffected. See "Fix round" below for tests and revert evidence.
- **T12-D3 — `example_daily` has no `downloaded` column.** ADR-0042 §5 names
  the table's five counters as `opens, engaged, forked, saved, shared` — for
  six `example.*` metrics. Followed the ADR literally (migration `0008`
  has no `downloaded` column); the AE point for `example.downloaded` still
  exists and is still queryable directly, it is just not rolled into D1.
  Flagged for whoever owns ADR-0043's longer-range view.
- **T12-D4 — `values.reason` on the `example.open` metric registry row lists
  a sixth value, `"entry"`, this task never emits.** `packages/runtime/src/
  telemetry/metrics.ts` (T00-owned, not touched): `values: { reason:
  ["entry", "deep-link", "picker", "switch", "version-switch", "fork"] }`.
  Traced to `docs/observability-contract.md`'s own table cell
  `reason (\`entry\`)` in the Blobs column — `telemetry-contract.test.mjs`'s
  parser reads a parenthetical as "this column's allowed values include
  what's inside the parens," which is exactly right for every OTHER row
  (e.g. `outcome (\`ok\`, \`error\`)`) but reads as an extra allowed value
  here, where the ADR's own prose uses "entry" as the FIELD's name/role
  ("and `entry` — `deep-link` when... `picker`... otherwise"), not as a
  value. Harmless (a wider allowlist than needed; `toAePoint` never rejects
  a value that's merely unused) — this task emits only the 5 real ADR values
  and never "entry" itself. Not fixed (outside this task's Owns row, and
  fixing the parser/doc precisely enough to not regress every other row's
  legitimate parenthetical-value cell was judged out of scope for a
  same-task fix).

### Acceptance criteria — evidence

- **"One `example.open` per resolved example... none on re-render"**:
  `exampleOpenKey(lineage, version)` dedup in `loadWorkspace`, proven live by
  `e2e/example-analytics.spec.ts`'s first test (an explicit 1s idle wait after
  the open, recount stays 1) and structurally by construction (an effect
  re-run with the same key is a no-op).
- **"`example.*` never reaches the inbox or Loki"**:
  `pipeline/example-analytics-ingest.test.mjs` — NOT T02's own fixture test
  (which starts downstream of the browser and cannot see the wall this task
  fixed); this file drives `scrubTelemetry` on the exact wire shape
  `attrsToContext`+`pushEvent` produce, then the real `processFaroBody`,
  asserting zero `ingestItem`s and one AE point with `blob17`/`18`/`19`
  filled. Revert evidence: reverting the `AE_ONLY_ATTRIBUTE_KEYS` spread
  turned the scrub assertion red (`'' !== 'docs'`); restored, re-verified
  green.
- **"Running the rollup twice for one day yields identical rows"**:
  `pipeline/example-daily-rollup.test.mjs`, against a REAL SQLite database
  built from the REAL migration file via `node:sqlite` (not a regex-based D1
  mock) — proves the actual `PRIMARY KEY (day, kind, ref, framework,
  ht_major)` is what enforces idempotency. Revert evidence: removing the
  `DELETE FROM example_daily WHERE day=?1` statement turned the
  "disappearing group" test red (`2 !== 1` — a stale row lingered); restored,
  re-verified green.
- **`e2e/example-analytics.spec.ts`**: 2 tests, gated `E2E_TELEMETRY=1`, own
  port (5301, T12's block 5300–5399), a dedicated `VITE_TELEMETRY_LOCAL=1`
  preview server (T06's pattern). Docs catalog fully stubbed (never the real
  `apps/authoring/public/docs-examples/` content — the Traps say never
  hard-code a docs bucket minor, and a stub sidesteps that by construction:
  the bucket is whatever `stubShell`'s fake `/api/versions` resolves to).
  Deep-link: `hot.reason=deep-link`, `hot.ref`=the guide (asserted `!==`
  docsPath too), `hot.area`=breadcrumb[0], framework/ht_major/bucket all from
  the loaded entry. Picker: search + click, `hot.reason=picker`. Revert
  evidence: reverted the docs `ref` to `docsPath` instead of `guide` — the
  deep-link test failed for exactly that (received the docsPath-prefixed
  value); restored, re-verified green.

### `queryExampleEventTotals` — what was and wasn't verified

Local ClickHouse leg verified twice against real throwaway
`clickhouse/clickhouse-server:24.10-alpine` containers (T01's own DDL,
outside any compose stack, removed afterward both times): once driving the
function itself end-to-end (a seeded row → the real JS function → the
expected pivot-ready row), and again running every one of the dashboard's 7
panel queries with their macros substituted, against a small seeded dataset —
all 7 returned the expected shape and values. The production Analytics
Engine SQL API leg (`CF_ACCOUNT_ID`/`AE_SQL_TOKEN`) is **unverified** — no
credentials available to this task (COMMON.md: no production DB access) —
and deliberately written to the most conservative, no-function-call form
(`timestamp >= '...' AND timestamp < '...'` as plain quoted-string
comparisons, no `toDateTime64`/`parseDateTime` call) specifically because
that form could not be checked against a real AE account. Same
documented-default status T02-D12's size caps and T09-D5's "unmeasured
against real Analytics Engine" have.

### Dashboard — Examples & features

7 of ADR-0042 §6's 8 named panels (top guides by opens/engaged — one query,
not two, via the boolean-multiply `sum(... * (index1 = 'x'))` trick
`version-health.json` already uses; area breakdown; framework split per
guide; starter ranking; `ht_major` distribution; the open→engaged→saved→
shared funnel by area, same trick; deep-link share of opens). **Not
implemented**: "zero-open examples over 90 days" — Analytics Engine only
ever holds points for events that DID happen; a "never happened" query needs
the full docs-example taxonomy (every guide × framework that exists) to
diff against, which lives in the docs-examples JSON, not in `runner_events`
or D1. Flagged, not solved.

Same datasource uids/variables as T09's other 7 dashboards. Verified against
`pipeline/o11y-dashboards.test.mjs` (52/52 including the extended fixed
dashboard-title list T09's own file separately hardcodes alongside its
dynamic `readdirSync` loader) with one deliberate revert (an unknown column
in this dashboard's own first panel — confirmed red for the right reason,
restored) — and against the same local-ClickHouse container described above.
No live Grafana box was started for this task (no screenshot) — the
controller's T09 dispatch used `docker compose ... up -d --build` against
the full box; this task's own effort budget went to the query-correctness
verification above instead. Flagged as a gap if a screenshot is required
before this ships.

### Verify — commands run, exit codes

All via `rtk proxy <command>; echo "exit=$?"` from `runner/`, rtk's own
summaries not trusted (COMMON.md).

```
rtk proxy pnpm install                                            exit=0
rtk proxy pnpm --filter @handsontable/demo-runtime build           exit=0
rtk proxy pnpm -r run typecheck                                    exit=0 (all 5 typecheck-having workspaces)
rtk proxy pnpm test                                                exit=1 (1511 tests, 1508 pass, 1 pre-existing
                                                                     baseline failure — theme-presets-version.test.mjs,
                                                                     "the pin tracks its own major's starter bucket",
                                                                     controller-verified/COMMON.md; 2 todo)
( cd workers/api && npx wrangler d1 migrations apply
  handsontable-demos --local )                                     exit=0 (0008_example_daily.sql applied clean)
VITE_TELEMETRY_LOCAL=1 pnpm --filter @handsontable/demo-authoring build
                                                                     exit=0
E2E_TELEMETRY=1 pnpm exec playwright test
  e2e/example-analytics.spec.ts                                    exit=0 (2/2)
rtk proxy node scripts/check-test-presence.mjs
  feat/runner-observability                                        exit=0 (6 source files, matching test change)
rtk proxy pnpm check:compiler-chunk                                exit=0
rtk proxy pnpm check:telemetry-leak                                exit=0 (plain build, 0 sentinels)
( cd workers/api && npx wrangler deploy --dry-run )                exit=0
( cd workers/o11y && npx wrangler deploy --dry-run )                exit=0 (unaffected by this task's changes;
                                                                     run to confirm no cross-worker regression from
                                                                     the shared attrs.ts edit)
```

### Concerns / follow-ups

- No live Grafana screenshot for the new dashboard (see above) — query
  correctness verified against real ClickHouse instead.
- `queryExampleEventTotals`'s production (Analytics Engine SQL API) leg is
  unverified — no credentials available to this task.
- T12-D3: `example_daily` has no `downloaded` column, following the ADR
  literally; flag for ADR-0043.
- T12-D4: the metric registry's `values.reason` for `example.open` carries
  an extra, unused `"entry"` value from what looks like a contract-table
  parenthetical-parsing artifact — harmless, not fixed, out of this task's
  Owns row.
- T12-D2: fixed in the fix round — see below.
- The `demos.forked_from` ↔ `/d`/`/embed`-view join ADR-0042's Decision 3
  describes has no code in this task (see the `forked_from` section above) —
  read as ADR-0043 groundwork, not a T12 deliverable; the confirmed format
  and cutoff date are recorded above for whoever builds it.

## Fix round (review finding: `entry=fork` never emitted)

Single finding, T12-D2 promoted from a documented deviation to a real gap:
"folding forks into deep-link skews the §6 deep-link-share panel." Fixed —
see T12-D2 above for the mechanism.

### What changed

- `apps/authoring/src/exampleAnalytics.ts`: new `FORK_LANDING_PARAM` const
  and `consumeForkMarker(search)` — pure, reads/strips a `?fork=1`-shaped
  URL marker, idempotent (a second call on the already-stripped search
  returns `isFork: false`).
- `apps/authoring/src/App.tsx`:
  - `onFork` appends `?fork=1` to its `location.href` destination.
  - The saved-demo load effect calls `consumeForkMarker(location.search)`
    synchronously at the top (before the async fetch), strips the marker via
    `history.replaceState` immediately when present, and passes
    `reason: isForkLanding ? "fork" : "deep-link"` to `loadWorkspace`'s
    `exampleOpen` parameter (previously always `"deep-link"`).
- `pipeline/example-analytics-taxonomy.test.mjs`: 5 new tests for
  `consumeForkMarker` (detect+strip, preserves other params, no-marker
  passthrough, empty search, one-shot/idempotent).
- `e2e/example-analytics.spec.ts`: one new test — lands directly on
  `/edit/:id?fork=1` (a stubbed saved demo, same recipe as
  `e2e/description-markdown.spec.ts#stubSavedDemo`) and asserts
  `hot.reason=fork`, `hot.metric_kind=saved`, and that the URL no longer
  carries `fork` after the landing (the one-shot strip).

Considered and rejected: an in-memory one-shot flag (the review's other
offered option, for a client-side navigation). Does not apply here —
`onFork`'s `location.href = ...` is a full page reload, the SAME
hard-navigation pattern this app already uses for every other route change
(`/my-demos`, `/admin`, `/guide`, `/api-tokens`, …, confirmed by grep — never
client-side routing to `/edit/:id`). A full reload destroys every in-memory
flag before the new page's first render, so only a URL marker (never
`localStorage`/`sessionStorage`, per the review's own constraint) can survive
it.

### Tests — shown failing before the fix, then green

- `pipeline/example-analytics-taxonomy.test.mjs`'s 5 new `consumeForkMarker`
  cases: written and run BEFORE `consumeForkMarker` existed — failed with
  `SyntaxError: ... does not provide an export named 'consumeForkMarker'`
  (the whole file, 1 test reported, fail). Implemented; re-ran: 14/14 pass.
- `e2e/example-analytics.spec.ts`'s new fork-landing test: passed once
  written (the implementation was already in place by then), so reverted
  the App.tsx classification line back to the unconditional `"deep-link"`
  and re-ran — failed for exactly the right reason (`Expected: "fork",
  Received: "deep-link"`); restored, re-ran: 3/3 pass.

### Verify — fix round, exit codes

```
rtk proxy node --experimental-strip-types --test
  pipeline/example-analytics-taxonomy.test.mjs                       exit=0 (14/14)
rtk proxy pnpm -r run typecheck                                      exit=0
rtk proxy pnpm test                                                  exit=1 (1516 tests, 1513 pass,
                                                                        1 pre-existing baseline failure
                                                                        — theme-presets-version.test.mjs,
                                                                        same as before — 2 todo)
E2E_TELEMETRY=1 pnpm exec playwright test
  e2e/example-analytics.spec.ts                                      exit=0 (3/3)
rtk proxy node scripts/check-test-presence.mjs
  feat/runner-observability                                          exit=0
rtk proxy pnpm --filter @handsontable/demo-authoring build            exit=0
rtk proxy pnpm check:compiler-chunk                                  exit=0
rtk proxy pnpm check:telemetry-leak                                  exit=0 (plain build, 0 sentinels)
```

No worker source touched this round (App.tsx/exampleAnalytics.ts/pipeline/e2e
only) — the two `wrangler deploy --dry-run` runs from the main pass are
unaffected and were not re-run.
