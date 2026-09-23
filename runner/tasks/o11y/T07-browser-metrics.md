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

### Phase 1 (this pass)

**What was built**

- Timing hooks added directly to the two runtime engines, in the same style as
  the existing `onProgress`/`onStderr` extension points — engine-specific, not
  on the shared `DemoRuntime` interface (`types.ts` is untouched):
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
was **not** touched — the new hooks live on the concrete `SandpackRuntime`/
`ContainerRuntime` classes only, matching the existing `onProgress`/`onStderr`
precedent (tier-specific extensions, never widening the shared `DemoRuntime`
interface). Nothing outside the task's declared "Owns" row was edited.

**Not done in this phase** (by the controller's explicit sequencing): `App.tsx`
call sites, `apps/authoring/src/telemetry/index.ts`, `e2e/telemetry-metrics.spec.ts`,
the measured `preview.ready_ms` numbers, and confirming the HMR support table
against a live edit — all Phase 2, after T06 merges.

### Phase 2

_Filled in when done._
