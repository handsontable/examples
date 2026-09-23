# T12 — ADR-0042 example analytics

| | |
|---|---|
| Status | todo |
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

_Filled in when done._
