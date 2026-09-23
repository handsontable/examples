# T08 — Lite beacon on embeds and `/d`, serve counts

| | |
|---|---|
| Status | todo |
| Size | M |
| Depends on | T00, T02 (`registerRoute`) |
| Blocks | T09 (Docs embeds dashboard), T11 |
| ADR | 0041 rev. 3 §C.5, §F.2 ("Share & build", "Embed on docs"); contract §9 |
| Owns | `packages/runtime/src/monitor.ts` (beacon transport and standalone mode), `workers/api/src/share.ts` (injection at the serve seam, `serve.*` counts), `workers/api/src/monitor-inject.ts`, `workers/o11y/src/lite.ts`, `pipeline/{lite-beacon,lite-inject}.test.mjs` |

## Goal

The highest-traffic surface — docs embeds and built `/d` demos — reports uncaught errors
and sampled web vitals with a script under 2 KB that cannot break the page it lands in,
and the API worker counts what it serves.

## Read first

- Contract §9 (payload), §8 (lite stored as `faro`), §5 (`web_vital`, `error.uncaught`,
  `serve.*`).
- `packages/runtime/src/monitor.ts` (`REPORTER_SOURCE`, caps, `normalizeMonitorMessage`),
  `workers/api/src/monitor-inject.ts` (the Tier-2 injection and its guards),
  `workers/api/src/share.ts` `serveDemoAsset` (~:652 onward).

## Scope

In:

- A standalone mode for the ES5 reporter: when there is no parent runner frame, it sends
  contract §9 payloads with `navigator.sendBeacon` to same-origin `/telemetry/lite`
  instead of postMessage. Errors at 100 % up to the existing event ceiling; LCP, INP, CLS
  and TTFB from `PerformanceObserver`, sampled once per page at 10 %; no page path (docs
  pages send no referrer). Document the INP approximation.
- Injection into `/d` and `/embed` HTML documents at the serve seam in `share.ts`, reusing
  `monitor-inject.ts` guards (HTML only, identity encoding, idempotent marker, clone before
  read). Remix-safe per DEV-2580: a self-removing tag, no whitespace around it.
- `workers/o11y/src/lite.ts`, registered with `registerRoute`: validate with the contract
  validator, convert with the shared converter (contract `convert.ts`), run the server
  scrubber, hand the records to `InboxWriter` for the `browser` tenant, and write
  `error.uncaught` / `web_vital` points with `surface` `embed` or `d` and the demo id.
- `serve.share`, `serve.d`, `serve.embed` points in `share.ts` (outcome, demo id, bytes).

Out: the authoring app's own vitals (T06/T07).

## Acceptance criteria

- `pipeline/lite-beacon.test.mjs` parses the injected reporter with `acorn`
  `ecmaVersion: 5` (Node accepts syntax an old runtime rejects), checks the size budget,
  and drives it in a fake DOM: an uncaught error produces one payload within the caps;
  vitals are sent on roughly 10 % of simulated page views, never more than once per page.
- `pipeline/lite-inject.test.mjs`: only `text/html` is rewritten, a second pass is a no-op,
  encoded bodies pass through, and a Remix fixture document still matches its hydration
  markup after injection.
- Locally, opening a fixture `/d/<id>` through the API worker sends a beacon that lands in
  the inbox as `browser`-tenant OTLP records and as Analytics Engine rows; an oversize or malformed
  beacon is dropped with an `o11y.ingest` reason; the stored record's timestamp is the
  beacon's `ts` clamped to the receive time.
- The Tier-2 preview monitor path is unchanged (its existing tests stay green).

## Verify

```bash
cd runner
pnpm --filter @handsontable/demo-runtime build
pnpm test
( cd workers/api && npx wrangler deploy --dry-run )
( cd workers/o11y && npx wrangler deploy --dry-run )
```

## Traps

- An ES2017 trailing comma in hand-written ES5 passed `new Function` in Node 22 and would
  not parse in the target runtime; the `acorn` check is the real gate.
- React 18 `hydrateRoot(document)` in Remix strict-matches `<head>`: an injected script, its
  leading newline, and an injected `<style>` each break hydration alone (DEV-2580).
- `monitor.ts` is shared with the Tier-2 preview relay; standalone mode must not change the
  framed behaviour.

## Outcome

_Filled in when done._
