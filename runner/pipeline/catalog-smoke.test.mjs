// Smoke test for the committed docs-examples catalog snapshot. Validates that
// every manifest entry has the fields the UI needs and points at a runnable
// artifact (parseable JSON, package.json present, declared entry in files).
// Run: node --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(dir, "..", "apps", "authoring", "public", "docs-examples");

function loadBucketManifests() {
  return fs.readdirSync(OUT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      bucketDir: path.join(OUT, entry.name),
      manifest: JSON.parse(fs.readFileSync(path.join(OUT, entry.name, "manifest.json"), "utf8")),
    }));
}

test("bucket manifests exist and are well-formed", () => {
  const buckets = loadBucketManifests();
  assert.ok(buckets.length > 0, "has bucket manifests");
  for (const { bucketDir, manifest: m } of buckets) {
    const bucket = path.basename(bucketDir);
    assert.equal(m.bucket, bucket, `${bucket}: bucket matches directory`);
    assert.ok(Array.isArray(m.examples), `${bucket}: examples is an array`);
    assert.ok(m.examples.length > 0, `${bucket}: has examples`);
    assert.equal(m.count, m.examples.length, `${bucket}: count matches examples length`);
  }
});

test("every manifest entry has the required metadata fields", () => {
  const required = ["bucket", "docsPath", "file", "framework", "exampleId", "exampleTitle", "breadcrumb", "docPermalink"];
  const problems = [];
  for (const { bucketDir, manifest: m } of loadBucketManifests()) {
    const bucket = path.basename(bucketDir);
    for (const e of m.examples) {
      for (const f of required) {
        if (e[f] === undefined || e[f] === null) problems.push(`${bucket}/${e.docsPath || "?"}: missing ${f}`);
      }
      if (e.bucket !== bucket) problems.push(`${bucket}/${e.docsPath}: entry bucket is ${e.bucket}`);
      if (Array.isArray(e.breadcrumb) && e.breadcrumb.length === 0) problems.push(`${bucket}/${e.docsPath}: empty breadcrumb`);
    }
  }
  assert.equal(problems.length, 0, "field problems:\n" + problems.slice(0, 25).join("\n"));
});

test("every bucket entry points at a bucket-local runnable artifact", () => {
  const problems = [];
  for (const { bucketDir, manifest: m } of loadBucketManifests()) {
    const bucket = path.basename(bucketDir);
    for (const e of m.examples) {
      const p = path.join(bucketDir, e.file);
      if (!fs.existsSync(p)) { problems.push(`${bucket}/${e.docsPath}: artifact ${e.file} missing`); continue; }
      let entry;
      try {
        entry = JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {
        problems.push(`${bucket}/${e.docsPath}: artifact is not valid JSON`);
        continue;
      }
      if (!entry.files || !entry.files["/package.json"]) {
        problems.push(`${bucket}/${e.docsPath}: no /package.json in files`);
      } else {
        try { JSON.parse(entry.files["/package.json"]); }
        catch { problems.push(`${bucket}/${e.docsPath}: /package.json is not valid JSON`); }
      }
      const hasEntry =
        entry.files &&
        (entry.files[entry.entry] !== undefined ||
          (entry.htmlEntry && entry.files[entry.htmlEntry] !== undefined));
      if (!hasEntry) problems.push(`${bucket}/${e.docsPath}: entry ${entry.entry} / ${entry.htmlEntry} not among files`);
      if (!["sandpack", "container"].includes(entry.engine)) problems.push(`${bucket}/${e.docsPath}: bad engine ${entry.engine}`);
    }
  }
  assert.equal(problems.length, 0, `${problems.length} artifact problems:\n` + problems.slice(0, 25).join("\n"));
});
