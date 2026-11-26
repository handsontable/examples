import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newestReleaseBucket } from "../scripts/release-bucket.mjs";

// The container seed and the warm script follow the newest release bucket, so a new major's
// bucket becomes the baked one in the same generated PR that adds it.

test("picks the highest major holding a stable release, numerically", () => {
  assert.equal(newestReleaseBucket({ 9: "9.0.0", 15: "15.3.0", 18: "18.1.3", next: "0.0.0-next-abc-20261126" }), "18");
  assert.equal(newestReleaseBucket({ 18: "18.1.3", 19: "19.0.0" }), "19");
  assert.equal(newestReleaseBucket({ 18: "18.1.3", 19: "19.0.0-rc1" }), "18", "a prerelease is not a release");
});

test("refuses a catalog with no release bucket", () => {
  assert.throws(() => newestReleaseBucket({ next: "0.0.0-next-abc-20261126" }), /no release bucket/);
  assert.throws(() => newestReleaseBucket(undefined), /no release bucket/);
});

test("the committed container seed is the newest release bucket", () => {
  const { bucketVersions } = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
  const generated = readFileSync(new URL("../workers/api/src/frameworks.generated.ts", import.meta.url), "utf8");
  const seeds = new Set([...generated.matchAll(/defaultBakedKey: "[a-z0-9-]+-(\d+)"/g)].map((m) => m[1]));
  assert.deepEqual([...seeds], [newestReleaseBucket(bucketVersions)], "run `node scripts/prepare-container.mjs`");
});
