import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveDocsBucketCandidate,
  resolveDocsBucket,
  planDocsBucket,
  highestReleaseBucket,
  docsBucketAbsentMessage,
} from "../packages/runtime/dist/docs-bucket.js";

test("derives next for an exact dist-tags.next version", () => {
  assert.equal(
    deriveDocsBucketCandidate("19.0.0-next.1", "19.0.0-next.1"),
    "next",
  );
});

test("derives major.minor for a valid semver release", () => {
  assert.equal(
    deriveDocsBucketCandidate("18.0.4", "19.0.0-next.1"),
    "18.0",
  );
});

test("returns null candidate for a malformed selected version", () => {
  assert.equal(
    deriveDocsBucketCandidate("not-a-version", "19.0.0-next.1"),
    null,
  );
});

test("selects next only for an exact dist-tags.next version", () => {
  assert.equal(
    resolveDocsBucket({
      selectedVersion: "19.0.0-next.1",
      nextVersion: "19.0.0-next.1",
      bucketKeys: ["18.0", "next"],
    }),
    "next",
  );
});

test("selects the matching major.minor release bucket", () => {
  assert.equal(
    resolveDocsBucket({
      selectedVersion: "18.0.4",
      nextVersion: "19.0.0-next.1",
      bucketKeys: ["18.0", "next"],
    }),
    "18.0",
  );
});

test("returns null for a version with no matching bucket", () => {
  assert.equal(
    resolveDocsBucket({
      selectedVersion: "17.1.3",
      nextVersion: "19.0.0-next.1",
      bucketKeys: ["18.0", "next"],
    }),
    null,
  );
});

test("does not fall back to next when a release bucket is absent", () => {
  assert.equal(
    resolveDocsBucket({
      selectedVersion: "17.1.3",
      nextVersion: "19.0.0-next.1",
      bucketKeys: ["next"],
    }),
    null,
  );
});

test("returns null for a malformed selected version", () => {
  assert.equal(
    resolveDocsBucket({
      selectedVersion: "not-a-version",
      nextVersion: "19.0.0-next.1",
      bucketKeys: ["18.0", "next"],
    }),
    null,
  );
});

// DEMOS-1C: resolveDocsBucket's null-for-absent-bucket contract above is
// already correct and already tested — it is not the discriminating case for
// this fix. Nothing consumed that null before now; these tests are new
// contract: what the caller does with the absence (planDocsBucket), and what
// the visitor is told (docsBucketAbsentMessage).

test("planDocsBucket computes a suggestion when the bucket is absent", () => {
  assert.deepEqual(
    planDocsBucket({
      selectedVersion: "17.1.0",
      nextVersion: "0.0.0-next-x-1",
      bucketKeys: ["18.0", "next"],
    }),
    { kind: "absent", bucket: null, suggestion: "18.0" },
  );
});

test("planDocsBucket never suggests next (ADR-0021 #2)", () => {
  assert.equal(
    planDocsBucket({
      selectedVersion: "17.1.0",
      nextVersion: "0.0.0-next-x-1",
      bucketKeys: ["next"],
    }).suggestion,
    null,
  );
});

test("highestReleaseBucket ranks major.minor numerically, not lexically", () => {
  assert.equal(highestReleaseBucket(["9.0", "18.0", "17.1", "next"]), "18.0");
});

test("planDocsBucket resolves a matching version and suggests nothing", () => {
  assert.deepEqual(
    planDocsBucket({
      selectedVersion: "18.0.4",
      nextVersion: "0.0.0-next-x-1",
      bucketKeys: ["18.0", "next"],
    }),
    { kind: "resolved", bucket: "18.0", suggestion: null },
  );
});

test("docsBucketAbsentMessage names both the selected version and one that works", () => {
  const msg = docsBucketAbsentMessage("17.1.0", "18.0");
  assert.match(msg, /17\.1\.0/); // what they picked
  assert.match(msg, /18\.0/); // what would work -- the discriminating assertion
});

test("docsBucketAbsentMessage degrades honestly when nothing would work", () => {
  const bare = docsBucketAbsentMessage("17.1.0", null);
  assert.doesNotMatch(bare, /switch versions/);
});
