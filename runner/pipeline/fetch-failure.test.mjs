import test from "node:test";
import assert from "node:assert/strict";
import { isOpaqueNetworkFailure } from "../apps/authoring/src/fetchFailure.ts";

// Sentry DEMOS-2X / DEMOS-2Y. `fetchVersions` and `loadStarterExample` both raise
// `TypeError: Failed to fetch` when the tab's own network drops mid-request — not a
// shape our host can produce at these same-origin callsites (see fetchFailure.ts).
// The `false` rows below are the point: they pin that a host-side failure (a
// Worker 5xx, a 404, or Workers-Assets' SPA-fallback HTML tripping res.json()) keeps
// reporting, so this demotion narrows to the visitor-network population only.

// Fix-prover (DEV-2859): the real production wording, verbatim from Sentry DEMOS-2X's
// latest events (2026-09-08, releases `930f6a52` and `e32cdcdf` — both after the
// `^failed to fetch$` gate landed in 590cb58b2 / PR #274). This is the string that
// proves the gate never actually fired: with the anchored-no-suffix pattern reverted,
// this assertion goes red.
test("classifies the real production wording with the host suffix (Sentry DEMOS-2X, DEV-2859)", () => {
  assert.equal(
    isOpaqueNetworkFailure(new TypeError("Failed to fetch (demos.handsontable.com)")),
    true,
  );
});

// Regression guard: the bare wording (no host suffix) must keep matching too — this
// passes both before and after DEV-2859, it just must not regress.
test("classifies the observed Chrome wording (route.abort('failed'), Step 0a)", () => {
  assert.equal(isOpaqueNetworkFailure(new TypeError("Failed to fetch")), true);
});

test("classifies the Firefox wording", () => {
  assert.equal(
    isOpaqueNetworkFailure(new TypeError("NetworkError when attempting to fetch resource.")),
    true,
  );
});

test("classifies the Safari wording", () => {
  assert.equal(isOpaqueNetworkFailure(new TypeError("Load failed")), true);
});

test("does not classify a Worker-outage response error (must keep reporting)", () => {
  assert.equal(isOpaqueNetworkFailure(new Error("versions 503")), false);
});

test("does not classify a starter-not-found 404 (must keep reporting)", () => {
  assert.equal(
    isOpaqueNetworkFailure(new Error('starter not found: react in bucket "18" (404)')),
    false,
  );
});

test("does not classify an SPA-fallback JSON parse failure (must keep reporting)", () => {
  assert.equal(isOpaqueNetworkFailure(new SyntaxError("Unexpected token '<'")), false);
});

test("does not classify a genuine TypeError programming fault", () => {
  assert.equal(isOpaqueNetworkFailure(new TypeError("res.json is not a function")), false);
});

test("does not classify a deploy-rotated dynamic-import chunk failure (Sentry DEMOS-15 / DEV-2569, must keep reporting)", () => {
  // Real Chromium wording for a rotated compiler chunk under SPA fallback
  // (packages/runtime/src/transpile.ts) — an unanchored `/failed to fetch/i` would
  // have matched this as a substring and silenced an unrelated host defect class.
  assert.equal(
    isOpaqueNetworkFailure(
      new TypeError(
        "Failed to fetch dynamically imported module: https://demos.handsontable.com/assets/babel-CRE6e0VF.js",
      ),
    ),
    false,
  );
});

// Anchor guard (DEV-2859): the parenthesised suffix must be the END of the message.
// Proves the trailing `$` still binds after the new optional group, not just the `^`.
test("does not classify a suffix that isn't at the end of the message", () => {
  assert.equal(
    isOpaqueNetworkFailure(new TypeError("Failed to fetch (demos.handsontable.com) extra")),
    false,
  );
});

test("does not classify a non-Error value", () => {
  assert.equal(isOpaqueNetworkFailure("Failed to fetch"), false);
  assert.equal(isOpaqueNetworkFailure(null), false);
  assert.equal(isOpaqueNetworkFailure(undefined), false);
});
