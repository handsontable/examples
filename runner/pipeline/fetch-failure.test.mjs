import test from "node:test";
import assert from "node:assert/strict";
import { isOpaqueNetworkFailure } from "../apps/authoring/src/fetchFailure.ts";

// Sentry DEMOS-2X / DEMOS-2Y. `fetchVersions` and `loadStarterExample` both raise
// `TypeError: Failed to fetch` when the tab's own network drops mid-request — not a
// shape our host can produce at these same-origin callsites (see fetchFailure.ts).
// The four `false` rows below are the point: they pin that a host-side failure (a
// Worker 5xx, a 404, or Workers-Assets' SPA-fallback HTML tripping res.json()) keeps
// reporting, so this demotion narrows to the visitor-network population only.

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

test("does not classify a non-Error value", () => {
  assert.equal(isOpaqueNetworkFailure("Failed to fetch"), false);
  assert.equal(isOpaqueNetworkFailure(null), false);
  assert.equal(isOpaqueNetworkFailure(undefined), false);
});
