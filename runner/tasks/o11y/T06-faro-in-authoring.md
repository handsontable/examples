# T06 — Faro in the authoring app and browser-side Sentry trim

| | |
|---|---|
| Status | done |
| Size | L |
| Depends on | T00 |
| Blocks | T07 (merge order on `App.tsx`), T11, T12 |
| ADR | 0041 rev. 3 §C.2 (page-load id, header), §E.1–§E.4; contract §6, §10, §11 |
| Owns | `apps/authoring/src/telemetry/**` (new), `sentry.ts`, `main.tsx`, `userScope.ts`, `reportingGate.ts`, `eventGate.ts`, the reporting/relay regions of `App.tsx` (`reportRuntimeError`, the `hot-runner-monitor` listener, the `/api/beacon` call), every API `fetch` site for the `x-hot-session` header, the `/telemetry` dev proxy in `apps/authoring/vite.config.ts`, `apps/authoring/.env.example`, `pipeline/{sentry-gating,faro-config}.test.mjs`, `e2e/telemetry-faro.spec.ts` |

## Goal

The app reports through one facade backed by Faro; uncaught errors land in both Faro and
Sentry, handled ones only in Faro; nothing identifying or authored leaves the browser;
every API request carries the Faro session id.

## Read first

- ADR-0041 §E in full; contract §3 ("never sent"), §6, §7, §10, §11.
- `apps/authoring/src/sentry.ts` (all of it: gates, `reportError`, `reportDemoEvent`,
  the environment re-homing at ~:176-179), `reportingGate.ts`, `eventGate.ts`,
  `userScope.ts`, `tier1Report.ts`, `tier2Report.ts`, `App.tsx:260-395` and ~:2334-2350.
- `pipeline/sentry-gating.test.mjs` — the gate truth table you extend.

## Scope

In:

- **Faro init** in `src/telemetry/faro.ts`, imported from `main.tsx` right after Sentry:
  session tracking **disabled**; only the errors and web-vitals instrumentations
  (Performance, CSP, console and view off — they send full URLs or console text); no
  `user` meta; the facade mints a page-load id in memory and sets it as `session.id` on
  every item; no tracing package; transport to same-origin `/telemetry/collect`;
  `app.version` = `VITE_SENTRY_RELEASE`; `beforeSend` = contract `scrubTelemetry` then the
  shared noise gates.
- **Gate**: production via `resolveReporting` unchanged, still closed under automation;
  the local path exactly as contract §10 defines it (build-time
  `VITE_TELEMETRY_LOCAL=1` and a localhost host, no `DEV` or webdriver check), with the
  truth table extended in `sentry-gating.test.mjs`.
- **Facade**: the Faro-backed implementation of the contract `Telemetry` interface,
  exported for T07.
- **Reporting migration** per ADR §E.1: `window.onerror`, rejections and
  `Sentry.ErrorBoundary` are "uncaught" and stay in Sentry in both scopes —
  `ErrorBoundary`'s `onError` also calls the facade so render crashes reach the new stack;
  `reportError`, the Tier-1/Tier-2 branches of `reportRuntimeError`, and `reportDemoEvent`
  are diagnostics and go through the facade with contract fingerprints; demo-runtime events become `preview.runtime_error` counts under the
  existing `monitor.ts` caps and **leave Sentry**; delete the environment re-homing.
- **Sentry trim, behind `VITE_SENTRY_SCOPE`** (contract §11): with
  `uncaught`, `defaultIntegrations: false`, `integrations: [globalHandlersIntegration(),
  dedupeIntegration()]` and explicit reports go only to the facade; with `full` (the
  default) today's integrations stay and explicit reports go to both. In both scopes
  `beforeSend` pushes the Sentry event id as a Faro event and sets the page-load id as a
  Sentry tag, and every existing noise gate stays on the Sentry side.
- **Page-load header**: one small `apiHeaders()` helper, used at every API `fetch` site,
  adds `x-hot-session` with the page-load id. This task is the only one that edits fetch sites.
- **Dev proxy**: `/telemetry` → the local o11y worker in `vite.config.ts`, next to the
  existing `/api`, `/d`, `/embed` entries.

Out: the performance and timing metrics (T07); the embed beacon (T08).

## Acceptance criteria

With the dev app, `VITE_TELEMETRY_LOCAL=1`, and T02's o11y worker running locally (or a
capture server when T02 is not merged yet):

- An uncaught error reaches Sentry (transport spy) and Faro; a `reportError` call reaches
  Faro in both scopes and Sentry only with `full`; a demo-runtime keystroke ladder becomes
  one deduplicated count in Faro and, with `uncaught`, nothing in Sentry.
- Nothing is written to `localStorage` or `sessionStorage` by Faro or the facade; no
  payload contains a query string, a user-agent string, an email, console text or a Babel
  code frame (assert on captured payloads); a render crash inside the error boundary
  reaches both Sentry and Faro.
- API requests carry `x-hot-session`; `/d` and `/embed` asset requests do not need it.
- Production build with `.env.local` absent still passes the AGENTS.md leak grep, and
  `pnpm check:compiler-chunk` passes; record the bundle size delta in the Outcome.
- `e2e/telemetry-faro.spec.ts`, gated `E2E_TELEMETRY=1`, runs against a dist built with
  `VITE_TELEMETRY_LOCAL=1`, on its own port, captures `/telemetry/collect` with
  `page.route` (no o11y worker needed) and asserts the above in a real browser; the gate
  tests fail when the local path or the production gate is loosened.

## Verify

```bash
cd runner
pnpm --filter @handsontable/demo-runtime build
pnpm --filter @handsontable/demo-authoring typecheck
pnpm test
VITE_TELEMETRY_LOCAL=1 pnpm --filter @handsontable/demo-authoring build
E2E_TELEMETRY=1 pnpm e2e e2e/telemetry-faro.spec.ts
pnpm check:compiler-chunk
node scripts/check-test-presence.mjs feat/runner-observability
```

## Traps

- `VITE_DEV_USER` in `.env.local` short-circuits `currentUser()`; identity-sensitive tests
  must run with it cleared.
- Do not touch chunking to make Faro lazy: naming a chunk in `manualChunks` once dragged a
  shared helper in and made a 2.3 MB chunk eager.
- Playwright silently reuses another worktree's preview server on 4173; use your own port.
- Match real production message shapes (for example `Failed to fetch (host)`, not
  `Failed to fetch`); a gate anchored on the wrong shape never fires.
- `EditorShell.tsx` is invisible to plain `grep` (the file is detected as data); search it
  explicitly when hunting fetch sites.

## Outcome

### What was built

- `apps/authoring/src/telemetry/` (new): `gate.ts` (import-free — contract §10's
  local gate: `resolveTelemetryEnabled`/`telemetryEnvironment`), `faro.ts` (Faro
  init + the contract `Telemetry` facade, `reportUncaughtError` for the
  render-crash tee), `index.ts` (COMMON.md interface 4: `telemetry`,
  `initTelemetry()`, `apiHeaders()`, re-exports `reportUncaughtError`).
- `apps/authoring/src/sentryScope.ts` (new, import-free): `VITE_SENTRY_SCOPE`
  resolution (`resolveSentryScope`, `reportsDiagnosticToSentry`) — contract §11
  / ADR §E.3.
- `apps/authoring/src/demoEventReport.ts` (new, import-free): the pure decision
  `sentry.ts#reportDemoEvent` delegates to (kind→reason, kind→budget, the
  attrs bag) — same pattern as `tier1Report.ts`/`tier2Report.ts`.
- `sentry.ts`: `SENTRY_SCOPE`/`diagnosticsGoToSentry` added; `Sentry.init`
  gains the `uncaught`-scope `defaultIntegrations:false` +
  `[globalHandlersIntegration(), dedupeIntegration()]` branch and an ADR §E.2
  `beforeSend` tee (Sentry event id → Faro event, page-load id → Sentry tag);
  the `DEMO_SURFACE` environment re-homing block is deleted (task Scope: "delete
  the environment re-homing" — see T06-D4); `reportError` now always calls
  `telemetry.error()` and gates `Sentry.captureException` on
  `diagnosticsGoToSentry`; `reportDemoEvent` is rewritten to call
  `telemetry.metric("preview.runtime_error", …)` exclusively (no Sentry calls
  at all — ADR §E.1) via `demoEventReport()` + the contract `fingerprint()`.
- `App.tsx`: `reportRuntimeError`'s blanket `if (!reportingEnabled) return`
  removed; every branch (tier1 compiler-asset, tier1 compile, tier2
  session-start, tier2 container-boot, tier2 generic) now calls
  `telemetry.error(...)` unconditionally and gates its existing
  `Sentry.captureException` on `diagnosticsGoToSentry`; the `versions-fetch`
  `Sentry.withScope(...).captureMessage(...)` diagnostic (found via the
  call-site inventory below, previously unconditional) is teed the same way;
  every API `fetch` site gets `apiHeaders()` (see inventory); `/d/:id/`'s own
  status-probe fetch is deliberately left untouched (task acceptance
  criteria: "`/d` and `/embed` asset requests do not need it").
- `main.tsx`: `initTelemetry()` called after `seedAnonymousContext()`;
  `Sentry.ErrorBoundary` gains `onError={(error) => reportUncaughtError(error)}`
  (ADR §E.2); a test-only `CrashProbe` component (T06-D3, see below).
- `profile.ts`, `tokens.ts`, `auth.ts`, `MyDemos.tsx`, `Chat.tsx`, `Admin.tsx`,
  `EditInfoDialog.tsx`, `StylePanel.tsx`, `catalog.ts`: every API `fetch` site
  now sends `apiHeaders()` (merged with any existing `Authorization`/
  `Content-Type` headers). `auth.ts`'s broker call (`BROKER`, a different
  origin) is deliberately excluded — see the call-site inventory.
- `vite.config.ts`: `/telemetry` dev proxy added, to `http://localhost:8788`
  (T02's own local `wrangler dev` port, per `tasks/o11y/T02-o11y-ingest.md`'s
  Verify block — T02 is not merged, so this is the best-available guess,
  flagged in T06-D8).
- `apps/authoring/.env.example` (new — none existed before): documents every
  `VITE_*` flag the app reads, including the three T06 adds
  (`VITE_TELEMETRY_LOCAL`, `VITE_SENTRY_SCOPE`) and re-documents the
  pre-existing ones for completeness.
- `pipeline/sentry-gating.test.mjs`: extended with the `SENTRY_SCOPE` truth
  table (5 new tests).
- `pipeline/faro-config.test.mjs` (new, required name): 9 tests pinning
  `telemetry/gate.ts`'s local/production gate decision.
- `pipeline/demo-event-report.test.mjs` (new): 9 tests pinning
  `demoEventReport.ts`, including the real contract `fingerprint()` proving a
  keystroke ladder collapses to one fingerprint.
- `e2e/telemetry-faro.spec.ts` (new): 7 tests, gated `E2E_TELEMETRY=1`, against
  a dist built with `VITE_TELEMETRY_LOCAL=1`, served on its own port (4711,
  spawned/torn down by the spec itself, `mode: "serial"` so one worker owns
  the server). No o11y worker: `/telemetry/collect` captured via `page.route`.

### Call-site inventory (every `Sentry.captureException`/`captureMessage`/
`withScope`/`addBreadcrumb` in `apps/authoring/src`, classified)

| Call site | Classification | What changed |
|---|---|---|
| `sentry.ts` `beforeSend` noise gates (`isUnhandledNoise`, `isOfficeScannerRejection`, `isEdgelessForeignSessionStart`, `isForeignUnhandled`) | uncaught-only filters | Unchanged — these only ever see uncaught events |
| `Sentry.init`'s global handlers (implicit, `window.onerror`/`unhandledrejection`) | uncaught (ADR §E.1) | Unchanged; scoped to `[globalHandlersIntegration(), dedupeIntegration()]` under `uncaught` scope |
| `Sentry.ErrorBoundary`'s own internal capture | uncaught (ADR §E.1 — React caught it, nothing here did) | Unchanged; `onError` now also calls `reportUncaughtError` (Faro half of the tee) |
| `App.tsx` `reportRuntimeError` — tier1 compiler-asset, tier1 compile, tier2 session-start, tier2 container-boot, tier2 generic (5 branches) | handled diagnostic (ADR §E.1: "the Tier-1/Tier-2 branches of `reportRuntimeError`") | Facade call added (unconditional); Sentry call gated on `diagnosticsGoToSentry` |
| `sentry.ts` `reportError` | handled diagnostic | Facade call added (unconditional); Sentry call gated on `diagnosticsGoToSentry` |
| `App.tsx` `versions-fetch` `Sentry.withScope(...).captureMessage("versions fetch unreachable", ...)` | handled diagnostic, "upstream failure reported with tags" — ADR §E.1's own named example | **Found via this inventory, not the original Scope text** — was unconditional before T06 (a real §11 violation under `uncaught`). Facade `telemetry.event("versions_fetch_unreachable", ...)` added (unconditional); Sentry call gated on `diagnosticsGoToSentry` |
| `App.tsx`'s two `Sentry.addBreadcrumb` calls (`versions-fetch recovered on retry`, `versions-fetch unreachable (visitor network)`) and one more (`starter-load unreachable (visitor network)`) | breadcrumbs, not reports — attach to whatever Sentry event fires *next* | Left unmigrated (T06-D-none: breadcrumbs are Sentry-scope-buffer context, not a standalone diagnostic report; `addBreadcrumb` is a core Scope API, not gated by an integration, so it still works unchanged under `uncaught` scope too) |
| `App.tsx` `withDocsFetchDiagnostics`'s `Sentry.withScope` | scope-tag wrapper around an inner `reportError` call | No change needed — the inner `reportError` is already gated; this wrapper only sets scope tags that are discarded if the inner capture is skipped |
| `sentry.ts` `reportDemoEvent` (was `captureException`/`captureMessage`/`addBreadcrumb`) | **leaves Sentry entirely** (ADR §E.1: "demo-runtime preview events") | Rewritten: `telemetry.metric("preview.runtime_error", ...)` only, via `demoEventReport.ts` + contract `fingerprint()`. `tier2Report.ts`'s TS-diagnostic/build-envelope classification is no longer called from here (D5) |

### Deviations (T06-D)

- **T06-D1 — BLOCKING, outside this task's Owns rows.** `scrub.ts#allowlistAttributes`
  (owned by T00, `packages/runtime/src/telemetry/attrs.ts`'s
  `ALLOWED_ATTRIBUTE_KEYS`) keeps only the dotted OTLP resource-attribute keys
  and the four structured-metadata keys — it has no entry for a bare `handled`
  key, so `telemetry.error()`'s `context.handled = "true"` marker (which
  contract §6's ingest table needs to split `error.handled` from
  `error.uncaught`) is stripped by the browser-side `beforeSend` scrub before
  the request ever leaves the browser. **Measured, not assumed**: a live
  capture against a real `vite preview` build of a `reportError("versions-fetch")`
  call showed
  ```json
  { "type": "Error", "value": "versions 500", "context": {},
    "fingerprint": "versions-fetch:4f1e6589c02ad6e4" }
  ```
  — `context: {}` where `{ handled: "true", context: "versions-fetch" }` was
  sent. The same allowlist also drops every non-dotted `HotAttrs` field
  (`reason`, `fingerprint`, `route_class`, `model`, `provider`, `device`,
  `bucket`, `kind`, `ref`, `area`) from every `metric()`/`event()` call,
  including `preview.runtime_error`'s own `reason` — T07/T12 will hit the same
  wall. Fixed the **in-scope half**: `telemetry/faro.ts#attrsToContext` now
  maps the six `HotAttrs` fields that DO have a dotted equivalent
  (`surface`→`hot.surface`, `tier`→`hot.tier`, `framework`→`hot.framework`,
  `ht_major`→`hot.ht_major`, `outcome`→`hot.outcome`, `demo_id`→`hot.demo_id`)
  before sending; every other field (including `handled` and `reason`) is sent
  bare/unmapped, forward-compatible with an ingest-side allowlist fix that
  needs no browser-side change. **Not fixed**: extending
  `ALLOWED_ATTRIBUTE_KEYS`/the contract doc's §3 table is a policy change
  under ADR §E.4 ("drop unknown attributes") in a file this task does not own
  and that T02 codes against — left for the controller. `e2e/telemetry-faro.spec.ts`'s
  last test is deliberately KEPT RED to encode this (see below), per
  docs/TESTING.md: the expectation is correct, the code this task does not own
  is wrong.
- **T06-D2 — the demo-runtime-ladder "one deduplicated count" claim is proven
  at the unit level only.** `monitorDemos` (`sentry.ts`, DEV-2540, pre-existing)
  is `reportingEnabled && VITE_MONITOR_DEMOS==="1"`, and `reportingEnabled`
  requires the production host + `navigator.webdriver !== true` — it can never
  be `true` against a local `vite preview` under Playwright, whatever
  `VITE_TELEMETRY_LOCAL` is set to. Widening `monitorDemos`'s gate is a
  DEV-2540 decision outside this task's scope (it also controls whether
  preview-monitoring JS is injected into every visitor's demo at all, not just
  reporting). The claim is proven instead by `pipeline/demo-event-report.test.mjs`'s
  `"a keystroke ladder collapses to one fingerprint (the actual contract
  dedupe)"` test, which runs the REAL contract `fingerprint()` (T00's, not a
  re-implementation) over a 4-rung ladder and asserts one shared fingerprint
  plus a genuinely-different failure NOT collapsing into it.
- **T06-D3 — `CrashProbe` test seam in `main.tsx`.** No existing mechanism in
  the app can trigger a deterministic React render crash from outside; adding
  one was necessary to test the acceptance criterion "a render crash inside
  the error boundary reaches both Sentry and Faro" in a real browser. Gated on
  three ANDed conditions (`VITE_TELEMETRY_LOCAL==="1"`, localhost/127.0.0.1,
  an exact query param) — structurally closed off a production build. Measured
  the closure, not assumed: `grep -c "__test_crash_boundary\|render-crash
  probe" dist/assets/*.js` on a plain `.env.local`-absent build returns 0 for
  every file — Rollup's dead-code elimination removes the whole branch (and
  its string literals) once `import.meta.env.VITE_TELEMETRY_LOCAL` is
  statically `undefined`, stronger than the runtime gate alone.
- **T06-D4 — deleting the Sentry environment re-homing changes where Tier-1
  compile-branch events land.** The task Scope explicitly says "delete the
  environment re-homing" for `reportDemoEvent`. `tier1Report.ts`'s
  `sandpack-compile` branch (reached from `App.tsx`'s `reportRuntimeError`,
  still Sentry-eligible under `full` scope) also tagged `surface:
  "demo-runtime"` and, before this change, hit the SAME re-homing branch in
  `beforeSend` and landed in the `demo-runtime` Sentry environment. With the
  branch deleted, those events now land in `authoring-production` (or
  `authoring-local`) like any other event, still carrying the
  `surface: "demo-runtime"` *tag* for filtering. If an existing Sentry saved
  search/alert keys on the `demo-runtime` *environment* specifically, it needs
  updating to filter on the tag instead — flagged for the controller/T11's
  launch gate, not fixed here (no such search is committed to this repo to
  update).
- **T06-D5 — `tier2Report.ts` and the demo-console-warning breadcrumb path are
  no longer called from `reportDemoEvent`.** Both are now dead from
  `sentry.ts`'s perspective (their own files, `tier2-report.test.mjs`, and
  `tier1Report.ts` are untouched and still pass their own tests — nothing here
  deletes them, just stops importing `tier2StderrReport`).
- **T06-D6 — `sentryScope.ts`, `demoEventReport.ts` and their two pipeline
  tests are new files not literally named in this task's Owns row.** Same
  precedent as T00-D9 (creating `box.ts`/`writer.ts` as scaffolding for files
  no other task owned yet): these are decision-extraction modules in the same
  import-free style as the pre-existing `tier1Report.ts`/`tier2Report.ts`/
  `reportingGate.ts`, required to make the SENTRY_SCOPE truth table and the
  demo-event fingerprint-collapsing claim unit-testable at all (`sentry.ts`
  itself cannot be `node --test`-imported).
- **T06-D7 — environment repair, not a code change: `@sentry/{react,browser,core}`'s
  `build/`/`dist/` directories were missing from this worktree's
  `node_modules/.pnpm` after `pnpm install` (and `pnpm install --force`) —
  each package had only `LICENSE`/`README.md`/`package.json`, no compiled
  output, despite the pnpm content-addressable store holding the correct
  153-file index and the actual blobs (verified: the store's own SHA-512
  content file for `@sentry/react`'s `build/cjs/index.js` exists on disk).
  The main checkout's `node_modules` (same lockfile, installed separately) had
  the full directories. Worked around by copying `build/`/`dist/` from the
  main checkout's `node_modules/.pnpm/@sentry+{react,browser,core}@.../node_modules/@sentry/{react,browser,core}`
  into this worktree's equivalent paths — not a source change, and the fix is
  reproducible from the same lockfile if `pnpm install` in a clean environment
  doesn't hit the same issue (untested whether the controller's environment
  reproduces this).
- **T06-D8 — `E2E_TELEMETRY` has no workflow home yet.** docs/TESTING.md's
  rule ("every gate must have a workflow home... named in the workflow that
  runs it, in the same PR") is not satisfiable from an isolated task worktree
  — `.github/workflows/*.yml` is not in this task's Owns rows and editing CI
  wiring for the whole o11y board is a controller-level decision (likely done
  once, after several tasks land). Flagged, not fixed. The `/telemetry` dev
  proxy's target port (8788) is also a guess pinned to T02's own Verify block
  since T02 is not merged into this base — if T02 lands on a different local
  port, this line needs a one-line update.

### Revert evidence (every new/changed assertion seen failing for the right
reason, then restored)

**Pipeline (`node --test`, before/after diff shown, all restored):**
- `demoEventReport.ts`: `"console-warn": "console"` → `"uncaught"` — 1 of 9
  `demo-event-report.test.mjs` tests failed (`console-error and console-warn
  both map to reason 'console'`).
- `telemetry/gate.ts`: `if (productionReportingEnabled) return true;` →
  `if (false) return true;` — 1 of 9 `faro-config.test.mjs` tests failed
  (`production leg: reuses resolveReporting's decision verbatim`).
- `sentry-gating.test.mjs`'s 5 new tests: each pins a literal
  `resolveSentryScope`/`reportsDiagnosticToSentry` branch directly (e.g. "only
  the literal 'uncaught' opens it") — a wrong implementation fails the exact
  assertion it names; not separately re-verified with a live revert given the
  functions are two lines each and the assertions are direct equality checks
  on every input in their domain.

**E2E (`e2e/telemetry-faro.spec.ts`, each reverted + `VITE_TELEMETRY_LOCAL=1`
rebuilt + the one affected test re-run + restored + final full-suite re-run
green):**

| Test | Revert | Result |
|---|---|---|
| Uncaught reaches Faro | `initTelemetry()` → no-op | red: 0 exceptions captured (timeout) |
| Render crash reaches Faro | `onError={() => {}}` | red: 0 exceptions captured (timeout) |
| `reportError` reaches Faro | `telemetry.error(error, context);` commented out | red: 0 exceptions captured (timeout) |
| No storage writes | `sessionTracking:{enabled:false}` → `{enabled:true,persistent:true}` alone | **false pass** — `sessionTracking` config alone doesn't write storage; `PersistentSessionsManager` needs `SessionInstrumentation` in the instrumentations array, which this facade never includes. Re-reverted with `new SessionInstrumentation()` added — red: `found "com.grafana.faro.session"`. Also added a 1.5s wait to the real test (the write is debounced ~1s) so the passing run isn't racing a write that hasn't landed yet |
| No PII in payloads | `beforeSend` commented out of the Faro config | red: real Chrome UA string found at `body[0].meta.browser.userAgent` |
| `x-hot-session` header | `apiHeaders()` removed from `catalog.ts#fetchVersions` | red: "GET /api/versions carried no x-hot-session header" |

### Bundle size delta

Measured on the main entry chunk (the one Faro's init code lives in), plain
production build (`.env.local` absent), base = `git stash` to the T00 merge
commit, same build command:

| | Base (pre-T06) | T06 | Delta |
|---|---|---|---|
| Raw | 1,419.84 kB | 1,552.16 kB | **+132.32 kB** |
| Gzip | 450.74 kB | 494.77 kB | **+44.03 kB** |

The `@babel/standalone` lazy chunk is byte-identical (2,345.28 kB / 585.69 kB
gzip) both before and after, as expected — nothing here touches it.
`check:compiler-chunk` and the AGENTS.md leak grep both pass on the final
build; the `CrashProbe` test seam is confirmed absent from that build's JS
(dead-code-eliminated, see T06-D3).

### Verify block results

```
cd runner
pnpm --filter @handsontable/demo-runtime build            # exit 0
pnpm --filter @handsontable/demo-authoring typecheck       # exit 0
pnpm test                                                  # 1271 tests, 1268 pass, 1 fail
                                                             #   (pipeline/theme-presets-version.test.mjs —
                                                             #   documented pre-existing baseline failure,
                                                             #   COMMON.md; unrelated to o11y)
VITE_TELEMETRY_LOCAL=1 pnpm --filter @handsontable/demo-authoring build   # exit 0
E2E_TELEMETRY=1 pnpm e2e e2e/telemetry-faro.spec.ts        # 7 tests, 6 pass, 1 fail
                                                             #   (KNOWN RED — T06-D1, kept intentionally,
                                                             #   see above; last in file so mode:"serial"
                                                             #   does not skip the other 6)
pnpm check:compiler-chunk                                   # exit 0
node scripts/check-test-presence.mjs feat/runner-observability   # run after commit — see commit
```

All `rtk`-wrapped commands were judged by their printed output/exit reasoning,
not the `rtk` wrapper's own trailing summary (COMMON.md: "rtk lies" — the e2e
run above is the concrete case: `rtk`'s wrapper printed `exit=0` after
Playwright itself printed `1 failed` / `ELIFECYCLE Command failed with exit
code 1`).
