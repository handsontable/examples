---
name: runner-test-discipline
description: Use when writing, fixing, or reviewing tests for any runner change (pipeline unit tests, worker route tests, or Playwright E2E), and whenever a test is red during feature work. Enforces that tests prove intended behavior — not just execute code, and never "green for the sake of green". Covers intent-first, deciding whether the code or the test is wrong when red (default - the code), the banned ways of faking green, write-the-failing-test-first, verify-with-a-real-run, no hollow assertions, and not mocking the unit under test.
---

# Runner test-writing discipline

**Green is not the goal — correct behavior is.** A test that passes but asserts
nothing, or asserts the *buggy* output, is worse than no test: it certifies the
bug and reads as coverage. Never make a red test pass by weakening it. Full
rules, the which-test-where table, the env-gate taxonomy, and the house
assertion idioms: **`runner/docs/TESTING.md`**. E2E mechanics: the
`runner-playwright-e2e` skill.

## The test encodes intent, not the implementation

Write the test from the **requirement** — what the user or the API is supposed
to do — not from what the code currently does. Where feasible, write it first,
so it is an oracle you cannot accidentally fit to a bug. For E2E, state the
user-observable expectation *before* you wire a single locator.

## When a test is red, decide what is actually wrong

At the feature stage the **code is the prime suspect, not the test.**

- **Expectation correct, code wrong → fix the code.** The common case. Leave
  the test alone.
- **Expectation mis-encoded the intent → tighten the test toward the real
  behavior** — never loosen it to match the current (possibly wrong) output.

If you cannot tell which is wrong, re-read the requirement — that is not a
signal to relax the test.

### Banned ways of faking green

- Deleting or loosening an assertion, or widening a timeout/tolerance, to match
  what the code emits.
- `test.skip` / `test.fixme`, or focusing with `test.only` / `it.only`.
- try/catch around the body to swallow a failure.
- Asserting whatever the code happened to produce (a "snapshot of the bug").
- Leaning on CI retries to paper over a real intermittent failure.
- Adding an env gate (`E2E_LIVE` and friends) so PR CI stops running the spec.
  Gates are for external dependencies and spend, never for red tests.

## Bug fixes: write the failing test first

1. Reproduce the bug as a test and **watch it fail — for the right reason**
   (the missing behavior, not a typo or a dead selector).
2. Apply the fix; watch the same test pass.
3. A regression test that was never red proves nothing. On a bugfix PR, name
   the spec that fails without the fix.

## Verify before you say "done"

Run the exact command fresh, read the full output and the exit code, and state
the result with that evidence. Banned phrasings: "should work", "this fixes it"
without a run, "tested manually, looks fine". After editing source, run the
impacted test — `pnpm test` for pipeline units, `pnpm e2e e2e/<spec>.spec.ts`
for the spec you touched — not the whole suite.

## No hollow assertions

Assert the **behavior**, not that the code ran. This repo's cautionary tale
(fixed in #201): the MCP containment guard was tested against a **local copy of
its own predicate** — deleting the guard from the route left the test green.
Import the real control, drive the real route, and check that the test *can*
fail: neuter the control and watch it go red.

## Don't mock the unit under test

Mock at the real boundary: `page.route()` for the network, in-memory fakes for
worker bindings (D1, KV, R2), the structural `@cloudflare/sandbox` stub
(`pipeline/fixtures/`). Route-level worker promises are tested by driving the
**real default export** of `workers/api/src/index.ts` under `node --test` — the
`mcp-routes.test.mjs` harness pattern. A fake must model the complete real data
shape; an incomplete fake gives a false pass.

## The presence gate

Source changed ⇒ a test changed, machine-enforced on every PR
(`runner/scripts/check-test-presence.mjs`). Pure refactor → `Refactor-only:
<reason>` trailer; test landing in a named follow-up → `Test-plan: <reason>`.
Reviewers hold you to the reason.
