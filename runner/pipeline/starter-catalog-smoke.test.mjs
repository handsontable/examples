// Smoke test for the committed starter-examples bucket snapshot (DEV-2213)
// and the catalog.json index. Validates bucket membership against the
// frameworks.json minCoreMajor floors, artifact runnability, version pinning,
// and that the index carries no inlined files.
// Run: node --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.resolve(dir, "..");
const OUT = path.join(RUNNER_DIR, "apps", "authoring", "public", "starter-examples");
const FRAMEWORKS = JSON.parse(
  fs.readFileSync(path.join(RUNNER_DIR, "config", "frameworks.json"), "utf8"),
).frameworks;
const CONCRETE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function loadBucketManifests() {
  return fs.readdirSync(OUT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      bucket: entry.name,
      bucketDir: path.join(OUT, entry.name),
      manifest: JSON.parse(fs.readFileSync(path.join(OUT, entry.name, "manifest.json"), "utf8")),
    }));
}

test("starter bucket manifests exist and are well-formed", () => {
  const buckets = loadBucketManifests();
  assert.ok(buckets.length > 0, "has bucket manifests");
  for (const { bucket, manifest: m } of buckets) {
    assert.equal(m.bucket, bucket, `${bucket}: bucket matches directory`);
    assert.ok(/^(?:\d+|next)$/.test(bucket), `${bucket}: valid bucket key`);
    assert.ok(typeof m.sourceRef === "string" && m.sourceRef.length > 0, `${bucket}: has sourceRef`);
    assert.ok(CONCRETE_VERSION_RE.test(m.hotVersion), `${bucket}: concrete hotVersion (${m.hotVersion})`);
    assert.ok(Array.isArray(m.examples) && m.examples.length > 0, `${bucket}: has examples`);
    assert.equal(m.count, m.examples.length, `${bucket}: count matches examples length`);
  }
});

test("bucket membership matches the frameworks.json minCoreMajor floors", () => {
  for (const { bucket, manifest: m } of loadBucketManifests()) {
    const expected = Object.keys(FRAMEWORKS).filter((f) =>
      bucket === "next" ? true : (FRAMEWORKS[f].minCoreMajor ?? 0) <= Number(bucket),
    );
    assert.deepEqual(
      m.examples.map((e) => e.framework).sort(),
      expected.sort(),
      `${bucket}: membership`,
    );
  }
});

test("every starter artifact is runnable and pinned to the bucket hotVersion", () => {
  const problems = [];
  for (const { bucket, bucketDir, manifest: m } of loadBucketManifests()) {
    for (const e of m.examples) {
      const p = path.join(bucketDir, `${e.framework}.json`);
      if (!fs.existsSync(p)) { problems.push(`${bucket}/${e.framework}: artifact missing`); continue; }
      let entry;
      try {
        entry = JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {
        problems.push(`${bucket}/${e.framework}: artifact is not valid JSON`);
        continue;
      }
      if (entry.htCoreRange !== m.hotVersion) {
        problems.push(`${bucket}/${e.framework}: htCoreRange ${entry.htCoreRange} != manifest hotVersion`);
      }
      if (!entry.files?.["/package.json"]) {
        problems.push(`${bucket}/${e.framework}: no /package.json in files`);
      } else {
        try {
          const deps = JSON.parse(entry.files["/package.json"]).dependencies ?? {};
          for (const [name, range] of Object.entries(deps)) {
            if (name.includes("handsontable") && name !== "@handsontable/pikaday" && range !== m.hotVersion) {
              problems.push(`${bucket}/${e.framework}: ${name}@${range} not pinned to ${m.hotVersion}`);
            }
          }
        } catch {
          problems.push(`${bucket}/${e.framework}: /package.json is not valid JSON`);
        }
      }
      if (!entry.files?.["/pnpm-lock.yaml"]) {
        problems.push(`${bucket}/${e.framework}: no /pnpm-lock.yaml (frozen installs impossible)`);
      }
      const hasEntry =
        entry.files &&
        (entry.files[entry.entry] !== undefined ||
          (entry.assets ?? []).includes(entry.entry.slice(1)) ||
          (entry.htmlEntry && entry.files[entry.htmlEntry] !== undefined));
      if (!hasEntry) problems.push(`${bucket}/${e.framework}: entry ${entry.entry} not among files`);
      if (!["sandpack", "container"].includes(entry.engine)) problems.push(`${bucket}/${e.framework}: bad engine ${entry.engine}`);
    }
  }
  assert.equal(problems.length, 0, `${problems.length} artifact problems:\n` + problems.slice(0, 25).join("\n"));
});

test("catalog.json is an index: buckets match dirs, entries carry no files", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, "catalog.json"), "utf8"));
  const dirs = loadBucketManifests().map((b) => b.bucket).sort();
  assert.deepEqual([...catalog.buckets].sort(), dirs, "index buckets match bucket directories");
  assert.deepEqual(
    catalog.examples.map((e) => e.framework).sort(),
    Object.keys(FRAMEWORKS).sort(),
    "index lists every configured framework",
  );
  for (const entry of catalog.examples) {
    assert.equal("files" in entry, false, `${entry.framework}: index entry must not inline files`);
  }
});
