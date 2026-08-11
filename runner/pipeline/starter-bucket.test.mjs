import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveStarterBucketCandidate,
  resolveStarterBucket,
} from "../packages/runtime/dist/docs-bucket.js";

test("derives next for an exact dist-tags.next version", () => {
  assert.equal(
    deriveStarterBucketCandidate("19.0.0-next.1", "19.0.0-next.1"),
    "next",
  );
});

test("derives next for any next-dist-tag prerelease build", () => {
  assert.equal(
    deriveStarterBucketCandidate("0.0.0-next-64139ae-20260219", "0.0.0-next-9999999-20260801"),
    "next",
  );
});

test("derives the major-only key for a valid semver release", () => {
  assert.equal(
    deriveStarterBucketCandidate("18.0.4", "19.0.0-next.1"),
    "18",
  );
});

test("returns null candidate for a malformed selected version", () => {
  assert.equal(
    deriveStarterBucketCandidate("not-a-version", "19.0.0-next.1"),
    null,
  );
});

test("selects next only for an exact dist-tags.next version", () => {
  assert.equal(
    resolveStarterBucket({
      selectedVersion: "19.0.0-next.1",
      nextVersion: "19.0.0-next.1",
      bucketKeys: ["15", "16", "17", "18", "next"],
    }),
    "next",
  );
});

test("selects the matching major release bucket", () => {
  assert.equal(
    resolveStarterBucket({
      selectedVersion: "17.1.3",
      nextVersion: "19.0.0-next.1",
      bucketKeys: ["15", "16", "17", "18", "next"],
    }),
    "17",
  );
});

test("returns null for a major with no bucket", () => {
  assert.equal(
    resolveStarterBucket({
      selectedVersion: "19.0.0",
      nextVersion: "20.0.0-next.1",
      bucketKeys: ["15", "16", "17", "18", "next"],
    }),
    null,
  );
});

test("does not fall back to next when a release bucket is absent", () => {
  assert.equal(
    resolveStarterBucket({
      selectedVersion: "15.3.0",
      nextVersion: "19.0.0-next.1",
      bucketKeys: ["18", "next"],
    }),
    null,
  );
});

test("returns null for a malformed selected version", () => {
  assert.equal(
    resolveStarterBucket({
      selectedVersion: "not-a-version",
      nextVersion: "19.0.0-next.1",
      bucketKeys: ["15", "16", "17", "18", "next"],
    }),
    null,
  );
});
