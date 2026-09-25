// The §5 `snapshot.build` point's `bytes` field was never populated on either
// build path — `withSnapshotBuildPoint` (share.ts) always emitted `{ count,
// duration_ms }`, with no `bytes` key at all, so the field stayed permanently
// absent (0/undefined) in every real point this Worker has ever written,
// regardless of whether the built artifact was 2 KB or 20 MB.
//
// Fix: `withSnapshotBuildPoint` hands its callback an `addBytes` accumulator;
// `createDemo`/`updateDemo` call it with the real byte length of every object
// they write to R2 (a fresh build's own output, or a `build_cache` hit's
// copied objects — `R2Object.size`), and the point's `bytes` field carries the
// running total.
//
// Companion to `snapshot-build-point.test.mjs` (F25's own test, which proved
// the point fires at all) — this proves the one field that test never checked.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/snapshot-build-bytes.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { makeEnv } from "./fixtures/worker-harness.mjs";
import { setSandboxFactory } from "./fixtures/cloudflare-sandbox-stub.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { createDemo, updateDemo } = await import("../workers/api/src/share.ts");

const ENTRY = {
  framework: "javascript",
  tier: 1,
  installCommand: "pnpm install --frozen-lockfile",
  buildCommand: "vite build",
  outputDir: "dist",
  outputGlob: null,
  entry: "/index.js",
  htmlEntry: "/index.html",
};
const FILES = { "/package.json": JSON.stringify({ dependencies: { handsontable: "18.1.0" } }) };

// Deliberately uneven lengths so a bug that reports only the LAST file's size,
// or a hardcoded file count instead of a real sum, cannot pass by accident.
const BUILT = {
  "index.html": "<!doctype html><html><body>hello, bytes</body></html>",
  "assets/index-a1b2c3.js": "console.log('a real, if tiny, bundle');",
};
const EXPECTED_BYTES = Object.values(BUILT).reduce((n, s) => n + new TextEncoder().encode(s).length, 0);

/** A sandbox whose install and build both succeed and whose `dist/` holds `BUILT`,
 *  with real (non-empty, differently-sized) per-file content — `snapshot-build.
 *  test.mjs`'s own `buildEmitting` always answers `readFile` with `""`, which
 *  would make every file 0 bytes and pass a `bytes` field that is silently
 *  wrong just as easily as one that's silently absent. */
function buildEmitting(built) {
  return () => ({
    mkdir: async () => {},
    writeFile: async () => {},
    async readFile(path) {
      const rel = Object.keys(built).find((r) => path.endsWith(r));
      return rel ? built[rel] : "";
    },
    destroy: async () => {},
    async exec(cmd) {
      if (cmd.includes("find . -type f")) {
        return { success: true, exitCode: 0, stdout: Object.keys(built).map((r) => `./${r}`).join("\n") };
      }
      return { success: true, exitCode: 0, stdout: "", stderr: "" };
    },
  });
}

function envWithPointCapture(opts, seedArtifacts = {}) {
  const points = [];
  const { env, ...rest } = makeEnv([], [], seedArtifacts, opts);
  env.RUNNER_EVENTS = { writeDataPoint: (p) => points.push(p) };
  env.PREVIEW_HOST = "demos.handsontable.com";
  return { env, points, ...rest };
}

function snapshotBuildPoints(points) {
  return points.filter((p) => p.indexes[0] === "snapshot.build");
}

// §4 (AE_COLUMNS, packages/runtime/src/telemetry/metrics.ts): bytes=double7
// (index 6) — a fixed slot shared by every metric that measures it, same as
// count=double1 (index 0) and duration_ms=double2 (index 1), the two
// `snapshot-build-point.test.mjs` already asserts on.
const BYTES_SLOT = 6;

test("createDemo (fresh build, no cache) reports the real total bytes written to R2", async () => {
  setSandboxFactory(buildEmitting(BUILT));
  try {
    const { env, points } = envWithPointCapture({ buildCacheHit: false });
    await createDemo(env, {
      entry: ENTRY,
      files: FILES,
      htVersion: "18.1.0",
      title: "A demo",
      createdBy: "dev@handsontable.com",
      now: new Date().toISOString(),
    });
    const sb = snapshotBuildPoints(points);
    assert.equal(sb.length, 1);
    assert.equal(sb[0].blobs[7], "ok"); // outcome
    assert.ok(EXPECTED_BYTES > 0, "sanity: the fixture itself is non-empty");
    assert.equal(sb[0].doubles[BYTES_SLOT], EXPECTED_BYTES);
  } finally {
    setSandboxFactory(null);
  }
});

test("updateDemo (fresh build, no cache) reports the real total bytes written to R2", async () => {
  setSandboxFactory(buildEmitting(BUILT));
  try {
    const { env, points } = envWithPointCapture(
      { buildCacheHit: false },
    );
    // Seed the row updateDemo expects to find.
    const seeded = makeEnv(
      [{ id: "abc123", framework: "javascript", tier: 1, ht_version: "18.1.0", files_hash: "old", r2_prefix: "demos/abc123/" }],
      [],
      {},
      { buildCacheHit: false },
    );
    seeded.env.RUNNER_EVENTS = env.RUNNER_EVENTS;
    seeded.env.PREVIEW_HOST = env.PREVIEW_HOST;
    await updateDemo(seeded.env, {
      id: "abc123",
      entry: ENTRY,
      files: FILES,
      htVersion: "18.1.0",
      now: new Date().toISOString(),
    });
    const sb = snapshotBuildPoints(points);
    assert.equal(sb.length, 1);
    assert.equal(sb[0].blobs[7], "ok");
    assert.equal(sb[0].doubles[BYTES_SLOT], EXPECTED_BYTES);
  } finally {
    setSandboxFactory(null);
  }
});

test("createDemo (build_cache hit) counts the copied artifact's bytes but not __source.json's", async () => {
  // `fixtures/worker-harness.mjs`'s `fakeD1`, on a cache hit, always answers
  // `{ r2_prefix: "demos/_prior-identical-build/" }` — see its own comment.
  const CACHED_PREFIX = "demos/_prior-identical-build/";
  const seedArtifacts = {
    [`${CACHED_PREFIX}index.html`]: "<!doctype html><html><body>the real artifact</body></html>",
    // A prior demo's private source snapshot, sitting in the same cached
    // directory (share.ts writes one next to every build). Deliberately
    // larger than the artifact above, so a regression that counts it would
    // move `bytes` by more than a rounding error — not just barely wrong.
    [`${CACHED_PREFIX}__source.json`]: JSON.stringify({
      framework: "javascript",
      files: { "/src/app.js": "x".repeat(1000) },
    }),
  };
  const { env, points } = envWithPointCapture({ buildCacheHit: true }, seedArtifacts);
  // `fakeR2.list()` always answers `{ objects: [] }` (a harness limitation
  // unrelated to this fix — see snapshot-build-point.test.mjs's own cache-hit
  // tests, which never reach the copy loop for the same reason). Overridden
  // here, for this test only, so the copy loop this fix touches actually runs.
  env.ARTIFACTS.list = async ({ prefix }) => ({
    objects: Object.keys(seedArtifacts)
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key })),
  });

  await createDemo(env, {
    entry: ENTRY,
    files: FILES,
    htVersion: "18.1.0",
    title: "A demo",
    createdBy: "dev@handsontable.com",
    now: new Date().toISOString(),
  });

  const sb = snapshotBuildPoints(points);
  assert.equal(sb.length, 1);
  assert.equal(sb[0].blobs[7], "ok");
  const artifactBytes = new TextEncoder().encode(seedArtifacts[`${CACHED_PREFIX}index.html`]).length;
  assert.ok(artifactBytes > 0, "sanity: the fixture artifact is non-empty");
  assert.equal(
    sb[0].doubles[BYTES_SLOT],
    artifactBytes,
    "must equal the copied artifact's own bytes, excluding the copied __source.json",
  );
});

// A guard test, not revert-check evidence for the fix itself (the three tests
// above already carry that: bytes was always 0/absent before the fix, so this
// assertion holds either way). Kept anyway — it pins the "never positive on
// failure" direction against a future change to the failure path specifically,
// which the other tests don't exercise.
test("a failed build reports bytes as 0 (or absent), never a partial/wrong total", async () => {
  setSandboxFactory(() => ({
    mkdir: async () => {},
    writeFile: async () => {},
    readFile: async () => "",
    destroy: async () => {},
    async exec(cmd) {
      if (cmd.includes("install")) return { success: true, exitCode: 0, stdout: "", stderr: "" };
      return { success: false, exitCode: 1, stdout: "", stderr: "build blew up" };
    },
  }));
  try {
    const { env, points } = envWithPointCapture({ buildCacheHit: false });
    await assert.rejects(() =>
      createDemo(env, {
        entry: ENTRY,
        files: FILES,
        htVersion: "18.1.0",
        title: "A demo",
        createdBy: "dev@handsontable.com",
        now: new Date().toISOString(),
      }),
    );
    const sb = snapshotBuildPoints(points);
    assert.equal(sb.length, 1);
    assert.equal(sb[0].blobs[7], "failed");
    assert.ok(!(sb[0].doubles[BYTES_SLOT] > 0), "a failed build never reports a positive byte count");
  } finally {
    setSandboxFactory(null);
  }
});
