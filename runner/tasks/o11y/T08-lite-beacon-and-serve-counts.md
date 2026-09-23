# T08 — Lite beacon on embeds and `/d`, serve counts

| | |
|---|---|
| Status | done |
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

Implemented on `feat/o11y/T08-lite-beacon`, worktree `/Users/amedrygal/Code/examples-wt/T08`.

### What shipped

- **Standalone reporter** (`packages/runtime/src/monitor.ts`): a wholly separate ES5
  reporter from `REPORTER_SOURCE` — never composed with it, `REPORTER_SOURCE` is
  byte-unchanged (`git diff` on that constant is empty). `/d`/`/embed` never receive the
  framed reporter and vice versa, so "no parent runner frame" needed no runtime
  detection — it's true by construction (two injection seams, never both), **not**
  because `/d`/`/embed` documents are never framed at all (fix round I3, controller
  ruling): the authoring app's FullMode view frames `/d/:id/` cross-origin to show a
  saved demo's build full-window, and that is a real, accepted view of the public build
  — the lite reporter still runs there, standalone-transported exactly as on a direct
  visit, and nothing about that framing needs this reporter to behave differently.
  Exports:
  `injectLiteReporterIntoHtml`, `LiteReporterConfig`, `LITE_ENDPOINT`,
  `LITE_REPORTER_MARKER`, `LITE_VITALS_SAMPLE_RATE`, `LITE_CLIENT_MESSAGE_MAX/STACK_MAX`,
  `LITE_REPORTER_MAX_BYTES`. Sends `error`/`unhandledrejection` at 100% up to
  `MONITOR_EVENT_CEILING` (20); no console/network relay (§9 has no such kind). Vitals
  sampled once per page (`Math.random() < 0.1`), reported together at
  `visibilitychange`(hidden)/`pagehide`, never eagerly.
- **INP approximation** (documented in `reporterSource`'s doc comment, restated here per
  the task's own ask): the longest single `event`-timing entry's `duration` observed
  during the page's life, filtered to `interactionId > 0` at the `web-vitals` library's
  own 40ms `durationThreshold` default. **Not** the spec metric: real INP groups one
  interaction's several events into one duration and reports the 98th percentile across
  every interaction in the page's life; this reports the single longest event seen,
  unweighted and ungrouped. Trends the same direction as real INP but is not numerically
  comparable to a real-INP value from another source. CLS is likewise an approximation:
  summed for the page's lifetime rather than session-windowed (the real algorithm groups
  shifts into gap/limit-bounded sessions and reports the worst window).
- **Injection** at the `share.ts` serve seam: `serveDemoAsset` now takes `ctx` and, for
  the `.html` branch, calls `monitor-inject.ts#injectLiteHtml` (HTML-only,
  identity-encoding-only guard) after the scheme/root-path rewrites settle, then emits
  `serve.d`/`serve.embed`. DEV-2580 self-removing tag reused verbatim
  (`injectedScriptTag`/`insertInjectedTag`, unchanged).
- **`workers/o11y/src/lite.ts`**: `POST /telemetry/lite`, registered via
  `registerRoute` (self-registering side-effect import from `index.ts`, so T03/T04's
  concurrent edits to that file never conflict with this route's own logic). Gate →
  capped read → `isValidLitePayload` → `beaconToRecord` → `scrubTelemetry` → the T02-D
  extra `scrubBodyText` pass → `withResourceAttrDefaults` → `error.uncaught`/`web_vital`
  AE points → `hashRecord` → `InboxWriter.ingest("browser", …)` → one `o11y.ingest`
  point via `respondIngested`. `service.name = "demos-embed"` (§3's fourth service name,
  previously unused — confirms this is exactly what it names),
  `service.version = "unknown"` (no natural build identity for a bare client beacon).
- **`serve.share`/`serve.d`/`serve.embed`**: `serveOutcome()` (share.ts, exported) maps
  the closed `2xx`/`304`/`4xx`/`5xx` set, refusing (returning `null`, point skipped) any
  other status rather than mis-bucketing — `serveDemoAsset` never itself answers a 3xx
  (the `/d/:id` → `/d/:id/` 308 is handled by its caller before this function runs).
  Bytes: `obj.size` for a streamed non-HTML asset, the final post-injection HTML's
  `TextEncoder` length otherwise — never a `Response`'s `content-length` header, which is
  unset at this point either way.

### T08-D deltas

- **T08-D1 (fingerprint input excludes the stack).** `convert.ts#beaconBody`'s stored
  `body` includes the stack for a human reading Loki; the *fingerprint* input is
  `"<n>: <m>"` only (`liteErrorFingerprintMessage`, `lite.ts`). Folding the stack in
  would mint a "new" fingerprint on every rebuild that shifts a chunk hash or line
  number in the first frame — the DEV-2853 ladder problem restated, and worse here
  because `d`/`embed` surfaces (unlike `demo-runtime`) feed the new-fingerprint alert, so
  a false "new" pages someone. Covered by a revert-verified test (below).
- **T08-D2 (script size budget: measured, not the Goal's literal figure — flagged for
  the controller).** The Goal reads "a script under 2 KB." After cutting every inline
  comment from the shipped string (rationale moved to `reporterSource`'s own doc
  comment, which costs no bytes) and collapsing the three separate
  `PerformanceObserver` registrations behind one `ob()` helper, the `<script>` content
  measures ~2.9 KB for a realistic config (`LITE_REPORTER_MAX_BYTES = 3072`, pinned by
  `pipeline/lite-beacon.test.mjs`) — up slightly from the first pass's ~2.8 KB after fix
  round I2 added byte-safe truncation (`bl()`/`bt()`), still comfortably inside the 3 KB
  budget. Getting under 2 KB from here means either a real correctness cut — considered
  and rejected: reading `layout-shift`/`event`/`largest-contentful-paint` once via
  `performance.getEntriesByType` instead of a live, `buffered: true` `PerformanceObserver`
  is the standard *incorrect* shortcut for these entry types, unverifiable without a real
  browser — or a minifier in the injection path, which this feature has none of. Concern
  for the controller: accept ~2.9 KB, or prescribe which correctness property to drop.
- **T08-D3 (`serve.share`'s call site is a judgement call).** `/share/:id` is the
  authoring SPA's own client route (`App.tsx`), served by a different deployable
  entirely — there is no API-worker HTTP response for the page shell itself. Landed on
  `GET /api/demos/:id` (the public metadata endpoint) as the closest analogue: it is the
  one server-owned request that surface fires, alongside `GET /api/demos/:id/source`
  (not counted). Known undercounts, both flagged as concerns: (a) `/source` is not
  counted even though it fires on the same mount; (b) this route is edge-cached
  (`cacheableJson`, 60s `stale-while-revalidate`), so a repeat view within that window
  never reaches this point at all.
- **T08-D4 (local end-to-end proof is a pipeline integration test, not a live
  `wrangler dev` chain).** T06's own precedent (`e2e/telemetry-faro.spec.ts`) already
  established that a Playwright spec mocks `/telemetry/collect` with `page.route`
  rather than requiring a real o11y worker locally — there is no zone-route emulation
  for `/telemetry/collect`/`/telemetry/lite` outside production (ADR §A's routes are
  `--routes` flags on the real zone, not `wrangler.jsonc`). `pipeline/lite-beacon.test.mjs`
  proves the full chain deterministically instead: the reporter's own captured
  `sendBeacon` output is validated against `isValidLitePayload`, and the route half is
  driven through the **real** router (`workers/o11y/src/index.ts`'s default export,
  the `o11y-routes.test.mjs` pattern) with T02's own in-memory `InboxWriter`/R2/AE
  harness (`pipeline/fixtures/o11y-harness.mjs`) — accepted/oversize/malformed/ts-clamp/
  AE-point assertions all go through the actual `handleLite`. A live cross-worker local
  run (`wrangler dev` + the `O11Y` service binding) is T11's task file's own scope
  ("local e2e and launch gate"), not duplicated here.
- **T08-D5 (rate limiter, read-only note).** `RATE_LIMITER` is `100 requests/60s`
  (`workers/o11y/wrangler.jsonc`, confirmed live in the `wrangler deploy --dry-run`
  output below), shared by `collect` and `lite` through `checkBrowserGates`, keyed by
  `cf-connecting-ip`. A docs page with several embeds can send up to 4 vitals plus up to
  `MONITOR_EVENT_CEILING` errors per embed, all from one visitor IP. Not touched (T02
  owns `gates/rate-limit.ts`/`gates/limits.ts`) — flagged for the controller to weigh in
  on whether the shared limit needs its own headroom for embed-heavy docs pages.
- **T08-D6 (`htMajorFromVersion`).** `"latest"` (the pre-DEV-2565 sentinel, never
  actually stored today) and any unparseable ref map to `"none"`; a next-channel build —
  both the nightly `0.0.0-next-<hash>-<date>` shape (major `0` under plain semver) and
  the dotted `19.0.0-next.1` shape — maps to `"next"`, not `"none"` or `"0"`.

### Fix round (single round, per controller review)

The controller review found the ES5 safety, injection guards, ingest gating/scrub order,
clamp, tenant routing and sampling solid, and raised five findings, all addressed here:

- **I1 — `serve.d`/`serve.embed` fired per asset, not per document.** `record()` was
  called on every branch of `serveDemoAsset`, including the non-HTML asset return, so a
  document plus its JS/CSS/image files under `/d/:id/*` wrote one point *per file*, not
  one per view. Fixed: a new `isDocRequest = subpath === ""` gate (the same condition
  `index.ts`'s adjacent `noteView` already uses) on every early-return branch, an
  unconditional `record` kept only where `hitPath.endsWith(".html")` resolves (so a
  client-routed SPA's deep-link fallback to `index.html` still counts as a document view
  even though `subpath` was not empty), and the non-HTML asset branch's `record` call
  removed outright. New test: `pipeline/lite-inject.test.mjs`, "serving a document plus
  three assets writes exactly one serve.d point" — serves 1 document + 3 assets through
  the real `serveDemoAsset`, asserts exactly 1 `serve.d` point.
- **I2 — client truncation used UTF-16 `.length`, not UTF-8 bytes.** `tc()` truncated
  `name`/`message`/`stack` by JS string length while the server (`LITE_PAYLOAD_MAX_BYTES`,
  `isValidLitePayload`) caps at 2048 UTF-8 *bytes* — a non-ASCII error message truncated
  to the old char budget could still serialize well over the byte cap and be silently
  dropped at ingest, reported as "sent" client-side but never stored. Fixed: `bl()` (byte
  length, the classic `unescape(encodeURIComponent(s)).length` trick, ES5-safe) and
  `bt()` (byte-trim: shrink one UTF-16 code unit at a time until `bl(s) <= max`, which
  never splits a surrogate pair awkwardly since a self-heal happens within one extra
  iteration if it ever does) replace `tc()`; `bc()` (build+send) also does a final
  `bl(JSON.stringify(payload)) > PMAX` check before ever calling `sendBeacon`, catching
  JSON's own escaping inflation (`"`/`\` each cost 2 output characters) that per-field
  byte trimming alone cannot see. New tests: "a non-ASCII error message/stack is
  byte-trimmed, never silently dropped" (Chinese/Cyrillic/emoji, exercising 2/3/4-byte
  UTF-8 sequences) and "worst-case JSON-escaping content … never sent oversize" (a
  message of nothing but `"`/`\`). Script size after the fix: ~2.9 KB, still under the
  3 KB test cap (`LITE_REPORTER_MAX_BYTES = 3072`, unchanged).
- **I3 — a false "never framed" claim (controller ruling).** `monitor.ts`'s doc comment
  claimed `/d`/`/embed` are "never framed by our own runner"; the authoring app's
  FullMode view does frame `/d/:id/` cross-origin, and the controller ruled that
  behaviour acceptable — a FullMode view is a real view of the public build. Fixed:
  corrected the comment (`monitor.ts`, the `// ---- T08: the lite beacon` section) to
  state FullMode's framing explicitly and explain why it changes nothing (this reporter
  never runs anywhere `REPORTER_SOURCE`'s transport would apply, regardless of who
  frames the document), and corrected the "What shipped" bullet above to match.
- **(a) — block-level `function` declaration.** `function ob(t,cb,dt){…}` sat inside
  `if(smp){…}`; block-level function declarations are not ES5 statement grammar (acorn's
  Annex-B leniency accepts them anyway, hiding the gap the `ecmaVersion:5` check exists
  to catch). Changed to `var ob=function(t,cb,dt){…};`.
- **(b) — an unresolved demo id reached `demo_id`.** The `!row` (404) branch wrote the
  URL-supplied `id` straight into the AE point's `demo_id`, even though nothing confirms
  that id names a real demo — the same crawler-cardinality risk `index.ts`'s `noteView`
  comment already gives for not counting an unresolved id. Fixed: `record` takes an
  optional `demoId` override, and the `!row` branch passes `""`. New test: "an unresolved
  demo id still counts a document 404, with an empty demo_id" (plus a sibling asserting a
  non-document unresolved-id request writes no point at all, since `isDocRequest` gates
  it first).

**Revert evidence for every new/changed test in this round** (each seen failing with the
fix reverted, restored before moving on):

- I1: removing the "no `record` here on purpose" branch (i.e. restoring
  `record(200, obj.size)` on the non-HTML return) → "serving a document plus three
  assets writes exactly one serve.d point" failed (2 points instead of 1). Restored;
  15/15 in `lite-inject.test.mjs`.
- (b): reverting the `!row` branch's `record(404, 0, "")` back to `record(404, 0)` →
  "an unresolved demo id still counts a document 404, with an empty demo_id" failed
  (`demo_id` was `"no-such-demo"`, not `""`). Restored; 15/15.
- I2: reverting `bt()` to a char-count truncation (`s.length<=n?s:s.slice(0,n)`, the old
  `tc()` behaviour) → "a non-ASCII error message/stack is byte-trimmed…" failed (the
  final `bl(j)>PMAX` safety net caught the oversized payload and refused to send it at
  all, so the "must still be sent" assertion failed — the two-layer defence working as
  designed: a bad truncation either overshoots the byte cap directly or gets silently
  dropped by the backstop, and this test catches both failure shapes). Restored; 29/29
  in `lite-beacon.test.mjs`.

### Verification

```
node -v  # v22.22.3
pnpm install                                                          # exit=0
pnpm --filter @handsontable/demo-runtime build                        # exit=0
pnpm -r run typecheck                                                 # exit=0 (all 5 packages)
pnpm test                                                              # 1528 tests, 1525 pass, 1 fail
                                                                        # (baseline: theme-presets-version.test.mjs,
                                                                        #  '18.1.0' !== '18.1.1', unrelated to o11y —
                                                                        #  controller-verified pre-existing failure)
( cd workers/api && npx wrangler deploy --dry-run )                   # exit=0
( cd workers/o11y && npx wrangler deploy --dry-run )                  # exit=0
node scripts/check-test-presence.mjs feat/runner-observability        # pass (source files changed, matching test change)
```

`pipeline/lite-beacon.test.mjs`: 29 tests (27 + 2 from the fix round) — acorn
`ecmaVersion:5` parse, the script size budget, the marker/idempotency, executed-reporter
behaviour (error/rejection relay, byte-safe truncation, non-ASCII and worst-case-escaping
payloads, the event ceiling, the resource-load-failure filter, device classification,
vitals sampling at the contract rate with "never twice per page," LCP-last-candidate,
CLS summation, the INP filter, TTFB, payload-validator conformance), and the real
`POST /telemetry/lite` route driven through the actual router (accepted →
browser-tenant storage, oversize → `reason: "size"`, malformed → dropped with a point,
not-JSON → clean 400, `ts` clamping, `web_vital`/`error.uncaught` AE point shape, and
the stack-excluded fingerprint).

`pipeline/lite-inject.test.mjs`: 15 tests (12 + 3 from the fix round) —
`htMajorFromVersion` (majors, next-channel, out-of-range/empty/sentinel),
`injectLiteHtml`'s guards (HTML-only, identity-encoding-only, idempotent, the framed
reporter's own marker left alone), the DEV-2580 self-removing-tag/no-whitespace property,
a Remix-shaped fixture whose head/body survive injection intact, `serveOutcome`'s
closed-set mapping (including refusing to bucket a stray 3xx), and the I1/(b) `record`
gating (exactly one point for a document plus three assets; an empty `demo_id` on an
unresolved id; no point at all for an unresolved id's non-document request).

**Revert evidence from the first pass** (each new test was seen failing with the change
reverted, not just passing once):

- Reverted the LCP-last-candidate fix (`if (es.length) lc = es[es.length-1]` →
  `if (es.length && !lc) lc = es[0]`) and the INP `interactionId` filter (dropped the
  `> 0` check) together: `pipeline/lite-beacon.test.mjs` went from 26/26 to 23/26,
  failing exactly the three tests those properties cover ("LCP reports the last
  candidate…", "INP approximation: the longest real-interaction…", "no INP is sent when
  nothing crosses the filter"). Restored; back to 26/26 (27/27 after the fingerprint
  test below was added).
- Reverted the fingerprint fix (`fingerprint(body.s, liteErrorFingerprintMessage(body))`
  → `fingerprint(body.s, scrubbed.body)`, i.e. hashing the stack-bearing body): the new
  "fingerprint ignores the stack" test failed as expected (two payloads with identical
  `n`/`m` but different stack chunk hashes produced different fingerprints). Restored;
  27/27.
- `pipeline/lite-inject.test.mjs`'s two `injectLiteHtml`-signature regressions
  (introduced and immediately fixed while wiring the `contentEncoding` guard) were
  caught live by the full `pnpm test` run (1520/1523 → the expected count), confirming
  the suite is wired into CI's real signature, not a stale copy.

### Concerns for the controller

1. The injected script's own size (~2.9 KB, `LITE_REPORTER_MAX_BYTES = 3072`) exceeds
   the Goal's literal "under 2 KB" — see T08-D2. The 2 KB *payload* cap (contract §9,
   the number the acceptance criteria actually gate on) is met and tested, including the
   fix round's non-ASCII and worst-case-escaping cases.
2. `serve.share`'s call site (`GET /api/demos/:id`) is a judgement call with two known
   undercounts — see T08-D3.
3. `RATE_LIMITER` (100 req/60s, shared with `collect`) may be tight for an embed-heavy
   docs page — see T08-D5, not touched.
4. No live cross-worker local run (`wrangler dev` for both workers with the `O11Y`
   service binding wired) was exercised — see T08-D4; the deterministic pipeline
   integration test is the evidence offered instead, consistent with T06's own
   precedent and T11's separate scope.
