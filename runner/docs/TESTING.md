# Testing — the rules

The test-writing discipline of the handsontable monorepo, ported to the runner's
stack (Playwright + `node --test`; no Jest, no Jasmine). This file is the single
place the rules live: `AGENTS.md` keeps only the quick list, and the two skills
(`.claude/skills/runner-test-discipline/`, `.claude/skills/runner-playwright-e2e/`)
point back here.

## The discipline core

**Green is not the goal — correct behavior is.** A test that passes but asserts
nothing, or asserts the *buggy* output, is worse than no test: it certifies the
bug and reads as coverage.

- **The test encodes intent, not the implementation.** Write it from the
  requirement — what the user or the API is supposed to do — not from what the
  code currently does. Where feasible, write it first, so it is an oracle you
  cannot accidentally fit to a bug. For E2E, state the user-observable
  expectation before you wire a single locator.
- **When a test is red, decide what is actually wrong — don't chase green.**
  At the feature stage the code is the prime suspect, not the test. Expectation
  correct, code wrong → fix the code, leave the test alone. Expectation
  genuinely mis-encoded the intent → tighten the test toward the real behavior,
  never loosen it to match the current output. Can't tell which is wrong? Re-read
  the requirement — that is not a signal to relax the test.
- **Bug fixes: write the failing test first.** Reproduce the bug as a test,
  watch it fail *for the right reason* (the missing behavior, not a typo or a
  dead selector), then fix, then watch the same test pass. A regression test
  that was never red proves nothing. On a bugfix PR, name the spec that fails
  without the fix.
- **Verify before you say "done".** Run the exact test command fresh, read the
  full output and the exit code, and state the result with that evidence.
  Banned phrasings: "should work", "this fixes it" without a run, "tested
  manually, looks fine".
- **No hollow assertions.** Assert the behavior, not that the code ran. One
  meaningful assertion beats five that restate the setup. The canonical local
  failure: the MCP containment guard ("only demos the MCP created are updatable
  through it") was tested against a **local copy of its own predicate** instead
  of the route's exported check — deleting the guard from `index.ts` left the
  test green. A test of a security control that cannot fail when the control
  goes away. Fixed in [#201](https://github.com/handsontable/examples/pull/201):
  the predicate became `isMcpCreated()` in `mcp-create.ts`, the route calls it,
  the test imports it, and a source-grep test pins the route to the export.
- **Don't mock the unit under test.** Mock at the real boundary: `page.route()`
  for the network, in-memory fakes for worker bindings (D1, KV, R2), a
  structural stub for `@cloudflare/sandbox` (its `cloudflare:` imports only
  exist inside workerd). When you must build a fake, fake the **complete** real
  data shape — an incomplete fake gives a false pass.

### Banned ways of faking green

Never reach green by any of these:

- Deleting or loosening an assertion, or widening a timeout/tolerance, to match
  what the code emits.
- `test.skip` / `test.fixme` / `it.skip`, or focusing with `test.only` /
  `it.only` (focusing silently drops the rest of the suite).
- Wrapping the body in try/catch to swallow a failure.
- Asserting whatever the code happened to produce (a "snapshot of the bug").
- Retries to paper over a real intermittent failure — in CI `retries: 2` exists
  to absorb infrastructure noise, not your race condition. Root-cause it.
- Adding an env gate (`E2E_LIVE` and friends) to a spec so PR CI stops running
  it. Gates exist for external dependencies and spend, never for red tests.

## Which test, where

Machine-enforced by the presence gate (`runner/scripts/check-test-presence.mjs`,
the `presence` job in `ci.yml`): a PR that changes
`runner/{apps,packages,workers}/**` source must also change a test.

| The change | The test | Where |
|---|---|---|
| Pure logic — parsers, importers, transpilers, theme codegen, worker helpers | `node --test` unit | `pipeline/<area>.test.mjs` (runs via `pnpm test`; `--experimental-strip-types` lets it import `.ts` directly) |
| A worker route's promise — status codes, response shapes, auth guards | Route-level harness: drive the **real default export** of `workers/api/src/index.ts` under `node --test`, via module hooks (`pipeline/fixtures/worker-hooks.mjs`) and in-memory binding fakes | The `mcp-routes.test.mjs` pattern ([#201](https://github.com/handsontable/examples/pull/201)) |
| Anything a user sees or does in the app — editor, preview, sharing, panels | Playwright spec | `e2e/<area>.spec.ts` |
| Generated content — `*.generated.ts`, `public/` buckets | Regenerate via the pipeline; the smoke tests (`catalog-smoke`, `frameworks-generated`, `starter-catalog-smoke`) pin the output | Excluded from the presence gate as source |
| A starter's own source, `tsconfig*.json` or dependencies (`examples/<starter>/**`) | Its own `package.json` `build`, plus its `typecheck` script when it ships one — run in a copy **outside the repo tree**, because a `types` entry resolves through an ancestor `node_modules` and an in-tree build stays green on the very defect (DEV-2730) | `.github/workflows/examples-build.yml` — frozen-lockfile lane on PRs, `handsontable@latest` lane weekly (DEV-2737). The fast static half is `pipeline/starter-type-roots.test.mjs`; `build-command-drift.test.mjs` keeps `BUILD_CONFIG` from dropping a type-check the starter performs |
| Pure refactor, no behavior change | No new test | `Refactor-only: <reason>` commit trailer |
| Tested, but the test lands elsewhere (a named follow-up PR, or an existing spec already proves it) | Declare where | `Test-plan: <reason>` commit trailer |

Both trailers require a non-empty reason, and reviewers hold you to it — the
gate trusts the declaration, the review verifies it.

**New spec vs. modify existing:** a new feature or endpoint → a new spec; a bug
fix → a failing case in the closest existing spec.

**SSR hydration, when you touch what we inject into a preview document**
(`packages/runtime/src/{monitor,scheme,inject-html}.ts`): unit tests can pin the
emitted bytes and the receiver's behaviour, but not whether a framework's hydrator
accepts the result — and remix hydrates with `hydrateRoot(document, …)` on React 18,
which throws the whole document away if `<head>` holds anything the server did not
render. Run `node runner/scripts/ssr-hydration-probe.mjs` against a locally served
starter; it puts the real injections and a real shell around it and exits non-zero on
a mismatch. The standing guard is the nightly starter matrix, which is where DEV-2580
was caught — four red remix cells, everything else green.

## The env-gate taxonomy

The default `playwright test` run is the deterministic PR suite: `stubShell()`
aborts both Sandpack hosts, stubs `/api/versions`, and neuters the login
redirect. Everything beyond that world is gated. Pick the *narrowest* gate that
covers the dependency:

| Gate | Use when the spec needs | Runs in | Notes |
|---|---|---|---|
| *(none)* | Only the built SPA — shell, routing, stubbed network | `ci.yml` on every PR | The default. If you can stub it, don't gate it. |
| `E2E_LIVE=1` | A real preview mount — the hosted Sandpack bundler or a Tier-2 container | `e2e-live.yml` (manual + canary/smoke once [#189](https://github.com/handsontable/examples/pull/189) lands) | Off by default so an external-bundler outage never blocks merges. |
| `E2E_BASE_URL` | Worker routes (`/api`, `/d`, `/embed`) — `vite preview` has none, so the spec self-skips without it | `e2e-live.yml` pointed at a deployment | `share-view.spec.ts` also needs the permanent fixture demo (`FIXTURE_ID`) — never revoke it. |
| `E2E_API_TOKEN` | An authed write round-trip against the deployed API (`share-create-live.spec.ts`, `session-abandoned-create.spec.ts`) | `e2e-live.yml` | A persistent API token minted on `/api-tokens` (ADR-0037). It does not expire, so a token that stops validating **fails** the run — it means revoked or broken. Absent, the step is skipped. |
| `E2E_AI=1` | A live LLM answer (`ai-live.spec.ts`, lands with [#187](https://github.com/handsontable/examples/pull/187)) | `e2e-live.yml` weekly canary | Real budget, shared 8/min-per-IP rate bucket — a 429 skips rather than fails. |
| `E2E_STARTER_MATRIX=1` | Every starter × major through a live container session | `e2e-starter-matrix.yml` (manual + monthly) | Serialized against the global container cap; never fold matrix cases into the PR suite. |

Two rules that keep gates honest:

- **A gated spec must self-skip with instructions**:
  `test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to …")` — a silent
  skip reads as a pass.
- **Every gate must have a workflow home.** A gated spec no workflow names is
  dead code that reads as coverage: the `E2E_LIVE` specs existed for nine days
  (2026-07-15 → 2026-07-24) before `e2e-live.yml` ran them, and both DEV-2129
  regressions shipped invisible to CI in exactly that window. When you add a
  gated spec, name it (or its gate) in the workflow that runs it, in the same PR.

## House assertion idioms

These are the proven local patterns. Reach for them before inventing one.

- **`getComputedStyle` and a real pointer, not screenshots**
  ([ADR-0026](adr/0026-shell-styling-inline-vs-stylesheet.md)). A synthetic
  `mouseover` does not fire CSS `:hover`, and a screenshot cannot tell a subtle
  live hover from a dead one. Move the real pointer (`page.mouse`/`hover()`),
  then assert the computed style.
- **Prove by network count.** Collect requests in the `page.route()` handler
  and assert the exact fetch list — `docs-examples.spec.ts` proves cache
  isolation by asserting the manifest was fetched *once per bucket*, in order.
  "The data showed up" cannot distinguish a cache hit from a silent refetch.
- **Hook by the documented `data-*` test contracts, never visible text.**
  Preview readiness is `data-preview-status` on the Preview section
  (`PreviewPane.tsx`); the active editor pane is `[data-pane-active="true"]`;
  workspace contents come from the `window.__HOT_FILES__` hook (`App.tsx`).
  These are documented contracts — extend them in the component when a spec
  needs a new hook, and mark them as such.
- **`expect(...).toPass()` / `expect.poll()` around debounces.** The Style
  panel writes ride a 250 ms debounce; poll the condition, never
  `waitForTimeout`. Web-first assertions everywhere else — a missing `await`
  is the sneakiest flake.
- **Never read long files via `.cm-content`.** CodeMirror virtualizes long
  documents — the DOM holds only the lines on screen. Read file contents
  through `workspaceFiles()` (`e2e/helpers.ts`); type via the CodeMirror view
  dispatch, not synthetic keystrokes into a virtualized contenteditable.
- **Container-pool discipline.** Tier-2 sessions share five global slots with
  real traffic. Every spec that boots one uses `trackSessions()` and cleans up
  in `finally` — a leaked session squats a slot for its whole idle window. The
  same arithmetic is why deployed live runs are never `cancel-in-progress`: a
  cancelled run strands its containers.
- **Persistence needs a reload-and-remeasure.** A within-page test cannot see a
  persistence bug. And never `addInitScript` a storage *clear* — it re-runs on
  `page.reload()` and silently defeats the assertion it was meant to isolate
  (each test already gets a fresh context).
- **Source-grep pin tests** (`theme-codegen.test.mjs` style): when a behavior
  test proves a control works, a companion grep-the-source test can pin the
  implementation to the exported control so an inline copy cannot drift back
  in. Use both layers — #201 verified them independently (re-inlining the check
  fails the grep test; neutering the guard behind `false &&` fails the 403 test).

## Anti-patterns, from this repo's own history

Named, so nobody repeats them:

1. **The hollow guard test** (fixed in
   [#201](https://github.com/handsontable/examples/pull/201), DEV-2501 G1): the
   containment test declared its own local `fromMcp` predicate — a copy of the
   guard — instead of importing the route's check. It asserted a copy of
   itself; deleting the control kept it green.
2. **The untested router** (#201, G2): nothing imported the worker's router, so
   every route-level promise (status codes, 403s, 410, response shapes) was
   untested — while the file *looked* covered because its helpers were.
3. **Orphaned gated specs**: `E2E_LIVE` specs with no workflow that ran them
   (see the taxonomy above). Gated-but-never-run equals deleted, with worse
   optics.
4. **The empty failure artifact**: CI uploaded `playwright-report/` on failure
   for months, but the `github` reporter never writes that directory — the
   artifact was empty since the workflow was added (fixed in DEV-2203 by adding
   the `html` reporter). Verify the evidence chain, not just the assertion.
5. **The init-script storage clear**: an `addInitScript` that cleared a storage
   key to "isolate" a test also ran on `page.reload()`, silently defeating the
   persistence assertion it served.
6. **The falsified safety comment**: `cancel-in-progress: true` was justified
   by "live tests hold no server-side sessions" — true when written, falsified
   by the very next commit without touching the sentence, stranding containers.
   A comment that encodes an invariant needs a test or a gate, not trust.

## The presence gate

`runner/scripts/check-test-presence.mjs` — the `presence` job in `ci.yml`, on
every PR (skipped on `workflow_call`: a master push already passed it in its PR).

- **Trigger**: any changed `runner/{apps,packages,workers}/**/*.{ts,tsx}`,
  excluding `*.d.ts`, `*.generated.ts`, and `public/`.
- **Satisfied by**: any changed `runner/e2e/**/*.spec.ts` or
  `runner/pipeline/**/*.test.mjs` — added, edited, or deleted.
- **Escape hatch**: a `Refactor-only: <reason>` or `Test-plan: <reason>`
  trailer on any commit in the PR range. Non-empty reason required. The gate
  trusts the trailer; the reviewer verifies it — an abused trailer is a review
  comment, not a config change.

Run it locally before pushing: `node runner/scripts/check-test-presence.mjs master`.

## Verify before you push

```bash
cd runner
pnpm test                                   # node --test units (builds the runtime first, by design)
pnpm e2e e2e/<your-spec>.spec.ts            # only the spec you created or changed
node scripts/check-test-presence.mjs master # the gate, locally
```

Run only the specs you created or changed — the full deterministic suite is
PR CI's job, and the gated suites belong to their workflows.
