// Smoke test for the committed docs-example bucket index (DEMOS-1C). The
// client statically imports runner/docs-buckets.json to know which docs
// buckets exist before it ever fetches a manifest — see
// apps/authoring/src/catalog.ts and App.tsx's use of `planDocsBucket`. A
// bucket directory added to public/docs-examples without regenerating this
// index would be invisible to the app, silently, with nothing else in CI to
// catch it. That is exactly what this test guards.
// Run: node --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.resolve(dir, "..");
const DOCS_EXAMPLES = path.join(RUNNER_DIR, "apps", "authoring", "public", "docs-examples");
const INDEX_PATH = path.join(RUNNER_DIR, "docs-buckets.json");

function onDiskBuckets() {
  return fs.readdirSync(DOCS_EXAMPLES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(DOCS_EXAMPLES, entry.name, "manifest.json")))
    .map((entry) => entry.name)
    .sort();
}

test("the committed docs-buckets.json equals the committed docs-examples directories", () => {
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  assert.deepEqual(index.buckets, onDiskBuckets());
});

test("the index and the release bucket's own manifest agree on the bucket key", () => {
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const releaseBucket = index.buckets.find((b) => b !== "next");
  assert.ok(releaseBucket, "at least one release bucket is committed");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(DOCS_EXAMPLES, releaseBucket, "manifest.json"), "utf8"),
  );
  assert.ok(index.buckets.includes(manifest.bucket));
});
