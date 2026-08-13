import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bucketFrameworks, importStarters, writeCatalogIndex } from "./import.mjs";
import { applyHandsontableVersion } from "../packages/runtime/dist/version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const EXAMPLES_DIR = path.join(REPO_ROOT, "examples");
const FRAMEWORKS = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "runner", "config", "frameworks.json"), "utf8"),
).frameworks;

// Tests import from the real examples/ tree with hotVersion injected and the
// lockfile regeneration stubbed, so they stay offline and pnpm-free.
const passthroughLock = ({ files }) => files["/pnpm-lock.yaml"];

function makeOutDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "starter-buckets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("regenerating a bucket preserves a sibling bucket", async (t) => {
  const outDir = makeOutDir(t);
  const nextDir = path.join(outDir, "next");
  fs.mkdirSync(nextDir, { recursive: true });
  fs.writeFileSync(path.join(nextDir, "manifest.json"), '{"sentinel":"next"}\n');
  fs.mkdirSync(path.join(outDir, "18"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "18", "stale.json"), "stale");

  await importStarters({
    bucket: "18",
    ref: "master",
    outDir,
    hotVersion: "18.0.0",
    regenLockfile: passthroughLock,
  });

  assert.equal(fs.readFileSync(path.join(nextDir, "manifest.json"), "utf8"), '{"sentinel":"next"}\n');
  assert.equal(fs.existsSync(path.join(outDir, "18", "stale.json")), false);

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "18", "manifest.json"), "utf8"));
  assert.equal(manifest.bucket, "18");
  assert.equal(manifest.sourceRef, "master");
  assert.equal(manifest.hotVersion, "18.0.0");
  assert.equal(manifest.count, manifest.examples.length);
});

test("bucket membership respects the minCoreMajor floor", () => {
  const all = Object.keys(FRAMEWORKS);
  const floored = all.filter((f) => (FRAMEWORKS[f].minCoreMajor ?? 0) > 15);

  const b15 = bucketFrameworks("15");
  assert.equal(b15.length, all.length - floored.length);
  for (const f of floored) assert.equal(b15.includes(f), false, `${f} must not be in bucket 15`);

  // "next" tracks current dev — every floor is satisfied.
  assert.deepEqual(bucketFrameworks("next"), all);
});

test("artifacts pin every Handsontable dependency to the bucket hotVersion", async (t) => {
  const outDir = makeOutDir(t);
  await importStarters({
    bucket: "15",
    outDir,
    hotVersion: "15.3.0",
    regenLockfile: passthroughLock,
  });

  for (const row of JSON.parse(fs.readFileSync(path.join(outDir, "15", "manifest.json"), "utf8")).examples) {
    const artifact = JSON.parse(fs.readFileSync(path.join(outDir, "15", `${row.framework}.json`), "utf8"));
    assert.equal(artifact.htCoreRange, "15.3.0");
    const deps = JSON.parse(artifact.files["/package.json"]).dependencies ?? {};
    for (const [name, range] of Object.entries(deps)) {
      if (name.includes("handsontable") && name !== "@handsontable/pikaday") {
        assert.equal(range, "15.3.0", `${row.framework}: ${name} must be pinned`);
      }
    }
  }
});

test("the runtime version rewrite is a byte-level no-op on emitted artifacts", async (t) => {
  // Load-bearing for the Tier-2 frozen-install fast path: ContainerRuntime
  // re-applies applyHandsontableVersion at mount, and the API's fingerprint
  // check only passes when that re-application changes nothing.
  const outDir = makeOutDir(t);
  await importStarters({
    bucket: "18",
    outDir,
    hotVersion: "18.0.0",
    regenLockfile: passthroughLock,
  });

  for (const row of JSON.parse(fs.readFileSync(path.join(outDir, "18", "manifest.json"), "utf8")).examples) {
    const artifact = JSON.parse(fs.readFileSync(path.join(outDir, "18", `${row.framework}.json`), "utf8"));
    const reapplied = applyHandsontableVersion(artifact.files, { ref: "18.0.0", pkgPrNew: false });
    assert.equal(
      reapplied["/package.json"],
      artifact.files["/package.json"],
      `${row.framework}: package.json must be byte-stable under the runtime rewrite`,
    );
  }
});

test("the catalog index lists buckets and drops files from every entry", async (t) => {
  const outDir = makeOutDir(t);
  await importStarters({ bucket: "next", outDir, hotVersion: "0.0.0-next-abc1234-20260801", regenLockfile: passthroughLock });
  await importStarters({ bucket: "15", outDir, hotVersion: "15.3.0", regenLockfile: passthroughLock });

  const indexPath = path.join(outDir, "catalog.json");
  const catalog = writeCatalogIndex({ outDir, indexPath });

  assert.deepEqual(catalog.buckets, ["15", "next"]);
  assert.equal(catalog.examples.length, Object.keys(FRAMEWORKS).length);
  for (const entry of catalog.examples) {
    assert.equal("files" in entry, false, `${entry.framework}: index entry must not inline files`);
    assert.equal("htCoreRange" in entry, false, `${entry.framework}: htCoreRange is per-bucket`);
    assert.equal(typeof entry.installCommand, "string");
  }
  assert.equal(fs.existsSync(indexPath), true);
});

test("refuses a malformed bucket key", async () => {
  await assert.rejects(
    importStarters({ bucket: "18.0", outDir: "/nonexistent", hotVersion: "18.0.0" }),
    /--bucket is required/,
  );
});

// EXAMPLES_DIR is the default source; assert it holds every configured starter
// so a renamed directory fails here rather than mid-import. Synthetic starters
// (the blank templates) are generated, so they must NOT have one — a directory
// appearing under that name would be silently ignored by the importer.
test("every configured framework has a source directory, and no synthetic one does", () => {
  for (const [framework, cfg] of Object.entries(FRAMEWORKS)) {
    assert.equal(
      fs.existsSync(path.join(EXAMPLES_DIR, framework)),
      !cfg.synthetic,
      framework,
    );
  }
});
