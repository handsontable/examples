// `stableBucketVersions` — the authoring app's version-picker fallback, derived
// from the committed bucket state instead of hand-typed (DEV-2735).
//
// The fallback is what the picker shows until `/api/versions` answers, and what
// it keeps showing when that fetch fails (App.tsx:1666). Before this it was a
// literal that nothing updated: it still offered 18.0.0/17.1.0/17.0.1 months
// after 18.1.0 shipped. Deriving it from `catalog.json`'s `bucketVersions` ties
// it to the weekly bucket re-pin, so a release moves it without a human.
//
// Lives in the runtime package rather than `apps/authoring/src/catalog.ts`
// because that module uses bare, attribute-less JSON imports and is Vite-only
// by design — node cannot load it, so the logic would be untestable there.
import test from "node:test";
import assert from "node:assert/strict";
import { stableBucketVersions } from "../packages/runtime/dist/version.js";

test("drops the next prerelease and orders newest first", () => {
  assert.deepEqual(
    stableBucketVersions({
      15: "15.3.0",
      16: "16.2.0",
      17: "17.1.0",
      18: "18.1.0",
      next: "0.0.0-next-962a9cf-20260902",
    }),
    ["18.1.0", "17.1.0", "16.2.0", "15.3.0"],
  );
});

test("orders numerically, not lexically", () => {
  // "9.0.0" > "10.0.0" as strings, and "18.9.0" > "18.10.0" — a plain sort()
  // would put the older release first and make it the default version.
  assert.deepEqual(
    stableBucketVersions({ 9: "9.0.0", 10: "10.0.0", 18: "18.9.0", 19: "18.10.0" }),
    ["18.10.0", "18.9.0", "10.0.0", "9.0.0"],
  );
});

test("ignores anything that is not an exact release", () => {
  assert.deepEqual(
    stableBucketVersions({ 17: "17.1.0", a: "^18.0.0", b: "latest", c: "19.0.0-next.1", d: "" }),
    ["17.1.0"],
  );
});

// Absent-and-silent is the same failure class this fix exists to remove: an
// empty VERSION_OPTIONS is an empty dropdown and a version-less first visit,
// which nothing would report. A throw at module load is visible.
test("refuses a map with nothing usable in it", () => {
  for (const bad of [undefined, null, {}, [], "18.1.0", { next: "0.0.0-next-abc1234-20260101" }]) {
    assert.throws(
      () => stableBucketVersions(bad),
      /bucketVersions/,
      `${JSON.stringify(bad) ?? "undefined"} must not yield an empty fallback`,
    );
  }
});
