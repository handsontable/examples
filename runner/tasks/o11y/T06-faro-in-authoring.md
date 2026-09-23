# T06 — Faro in the authoring app and browser-side Sentry trim

| | |
|---|---|
| Status | todo |
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

_Filled in when done._
