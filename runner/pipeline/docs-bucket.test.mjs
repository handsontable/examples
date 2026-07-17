import test from "node:test";
import assert from "node:assert/strict";
import { resolveDocsBucket } from "../packages/runtime/dist/docs-bucket.js";

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
