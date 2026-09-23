# T07 — Browser metrics catalogue

| | |
|---|---|
| Status | todo |
| Size | M |
| Depends on | T00 (facade interface); merges after T06 |
| Blocks | T09 (real browser data), T11 |
| ADR | 0041 §F.2 ("Play" and "Edit live" rows, browser side) |
| Owns | timing hooks in `packages/runtime/src/sandpack.ts` and `container.ts`, `apps/authoring/src/telemetry/metrics.ts` (new), the timing call sites in `App.tsx` (example resolve, version switch, bucket resolve), `pipeline/browser-metrics.test.mjs`, `e2e/telemetry-metrics.spec.ts` |

## Goal

The headline metric, `preview.ready_ms`, and the rest of the browser catalogue are
emitted once per real occurrence, with the right attributes, through the facade.

## Read first

- Contract §5 rows marked "browser (T07)", §6 (Faro mapping).
- `packages/runtime/src/sandpack.ts` (status handling, the `done` case ~:563),
  `container.ts:669-704` (session diagnostics timing), `apps/authoring/src/App.tsx`
  (example resolve, `data-preview-status`, version switch).

## Scope

In:

- The runtime package exposes timing through callbacks or events on the existing
  `DemoRuntime` interface; it never imports the facade (the runtime stays app-agnostic).
- `preview.ready_ms`: from the moment an example is resolved to `data-preview-status =
  ready`, with tier, framework, ht_major, bucket and outcome (`ready`, `error`, `timeout`,
  `abandoned` when the user switches away first). Once per resolved example, never per
  render.
- `sandpack.compile_ms`, `sandpack.compile_error` (normalized, fingerprinted, no code),
  `sandpack.bundler_unreachable`.
- `version.switch` (from, to, bucket) and `bucket.resolve_ms`.
- `session.start_ms` on the client, with outcome and cold/warm, reusing the existing
  session diagnostics.
- `hmr.roundtrip_ms`: find a hook per framework for "preview refreshed after an edit" (the
  Tier-2 dev server's HMR message relayed through the existing monitor postMessage is the
  first candidate). Emit it only where the hook is reliable; list supported and unsupported
  frameworks in the Outcome.
- Map Faro's web-vitals measurements to `web_vital` for the authoring surface (the
  mapping itself happens at ingest in T02; verify the attributes arrive).

Out: error reporting (T06); embed and `/d` vitals (T08).

## Acceptance criteria

- `pipeline/browser-metrics.test.mjs` drives the timing hooks with a fake runtime and a
  `recordingTelemetry`: one `preview.ready_ms` per resolve, `abandoned` on a switch before
  ready, no second emission on re-render; each case fails when its guard is removed.
- `e2e/telemetry-metrics.spec.ts`, gated `E2E_LIVE=1` (it mounts a real preview) and
  `E2E_TELEMETRY=1` (it needs a dist built with `VITE_TELEMETRY_LOCAL=1`, contract §10),
  captures `/telemetry/collect` with `page.route`, opens a Tier-1 and a Tier-2 example and
  asserts one `preview.ready_ms` each with the right tier and framework.
- The Outcome has the HMR support table and one measured `preview.ready_ms` per tier from
  a local run.

## Verify

```bash
cd runner
pnpm --filter @handsontable/demo-runtime build
pnpm -r run typecheck
pnpm test
VITE_TELEMETRY_LOCAL=1 pnpm --filter @handsontable/demo-authoring build
E2E_LIVE=1 E2E_TELEMETRY=1 pnpm e2e e2e/telemetry-metrics.spec.ts
```

## Traps

- `data-preview-status="booting"` precedes `error`; asserting on `booting` once passed with
  the fix reverted. Assert on the terminal status and the measured payload.
- An identical module set makes Sandpack reset the document without re-evaluating; a
  "no-change compile" must not emit a second ready.
- The specs that mount Sandpack only run under `E2E_LIVE=1`; a default run proves nothing.
- E2E specs import runtime source, not `dist`.

## Outcome

_Filled in when done._
