import test from "node:test";
import assert from "node:assert/strict";
import { describeDependencyFailure } from "../apps/authoring/src/dependencyFailure.ts";

// DEV-2872 / Sentry DEMOS-15 / DEMOS-85. DEV-2855 guarded `buildSetup` so an
// unparseable `/package.json` no longer aborts `mount()` — the preview survives, but
// the bundler then fails trying to resolve dependencies out of a manifest it can't
// read, and that failure carries the SAME "could not fetch dependencies" wording
// Sandpack uses for an unpublished/unresolvable Handsontable version. This module is
// what tells the two apart, by checking whether our own `/package.json` actually
// parses — not by matching the bundler's internal failure text.

// FIXTURE CORRECTION (load-bearing): the ClickUp ticket quotes Sentry's
// `error.value` as
//   "...(reading 'match'), Tier-1 compile failed"
// That trailing clause is NOT part of `e.message` as `describeRuntimeError` receives
// it. `App.tsx` reports the Tier-1 case as
// `new Error(report.synthesizeAs.message, { cause: e })`, so Sentry is rendering the
// cause chain — "Tier-1 compile failed" is `COMPILE_TITLE`, the synthesized error's
// own message, not the runtime error's. What actually reaches
// `describeRuntimeError`/`describeDependencyFailure` is the bounded `show-error`
// text below, WITHOUT that tail. The regex this module gates on matches either way,
// which is exactly why using the verbatim, untailed string matters here: a fixture
// with the tail baked in would still pass even if the module accidentally depended
// on text that never reaches it in production.
const MANIFEST_BUNDLER_MESSAGE =
  "Could not fetch dependencies, please try again in a couple seconds: Cannot read properties of null (reading 'match')";

// The other real production wording for the actual unpublished-version case — pinned
// already by pipeline/sandpack-reload.test.mjs's
// "DEV-2550: the dependency-fetch message reaches describeRuntimeError intact" test.
const VERSION_BUNDLER_MESSAGE =
  "Could not fetch dependencies, please try again in a couple seconds: request to https://registry.npmjs.org/handsontable failed";

// A mid-keystroke broken manifest: a trailing comma inside `dependencies`, exactly
// the shape a visitor produces while still typing.
const BROKEN_PACKAGE_JSON = `{
  "name": "demo",
  "dependencies": {
    "handsontable": "14.0.0",
  }
}
`;

const VALID_PACKAGE_JSON = `{
  "name": "demo",
  "dependencies": {
    "handsontable": "99.0.0"
  }
}
`;

const facts = (over = {}) => ({
  engine: "sandpack",
  message: MANIFEST_BUNDLER_MESSAGE,
  version: "99.0.0",
  packageJson: BROKEN_PACKAGE_JSON,
  ...over,
});

// Fix-prover: with the manifest branch removed (revert baseline), this fails —
// the module would return the npm sentence for a broken manifest instead of naming
// the JSON problem.
test("a broken manifest gets the JSON sentence, not the npm one (DEV-2872 fix-prover)", () => {
  const msg = describeDependencyFailure(facts());
  assert.match(msg, /is not valid JSON/);
  assert.doesNotMatch(msg, /published on npm/);
});

// Fix-prover: the parse detail must travel into the message. Computed by the TEST's
// own try/catch over the SAME fixture, never a hardcoded V8 string — JSON parse
// wording is engine-specific (see dependencyFailure.ts's docblock, and
// fetchFailure.ts's documented Chrome/Firefox/Safari divergence for the same kind of
// caution).
test("the JSON.parse detail travels into the message (DEV-2872 fix-prover)", () => {
  let detail;
  try {
    JSON.parse(BROKEN_PACKAGE_JSON);
    assert.fail("fixture must actually be invalid JSON");
  } catch (e) {
    detail = e.message;
  }
  const msg = describeDependencyFailure(facts());
  assert.ok(detail.length > 0, "the fixture must produce a real parse error");
  assert.ok(msg.includes(detail), `expected the message to include the parse detail: ${detail}`);
});

// Guard: a valid manifest plus the unpublished-version wording still gets the npm
// sentence, byte-for-byte — this module must not perturb the case DEV-2872 says to
// preserve.
test("a valid manifest with the unpublished-version wording keeps the npm sentence (guard)", () => {
  const msg = describeDependencyFailure(
    facts({ message: VERSION_BUNDLER_MESSAGE, packageJson: VALID_PACKAGE_JSON, version: "99.0.0" }),
  );
  assert.equal(msg, "Handsontable 99.0.0 could not be fetched. Check that this exact version is published on npm.");
});

// Guard: a message that isn't the "could not fetch dependencies" wording at all is
// not this module's branch, regardless of manifest state — the entry gate must still
// key on Sandpack's own wording.
test("a broken manifest with an unrelated (babel code-frame) message is not this branch (guard)", () => {
  const msg = describeDependencyFailure(
    facts({ message: "/src/main.ts: Unexpected token (3:1)" }),
  );
  assert.equal(msg, null);
});

// Guard: the container engine (Tier 2, DEV-2538/DEV-2553/DEMOS-9) must never be
// perturbed by this module, even with a matching message and a broken manifest.
// Pinned separately from pipeline/session-start-failure.test.mjs, which owns that
// contract's other end.
test("the container engine is never this branch (guard, DEV-2538 contract)", () => {
  const msg = describeDependencyFailure(facts({ engine: "container" }));
  assert.equal(msg, null);
});

// Guard: an absent /package.json (deliberate status-quo preservation) keeps the npm
// sentence, same as before this module existed.
test("an absent /package.json keeps the npm sentence (guard)", () => {
  const msg = describeDependencyFailure(facts({ packageJson: undefined }));
  assert.equal(msg, "Handsontable 99.0.0 could not be fetched. Check that this exact version is published on npm.");
});
