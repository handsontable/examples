---
name: runner-playwright-e2e
description: Use when writing or modifying Playwright E2E specs for the demo runner (runner/e2e/*.spec.ts) - the deterministic-by-default suite, the env-gate taxonomy (E2E_LIVE, E2E_BASE_URL, E2E_BROKER_TOKEN, E2E_AI, E2E_STARTER_MATRIX), the shared helpers, data-* test contracts, CodeMirror and Sandpack gotchas, and container-pool hygiene. NOT for pipeline unit tests (node --test in runner/pipeline/).
---

# Runner Playwright E2E authoring

Specs live in `runner/e2e/*.spec.ts`, run by `pnpm e2e` against a `vite
preview` of the built app (or `E2E_BASE_URL` for a deployment). Reference:
`e2e/helpers.ts` + any recent DEV-2203 spec. The full ruleset, idioms with
examples, and the anti-pattern history: **`runner/docs/TESTING.md`**. The
meaningfulness bar: the `runner-test-discipline` skill.

## Deterministic by default

The PR suite must never touch the network beyond the preview server. Start
every ungated spec with `stubShell(page)` (from `e2e/helpers.ts`): it stubs
`/api/versions`, aborts both Sandpack hosts (the shell renders fine without a
grid), and neuters the login redirect. Fake sign-in at the token layer with
`signIn(page)` — never via `VITE_DEV_USER`, which bypasses the production auth
path.

Anything that needs the real world takes the **narrowest gate** that covers the
dependency — `E2E_LIVE` (real preview mount), `E2E_BASE_URL` (worker routes),
`E2E_BROKER_TOKEN` (authed round-trip), `E2E_AI` (LLM spend),
`E2E_STARTER_MATRIX` (container matrix). Two hard rules: the spec self-skips
with instructions (`test.skip(cond, "set X=1 to …")`), and every gated spec is
named in a workflow that actually runs it — in the same PR. Full taxonomy:
`runner/docs/TESTING.md`.

## Five rules (non-negotiable)

1. **Import the shared helpers.** `stubShell`, `signIn`, `activeEditor`,
   `workspaceFiles`, `pickFromMenu`, `previewReady`, `expectGridRendered`,
   `trackSessions`, `isKnownNoise` live in `e2e/helpers.ts`. Never re-declare
   them locally — that is how nine copies of `stubShell` happened.
2. **Hook by the documented `data-*` test contracts, never visible text.**
   Preview readiness = `data-preview-status` on the Preview section; the active
   editor pane = `[data-pane-active="true"]`; workspace contents =
   `window.__HOT_FILES__`. Need a new hook? Add the `data-*` attribute to the
   component, comment it as a test contract, and use it — don't parse the UI.
3. **Web-first waits only.** `await expect(locator)...`, `expect.poll()`, or
   `expect(async () => {...}).toPass()` around debounces (Style panel writes
   ride 250 ms). Never `waitForTimeout`. Await every assertion.
4. **CodeMirror is virtualized.** A bare `.cm-content` trips strict mode once a
   second tab is open, and it only holds the lines on screen — never read file
   contents from it. Read via `workspaceFiles()`; type via the CodeMirror view
   dispatch (see `editor-download.spec.ts`). The version/framework pickers are
   custom listboxes — `pickFromMenu()`, not `selectOption`.
5. **Container-pool hygiene.** Tier-2 sessions share five global slots with
   real traffic. Any spec that can boot one wraps in
   `trackSessions(page)` + `finally { tracked.cleanup(request) }`. For
   containers, `previewReady` only means the dev server answered — follow with
   `expectGridRendered` before asserting on the demo.

## Prove it, don't observe it

- **Interaction states**: real pointer + `getComputedStyle` (ADR-0026). A
  synthetic `mouseover` does not fire `:hover`; a screenshot cannot tell a
  live hover from a dead one.
- **Caching/fetch discipline**: collect request paths in `page.route()` and
  assert the exact list (`docs-examples.spec.ts` — one manifest fetch per
  bucket, in order).
- **Persistence**: reload and re-measure. Never `addInitScript` a storage
  clear — it re-runs on `page.reload()` and defeats the assertion. Each test
  already gets a fresh context.
- **Console noise**: filter through `isKnownNoise` and extend `NOISE` with a
  comment; never blanket-ignore console errors.

## Where tests run

Locally, run **only the spec you created or changed**:
`cd runner && pnpm e2e e2e/<your-spec>.spec.ts`. The full deterministic suite
belongs to PR CI (`ci.yml`); the gated suites belong to `e2e-live.yml` and
`e2e-starter-matrix.yml`. `share-view.spec.ts` depends on the permanent fixture
demo (`FIXTURE_ID`) — never revoke it.

## Which test — decide, then route

- **A user can see or do it** → E2E here.
- **Pure logic or a worker route** → `node --test` in `runner/pipeline/`
  (routes via the `mcp-routes.test.mjs` harness pattern).
- **Pure refactor** → no new test; `Refactor-only: <reason>` trailer.

The presence gate enforces the choice on every PR; decision table in
`runner/docs/TESTING.md`.
