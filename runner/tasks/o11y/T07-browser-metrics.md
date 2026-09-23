# T07 — Browser metrics catalogue

| | |
|---|---|
| Status | done |
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

**EDITED IN PHASE 2**: the two notes below, in the Phase 1 section, are
superseded by the controller's phase-2 note and no longer describe the
shipped code — kept for the historical record of the Phase 1 decision, not as
current fact. The hooks moved onto `DemoRuntime` itself as optional members in
Phase 2 (see the Phase 2 section) — `types.ts` IS touched, and
`wireSandpackMetrics`/`wireContainerMetrics` no longer exist (merged into one
`wireRuntimeMetrics`).

### Phase 1

**What was built**

- Timing hooks added directly to the two runtime engines, in the same style as
  the existing `onProgress`/`onStderr` extension points — engine-specific, not
  on the shared `DemoRuntime` interface (`types.ts` is untouched) — **superseded
  in Phase 2, see above**:
  - `packages/runtime/src/sandpack.ts` (`SandpackRuntime`): `onCompileTiming`,
    `onCompileError`, `onBundlerUnreachable`. A single `compileDispatchedAt`
    clock, set right before `loadSandpackClient` (the initial compile, inside
    `mount()`) and right before `client.updateSandbox` (`pushUpdate`, every
    edit/`reload()`), resolved on the next terminal `onMessage` (`done` → `ok`;
    `show-error` with no stack frames — a real `SandpackCompileError`, never a
    `SandpackEvaluationError` — → `error` + `onCompileError`). Never starts for
    the `sameFiles` no-op skip (nothing is dispatched) and never resolves twice.
  - `packages/runtime/src/container.ts` (`ContainerRuntime`): `onSessionStart`,
    `onHmr`. `onSessionStart` reuses the create-POST's own `elapsedMs` clock
    (`SessionStartDiagnostics`), emitted once per `mount()` on both the success
    path and inside the `catch` — **before** `this.dispose()` clears the
    listener set — with a new `classifySessionStartOutcome` that mirrors
    `sessionStartMessage`'s own precedence (the DEMOS-9 interception 504 before
    the generic timeout tier) onto `session.start`'s outcome set. A raw network
    error (`fetch()` itself throwing, no response) is handled too. `onHmr` is a
    non-invasive addition to `onFrameLoad`: a post-ready frame `load` that
    followed a real edit flush (`flush()` stamps `lastEditFlushDispatchedAt`
    only once `didReady` is true) and is not our own `reload()`
    (`reloadInFlight`) reports the flush-to-load duration.
- `apps/authoring/src/telemetry/metrics.ts` (new): every emission function takes
  an **injected** `Telemetry` — no import of `apps/authoring/src/telemetry/index.ts`
  (T06's file, not created here). Implements `trackPreviewReady` (§5
  `preview.ready_ms`), `wireSandpackMetrics` (`sandpack.compile_ms`/`compile_error`/
  `bundler_unreachable`), `wireContainerMetrics` (`session.start_ms`/
  `hmr.roundtrip_ms`), `emitVersionSwitch`, `emitBucketResolve`, `startClock`
  (a small stopwatch helper), and `htMajorOf` (version ref → the closed
  `hot.ht_major` set).
- `pipeline/browser-metrics.test.mjs` (new, 21 cases): fake `DemoRuntime`/
  `SandpackRuntime`/`ContainerRuntime` stand-ins + `recordingTelemetry()`, with
  every recorded call additionally replayed through the real `toAePoint` (the
  producer-contract check `recordingTelemetry` itself does not perform).
- Extended `pipeline/sandpack-reload.test.mjs` (+4 cases) and
  `pipeline/session-start-failure.test.mjs` (+10 cases) to drive the new hooks
  against the **real** runtimes — the fake-runtime suite above cannot catch a
  hook wired wrong inside `sandpack.ts`/`container.ts` itself.

**`trackPreviewReady` design note.** It does not rely on `onReady`/`onError`
alone: both engines can reject `mount()` without ever calling `onError`
(`ContainerRuntime.mount`'s catch calls `dispose()`, clearing `errorCbs`, before
rethrowing; `SandpackRuntime.mount`'s `buildSetup`/`loadSandpackClient`
rejections — DEV-2130 "Setup failed" — go straight to the caller's own
`.catch()`). `PreviewReadyTracker.observe(mountPromise)` takes the SAME promise
the Phase-2 caller already awaits from `runtime.mount(...)` and listens for its
rejection too. Latches on the first of ready/error/timeout/`abandon()`; every
later signal — including a second `onReady`, which `SandpackRuntime` fires on
every clean recompile, not just the first — is a no-op.

**Deviations (T07-D)**

- **T07-D1 — `htMajorOf` maps a pkg.pr.new build ref to `"next"`.** `HT_MAJORS`
  (the closed set `toAePoint` enforces) has no slot for a build id; both a
  pkg.pr.new build and an actual `next` prerelease are "not a stable release"
  for metrics purposes, and inventing a value outside the closed set would
  throw inside `toAePoint` the first time anyone opened a demo pinned to a PR
  build.
- **T07-D2 — `session.start_ms`'s `reason` (cold/warm) is never set.** No
  client-observable cold/warm signal exists anywhere in the codebase today —
  `sessionDiagnostics.ts` (the "existing session diagnostics" the task Scope
  names) only classifies elapsed time and response origin, the create response
  (`{ previewUrl, port }`) carries nothing about pool state, and each mount
  mints a fresh session id. `toAePoint` accepts the metric with `reason`
  omitted (every `HotAttrs` field is optional; the closed-set check only fires
  when a value IS supplied — confirmed by `toAePoint`, not assumed), so this is
  a valid point, just without that breakdown. A latency-threshold guess was
  considered and rejected: it would put a fabricated split on a dashboard as if
  it were measured. **Follow-up for T05/the API worker**: add a `cold`/`warm`
  field to the `POST /api/session` create response — the server already knows
  this (the pool it drew from is server state).
- **T07-D3 — no `sandpack.bundler_unreachable` signal was found inside
  `@codesandbox/sandpack-client` itself.** Searched the installed package
  (`node_modules/.pnpm/@codesandbox+sandpack-client@2.19.8`) for a timeout or
  "host unreachable" mechanism around `loadSandpackClient`'s connection —found
  none (no `setTimeout`/`reject(` pattern around the connect path in the
  bundled `dist/*.js`; the shipped `.d.ts` even references a
  `./clients/runtime/types` module that does not exist in the published
  package, which is why `sandpack.ts` already derives its option/setup types
  structurally rather than importing the package's own type names — same
  unreliability). What `onBundlerUnreachable` actually reports instead: the
  `mount()`-time `loadSandpackClient(...)` call itself throwing or rejecting —
  distinct from a `SandpackCompileError`/`SandpackEvaluationError`, both of
  which only arrive over `onMessage` once a client has already connected. This
  is a narrower signal than "the hosted bundler is down" (it also fires for,
  e.g., a `dispose()` racing the connect), but it is the only one this task
  found a defensible mechanism for.
- **T07-D4 — `hmr.roundtrip_ms` has no dedicated injected hook; it reuses the
  existing post-ready `onFrameLoad` path.** The task's own candidate — "the
  Tier-2 dev server's HMR message relayed through the existing monitor
  postMessage" — does not exist yet: `MONITOR_KINDS` (`monitor.ts`) has no HMR
  member, adding one is outside this task's Owns (`monitor.ts` is shared with
  `reportDemoEvent`/`sentry.ts`, and the reporter is gated behind the monitor
  flag, so it would not be reliable in production anyway). What actually fires
  a frame `load` after ready, with no new injection: a dev server that does a
  **full page reload** in response to an edit. Genuine in-place HMR (React Fast
  Refresh, Vite's module replacement) patches the DOM without ever navigating
  the iframe, and stays invisible to this hook by construction — it is
  indistinguishable from "no edit happened yet" from outside the iframe. See
  the support table below.

**HMR support table** (from code inspection of each starter's dev-server config
and framework HMR model — not yet confirmed against a live edit in a running
container; Phase 2's `e2e/telemetry-metrics.spec.ts` is where that observation
belongs, per the task's own Acceptance criteria):

| Framework family | Dev server | Expected `hmr.roundtrip_ms` behaviour |
|---|---|---|
| React (CRA/Vite), Vue (Vite), Svelte (Vite), Solid (Vite) | Vite | **Not observed** — Vite's client patches modules in place over its own WebSocket; no iframe `load` fires on an ordinary edit. A syntax error that forces Vite's full-reload fallback WOULD fire it, but that path was not exercised. |
| Next.js | Next dev (Fast Refresh, webpack/Turbopack HMR) | **Not observed** — same reasoning as Vite; Next's Fast Refresh also patches in place. |
| Angular | Angular CLI dev server | **Likely observed** — Angular's dev-server HMR support is opt-in and off by default in the generated starters (unverified against the actual starter's `angular.json`); a default-config edit triggers a full live-reload navigation, which this hook catches. |
| Remix | Vite (Remix's Vite plugin) | **Not observed** — same Vite HMR model as above. |
| Astro, Nuxt | Astro dev / Nuxt (Vite-based) | **Not observed** — both ship Vite-model HMR for their client islands/components. |

Net: this hook is expected to catch **few or none** of the current Tier-2
starters in their default configuration — most ship a real in-place HMR client.
It is not dead code (a starter without one, or one whose HMR client crashes and
falls back to a full reload, still produces a correct measurement), but Phase 2
must not report "HMR works" from an empty result: an all-quiet
`hmr.roundtrip_ms` in the E2E run is the *expected* outcome for the Vite-family
starters, not a failure of the hook. This whole table is a prediction from
reading each dev server's HMR model, not a measurement — Phase 2 replaces it
with what the E2E run actually observes.

**Measured `preview.ready_ms` per tier**: not yet — Phase 1 has no running
preview to measure against (`App.tsx` is untouched, per the phase boundary).
Deferred to Phase 2's `e2e/telemetry-metrics.spec.ts`, per the task's Acceptance
criteria.

**Known gap**: `onBundlerUnreachable`'s wiring inside `mount()` (the
`loadSandpackClient` rejection path) is exercised in
`pipeline/browser-metrics.test.mjs` against a fake hook (proving
`wireSandpackMetrics`'s own emission logic), but not against the real
`loadSandpackClient` rejecting — that function is a direct top-level ESM import
in `sandpack.ts`, and Node's `node:test` module mocking needs
`--experimental-test-module-mocks`, which `pnpm test`'s script does not pass
(confirmed: `mock.module is not a function` without the flag). Changing the
test script is outside this task's scope. The dispatch/reset logic around it
(what happens on either side of the `try`/`catch`) was read carefully and is
structurally identical to the already-tested `pushUpdate` dispatch path.

**Verify — commands run, exit codes** (all via `rtk proxy <command>; echo
"exit=$?"`, rtk's own summaries not trusted, from `runner/`):

```
rtk proxy pnpm install                                              exit=0
rtk proxy pnpm --filter @handsontable/demo-runtime build             exit=0
rtk proxy pnpm -r run typecheck                                      exit=0 (5/5 projects with a script; pipeline has none, unrelated)
rtk proxy pnpm test                                                  exit=1 (1284 tests, 1281 pass, 1 pre-existing baseline failure — "the pin tracks its own major's starter bucket", named in COMMON.md — 2 pre-existing todo; every new T07 case passes)
rtk proxy node scripts/check-test-presence.mjs feat/runner-observability   exit=0 (after committing — the script diffs committed refs, not the working tree)
```

**Test-failing-when-reverted evidence** — every guard below was disabled, the
named case(s) confirmed red for the right reason, then restored and
re-verified green (full build + the affected suite re-run clean after every
restore):

| Guard removed | Case(s) that went red |
|---|---|
| `metrics.ts` `trackPreviewReady`'s `if (settled) return;` | 4 cases: second-onReady, abandon-after-ready, observe()-then-abandon ordering, timeout-then-late-ready |
| `metrics.ts` `wireSandpackMetrics`'s fingerprint dedupe (`seenFingerprints`) | the keystroke-ladder case |
| `sandpack.ts` `resolveCompileTiming`'s `if (this.compileDispatchedAt === null) return;` | the "reaches done" and the "no-change compile never dispatches" cases |
| `sandpack.ts` `onMessage`'s `if (!evaluated)` guard around the compile-error/timing resolution | the evaluation-error case |
| `container.ts` `classifySessionStartOutcome`'s DEMOS-9 interception branch (checked before the generic timeout tier) | the DEMOS-9-interception case |
| `container.ts` `onFrameLoad`'s `wasReadyBeforeThisLoad && !this.reloadInFlight` guard | the pre-ready-navigation and the own-`reload()` cases |
| `container.ts` `flush()`'s `if (this.didReady ...)` guard | the pre-ready-buffered-flush case |

**Files touched beyond the task's "Owns" row**: `packages/runtime/src/types.ts`
was **not** touched in Phase 1 — the new hooks lived on the concrete
`SandpackRuntime`/`ContainerRuntime` classes only, matching the existing
`onProgress`/`onStderr` precedent (tier-specific extensions, never widening the
shared `DemoRuntime` interface). **Superseded in Phase 2**: the controller
asked for the hooks on `DemoRuntime` itself, so `types.ts` is now touched — see
the Phase 2 section for the reasoning (moving the event types there, not into
either engine file, to avoid a circular import) and for why that is a
`types.ts` change this task's "Owns" row does not literally name, but is the
direct, requested consequence of the "timing hooks ... on the existing
DemoRuntime" line in the task's own Scope.

**Not done in this phase** (by the controller's explicit sequencing): `App.tsx`
call sites, `apps/authoring/src/telemetry/index.ts`, `e2e/telemetry-metrics.spec.ts`,
the measured `preview.ready_ms` numbers, and confirming the HMR support table
against a live edit — all Phase 2, after T06 merges.

### Phase 2

**Merge**: `git merge feat/runner-observability` (T00, T01, T05, T06, T09 all
landed on the base). No conflicts — Phase 1 never touched `App.tsx` or any file
T06 also changed.

**Controller note addressed — hooks moved onto `DemoRuntime` itself.**
`SandpackCompileTimingEvent`, `SandpackCompileErrorEvent`,
`SandpackBundlerUnreachableEvent`, `SessionStartTimingEvent`,
`HmrRoundtripEvent`, and `onCompileTiming?`/`onCompileError?`/
`onBundlerUnreachable?`/`onSessionStart?`/`onHmr?` are now declared directly on
`DemoRuntime` in `packages/runtime/src/types.ts`, as **optional** members. The
event interfaces live in `types.ts`, not in `sandpack.ts`/`container.ts`:
`DemoRuntime` is declared in `types.ts`, and both engine files already import
it from there, so putting the event types in either engine file and having
`types.ts` import them back would be a circular import. `sandpack.ts`/
`container.ts` now `import type {...} from "./types.js"` and re-export the same
names (`export type {...} from "./types.js"`) so the existing
`@handsontable/demo-runtime/sandpack` / `/container` subpath imports (this
task's own `metrics.ts`) keep resolving unchanged. `packages/runtime/src/
index.ts`'s explicit named re-export list (not `export *`) gained the five new
type names too, or `metrics.ts` could not import them from the bare
`@handsontable/demo-runtime` specifier.

Consequence in `apps/authoring/src/telemetry/metrics.ts`: `wireSandpackMetrics`
and `wireContainerMetrics` (Phase 1) are now ONE function, `wireRuntimeMetrics(runtime:
DemoRuntime, ctx, telemetry)`, calling every hook through `runtime.onX?.(cb)`.
`App.tsx`'s mount effect calls it once, unconditionally, with no `entry.engine`
branch and no cast to `SandpackRuntime`/`ContainerRuntime` — wiring a
`ContainerRuntime` simply leaves the three Sandpack-only optional chains as
no-ops, and vice versa.

**App.tsx call sites** (all read the live `telemetry` binding at the call site,
never captured into a constant — `initTelemetry()` reassigns it):

- Mount effect (`preview.ready_ms`, `sandpack.*`, `session.start_ms`,
  `hmr.roundtrip_ms`): `wireRuntimeMetrics(runtime, {framework, versionRef},
  telemetry)` and `trackPreviewReady(runtime, {surface, tier, framework,
  versionRef, bucket}, telemetry)`, right after `demoContext` is defined (reuses
  its own engine-derived `tier`, never `entry.tier` — the catalog tier, which
  disagrees with the engine for the five UI-library starters: `react-js` is
  catalog tier 1 but `engine: "container"`, per `engine-smoke.spec.ts`).
  `mount()`'s promise is captured in a variable (`mountPromise`) so
  `previewTracker.observe(mountPromise)` and the existing `.then()/.catch()`
  chain share the SAME promise — `mount()` is still called exactly once.
  `previewTracker.abandon()` runs in the effect's cleanup. `surface` is
  `isShare ? "share" : "authoring"` (not hardcoded `"authoring"` the way T06's
  own `reportRuntimeError` call sites are — a deliberate improvement here, not
  a T06 file edit). The early-return guards above this point (invalid version,
  below-floor major, `versionPending`) never construct a tracker, so they emit
  no `preview.ready_ms` — by design, matching "from the moment an example is
  resolved": an example that never got that far was never resolved.
- `changeVersion` (`version.switch`): emits before `setVersion(next)`, so
  `version` (component state) is still the FROM ref; `fromRef` and `toRef`
  BOTH go through `htMajorOf` now (not the raw ref for `fromRef`, Phase 1's
  gap) — `fromRef` traces back to the user-controlled `?v=` URL parameter, and
  a raw pkg.pr.new URL landing unbounded in an Analytics Engine blob is exactly
  what the closed-set conversion prevents. `bucket` reads whichever kind of
  workspace is open (`docsPathRef`/`activeDocsBucketRef`/
  `activeStarterBucketRef`).
- Starter bucket-resolve effect (`bucket.resolve_ms`): a SEPARATE `.then(ok,
  err)` attached to the raw `loadStarterExample(...)` promise, not chained onto
  the existing app-logic `.then()/.catch()` — that chain's `.catch` also
  catches a throw from inside its own `.then` (e.g. `loadWorkspace`), which
  would have double-reported one resolve as `ok` then `error`. Note:
  `loadStarterExample` caches by bucket+framework, so re-picking an
  already-fetched bucket reports a near-zero duration — a real cache hit, not
  a bug.
- Docs bucket-resolve effect (`bucket.resolve_ms`): same pattern, around
  `fetchDocsManifest(candidate)` (also cached, `docs-catalog.ts`).

**A contract gap found, not fixed (T00's file, out of this task's Owns).**
`apps/authoring/src/telemetry/faro.ts#DOTTED_ATTR_KEY` only remaps `surface`,
`tier`, `framework`, `ht_major`, `outcome` and `demo_id` to their dotted
`hot.*` resource-attribute equivalents before `scrubTelemetry` runs; every
other `HotAttrs` field this task emits — `bucket`, `reason`, `fingerprint` —
has no dotted equivalent in `attrs.ts#RESOURCE_ATTRS`/`STRUCTURED_METADATA_KEYS`/
`DIAGNOSTIC_TAG_KEYS`, so the browser-side allowlist in `scrub.ts` drops them
silently before the request ever leaves the browser (confirmed by reading
`attrs.ts` after the merge, not assumed — the same shape of gap T06-D1 already
found and partly fixed for `reportError`'s own tags, just not for these).
Consequence: **`sandpack.compile_error` ships with no `fingerprint` today,
`version.switch` with no `reason`/`bucket`, `preview.ready_ms` and
`bucket.resolve_ms` with no `bucket`** — everything else in the metric (name,
outcome, tier, framework, ht_major, duration) arrives intact. The E2E spec
below asserts only on keys confirmed to survive (`hot.tier`, `hot.framework`,
`hot.outcome`) for exactly this reason. Follow-up: whichever task owns
`attrs.ts`/`faro.ts` next needs to add `bucket`, `reason`, `fingerprint` (and
`route_class`/`model`/`provider`/`device`/`kind`/`ref`/`area` for T08/T09/T11's
own metrics) to `DOTTED_ATTR_KEY` and a dotted `hot.*` resource-attribute
counterpart, the same way T06-D1 did for `handled`/`context`/etc — this is a
blocking gap for T09's dashboards on every field but the five listed.

**HMR support table**, now with a real Tier-2 observation, not only a
prediction:

| Framework | Dev server | `hmr.roundtrip_ms` | Evidence |
|---|---|---|---|
| `react-js` (Tier-2 UI-library starter) | Vite (`@vitejs/plugin-react`), Vite's own full-reload fallback | **Observed** | Live E2E run: an edit at the top of the entry file (outside any component, so Vite's Fast-Refresh boundary does not apply and it falls back to a full reload) produced a real `hmr.roundtrip_ms` point, `783`–`800ms` across two independent runs. |
| React (Vite, CRA), Vue (Vite), Svelte (Vite), Solid (Vite), Remix (Vite plugin), Astro, Nuxt — an edit INSIDE a component/module Vite can hot-accept | Vite | **Not observed** (predicted) | Vite's client patches the module in place over its own WebSocket; no iframe `load` fires. The table is now keyed on framework **and** which file is edited, not on framework alone — Phase 1's blanket "not observed" row overstated this: the SAME dev server produces a full reload for an edit outside any HMR-accepted module (the entry file, as measured above) and an in-place patch for an edit inside one. |
| Angular | Angular CLI dev server (`@angular-devkit/build-angular:dev-server`) | **Predicted: observed** (not live-measured) | `examples/angular/angular.json`'s `serve` architect target sets no `hmr` option, and `examples/angular/package.json`'s `dev`/`start` scripts run plain `ng serve --port 3000` with no `--hmr` flag — Angular's dev-server HMR is opt-in and off by default, so an edit should produce an ordinary LiveReload full-page reload, which this hook catches the same way it caught `react-js`'s. Not run live in this phase (time budget); a good E2E-live/starter-matrix candidate later. |

Net, corrected from Phase 1's prediction: this hook is not a "catches almost
nothing" signal — it reliably catches every full-page reload regardless of
which framework or dev server produced it (that is the whole design: it
listens for the iframe `load`, not for anything dev-server-specific), and it
now has one real, repeated measurement proving the mechanism works end to end.
What it still cannot see, by construction, is a true in-place HMR patch — that
observation stands.

**Measured `preview.ready_ms`, from the live E2E run's captured payloads**
(`test.info().annotations`, not a separate stopwatch):

| Tier | Example | `hot.framework` | Measured `duration_ms` |
|---|---|---|---|
| 1 (Sandpack) | `react` | `react` | `2041`–`2116` ms (two independent runs) |
| 2 (container) | `react-js` | `react-js` | `12611` ms (warm container, second run) / `53006` ms (cold container, first run) — both real: the API worker's own container pool reused the first run's warm instance for the second, which is exactly the warm-boot case the missing `reason` field (T07-D2) would have wanted to label. |

**E2E infrastructure, and why it needed its own local API worker.** Building
with a bare `VITE_TELEMETRY_LOCAL=1` compiles `VITE_API_BASE` from the
COMMITTED `apps/authoring/.env.production` (`https://demos.handsontable.com` —
AGENTS.md: that file outranks `.env.local`, and the app's own `:8787` fallback
only applies to a falsy value), so a Tier-2 session created against that build
would land in the real production container pool. `e2e/telemetry-metrics.spec.ts`
therefore starts its own `wrangler dev` (this task's 4800–4899 port block:
4810 API, 4811 inspector) — needs `workers/api/.dev.vars` copied from the main
checkout with `PREVIEW_HOST` repointed at `localhost:4810` — and builds a
SEPARATE dist (`--outDir dist-telemetry-metrics`) with `VITE_API_BASE` set to
that local origin in the process environment (Vite: process env beats `.env`
files). The `beforeAll` hook verifies this positively — greps the built assets
for the literal `localhost:4810` string — rather than only negatively grepping
for the production hostname (which also appears legitimately, as the
`reportingGate.ts` hostname constant and in guide text, and would false-fire
on every build).

**Test-failing-when-reverted evidence, Phase 2.** `previewTracker` was replaced
with a no-op stub (`{ observe() {}, abandon() {} }`), the dist rebuilt, and the
Tier-1 E2E case re-run: it failed for the right reason (`expect.poll(...)
.toBe(1)` timed out at `0`, "no preview.ready_ms measurement ever arrived"),
then the revert was undone, retypechecked, and the full spec re-run clean. The
Phase 1 revert-check table (guards inside `sandpack.ts`/`container.ts`/
`metrics.ts`) is unaffected by the `wireRuntimeMetrics` refactor — the same
guards exist, just reached through one function instead of two — and
`pipeline/browser-metrics.test.mjs`, `sandpack-reload.test.mjs` and
`session-start-failure.test.mjs` were all re-run green after the refactor
(they were also updated: `wireSandpackMetrics`/`wireContainerMetrics` call
sites → `wireRuntimeMetrics`, and `version.switch`'s `reason` assertions
updated for the `htMajorOf(fromRef)` fix, plus a new case for a pkg.pr.new
`fromRef`).

**Verify — commands run, exit codes** (all via `rtk proxy <command>; echo
"exit=$?"`, from `runner/`):

```
rtk proxy pnpm --filter @handsontable/demo-runtime build                    exit=0
rtk proxy pnpm -r run typecheck                                              exit=0 (5/5 projects with a script)
rtk proxy pnpm test                                                          exit=1 (1426 tests, 1423 pass, 1 pre-existing baseline failure — "the pin tracks its own major's starter bucket" — 2 pre-existing todo; every T07 case passes)
rtk proxy node scripts/check-test-presence.mjs feat/runner-observability     exit=0 (after committing)
VITE_TELEMETRY_LOCAL=1 VITE_API_BASE=http://localhost:4810 npx vite build --outDir dist-telemetry-metrics  exit=0 (run from apps/authoring, with local wrangler dev already up)
E2E_LIVE=1 E2E_TELEMETRY=1 npx playwright test e2e/telemetry-metrics.spec.ts exit=0 (2/2 passed — Tier-1 in 3.4s/16.9s wall, Tier-2 in 12.6s–53s depending on container warmth; measured durations above)
```

**Known gaps / follow-ups, reported rather than silently worked around:**

- The contract-scrub gap above (`bucket`/`reason`/`fingerprint` dropped
  browser-side) — not this task's file to fix.
- **No workflow runs any `E2E_TELEMETRY` spec** — confirmed by grepping every
  `.github/workflows/*.yml` for the string, zero hits. This is a pre-existing
  gap this task inherits, not one it introduced: T06's own
  `e2e/telemetry-faro.spec.ts` has the identical gate and the identical
  absence. Per `docs/TESTING.md`'s own named anti-pattern ("orphaned gated
  specs... equals deleted, with worse optics"), both specs are currently dead
  weight from CI's point of view. Workflow files are not in this task's (or
  T06's) Owns row — flagged for whichever task/controller pass wires
  `e2e-live.yml`.
- Local Docker cleanup after a Tier-2 E2E run needs a manual `docker stop`/`rm`
  once `wrangler dev` itself is killed: `trackSessions().cleanup()` DOES call
  `DELETE /api/session/:id` in the test's `finally` (confirmed — the helper is
  the same one `engine-smoke.spec.ts` uses), but the underlying Sandbox
  container stayed `Up` after that DELETE and after the test process exited,
  until `wrangler dev` was killed and the container manually stopped. Whether
  that is `sleepAfter`'s grace window doing exactly what it is designed to do,
  or a local-`wrangler dev`-specific teardown gap, was not investigated
  further (out of scope) — noted here so a future local Tier-2 E2E run does
  not assume the container is gone.
- The `hmr.roundtrip_ms` Angular row is a static-config read, not a live
  measurement (time budget). The table says so.

Status: **done**.
