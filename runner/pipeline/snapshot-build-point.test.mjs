// F25 (fix round R4): the §5 `snapshot.build` point was only ever emitted on
// the detached DO alarm path (`snapshot-jobs.ts#runSnapshotJob`), with its
// own comment saying so explicitly: "the direct/synchronous build in
// index.ts (share creates, rebuilds) is inline and does not emit this point
// yet". `SELECT count() FROM runner_events WHERE index1='snapshot.build'`
// stayed 0 across a whole traffic run that DID run real `vite build`s (8x,
// in sandbox-build-<id> sessions during fork/save/share) — every one of them
// went through the synchronous `createDemo`/`updateDemo` in `share.ts`, not
// through the DO.
//
// The fix moves emission INTO `createDemo`/`updateDemo` themselves
// (`share.ts#withSnapshotBuildPoint`), so every caller gets exactly one
// `ok`/`failed` point regardless of whether it hit `build_cache` (a fast R2
// copy) or ran a real container build — timed end to end, tagged
// `reason: "inline"` by default (the synchronous request-path callers in
// index.ts) or `reason: "detached"` (passed explicitly by
// `snapshot-jobs.ts`'s alarm, which used to emit its own separate point;
// this specs that consolidation didn't turn into a double-emission).
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { makeEnv } from "./fixtures/worker-harness.mjs";
import { setSandboxFactory } from "./fixtures/cloudflare-sandbox-stub.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { createDemo, updateDemo } = await import("../workers/api/src/share.ts");
const { runSnapshotJob } = await import("../workers/api/src/snapshot-jobs.ts");

const ENTRY = { framework: "react", tier: 1, buildCommand: "vite build", outputDir: "dist" };
const FILES = { "/package.json": JSON.stringify({ dependencies: { handsontable: "18.1.0" } }) };

/** Routes AE writes through the `bindingSink` branch into an in-memory array
 *  (`getSink`'s production branch — see `lite-inject.test.mjs` for the same
 *  pattern), instead of the local-ClickHouse-HTTP fallback `serviceEnvironment`
 *  otherwise selects for a non-production `PREVIEW_HOST`. */
function envWithPointCapture(...makeEnvArgs) {
  const points = [];
  const { env, ...rest } = makeEnv(...makeEnvArgs);
  env.RUNNER_EVENTS = { writeDataPoint: (p) => points.push(p) };
  env.PREVIEW_HOST = "demos.handsontable.com";
  return { env, points, ...rest };
}

function snapshotBuildPoints(points) {
  return points.filter((p) => p.indexes[0] === "snapshot.build");
}

// blob/double slot positions, §4 (AE_COLUMNS, packages/runtime/src/telemetry/metrics.ts):
// framework=blob6 (index 5), outcome=blob8 (index 7), reason=blob9 (index 8),
// count=double1 (index 0), duration_ms=double2 (index 1).
const FRAMEWORK_SLOT = 5;
const OUTCOME_SLOT = 7;
const REASON_SLOT = 8;
const COUNT_SLOT = 0;
const DURATION_SLOT = 1;

test("createDemo (inline, build_cache hit — no container) emits exactly one snapshot.build ok/inline point", async () => {
  const { env, points } = envWithPointCapture([], [], {}, { buildCacheHit: true });
  await createDemo(env, {
    entry: ENTRY,
    files: FILES,
    htVersion: "18.1.0",
    title: "A demo",
    createdBy: "dev@handsontable.com",
    now: new Date().toISOString(),
  });
  const sb = snapshotBuildPoints(points);
  assert.equal(sb.length, 1, `expected exactly 1 snapshot.build point, got ${sb.length}`);
  assert.equal(sb[0].blobs[FRAMEWORK_SLOT], "react");
  assert.equal(sb[0].blobs[OUTCOME_SLOT], "ok");
  assert.equal(sb[0].blobs[REASON_SLOT], "inline");
  assert.equal(sb[0].doubles[COUNT_SLOT], 1);
  assert.ok(sb[0].doubles[DURATION_SLOT] >= 0, "duration_ms must be a real, non-negative number");
});

test("updateDemo (inline, build_cache hit) emits exactly one snapshot.build ok/inline point", async () => {
  const { env, points } = envWithPointCapture(
    [{ id: "abc123", framework: "react", tier: 1, ht_version: "18.1.0", files_hash: "old", r2_prefix: "demos/abc123/" }],
    [],
    {},
    { buildCacheHit: true },
  );
  await updateDemo(env, {
    id: "abc123",
    entry: ENTRY,
    files: FILES,
    htVersion: "18.1.0",
    now: new Date().toISOString(),
  });
  const sb = snapshotBuildPoints(points);
  assert.equal(sb.length, 1, `expected exactly 1 snapshot.build point, got ${sb.length}`);
  assert.equal(sb[0].blobs[OUTCOME_SLOT], "ok");
  assert.equal(sb[0].blobs[REASON_SLOT], "inline");
});

test("createDemo's snapshot.build point survives past the call returning — it is awaited, not fire-and-forget (would be silently cancellable via ctx.waitUntil-less code otherwise)", async () => {
  // A slow sink write: if withSnapshotBuildPoint used `void emitPoint(...)`
  // instead of `await`, this test's assertion below would race the write
  // and could observe 0 points instead of 1 — this is the revert-evidence
  // for that specific regression risk (flagged before landing the fix).
  let resolveWrite;
  const writeDone = new Promise((r) => { resolveWrite = r; });
  const points = [];
  const { env } = makeEnv([], [], {}, { buildCacheHit: true });
  env.PREVIEW_HOST = "demos.handsontable.com";
  env.RUNNER_EVENTS = {
    writeDataPoint: (p) => {
      points.push(p);
      resolveWrite();
    },
  };
  await createDemo(env, {
    entry: ENTRY,
    files: FILES,
    htVersion: "18.1.0",
    title: "A demo",
    createdBy: "dev@handsontable.com",
    now: new Date().toISOString(),
  });
  // If the write were unawaited, this would need a `await writeDone` race —
  // asserting immediately after `createDemo` resolves is the point: the
  // write must already be done.
  assert.equal(snapshotBuildPoints(points).length, 1);
  await writeDone; // never hangs if the point above is already there
});

test("a build failure (real container build, no cache) emits snapshot.build failed/inline and still rejects the caller", async () => {
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
    const { env, points } = envWithPointCapture([], [], {}, { buildCacheHit: false });
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
    assert.equal(sb.length, 1, `expected exactly 1 snapshot.build point even on failure, got ${sb.length}`);
    assert.equal(sb[0].blobs[OUTCOME_SLOT], "failed");
    assert.equal(sb[0].blobs[REASON_SLOT], "inline");
  } finally {
    setSandboxFactory(null);
  }
});

test("runSnapshotJob (the DO alarm's detached path) still emits exactly one snapshot.build point, tagged reason=detached — not two, after moving emission into updateDemo", async () => {
  const payload = JSON.stringify({ framework: "next.js", files: FILES });
  const { env, points } = envWithPointCapture([], [], { "demos/u1/__job.json": payload });
  await runSnapshotJob(env, {
    demoId: "u1",
    framework: "next.js",
    htVersion: "16.2.0",
    filesKey: "demos/u1/__job.json",
    attempt: 0,
  });
  const sb = snapshotBuildPoints(points);
  assert.equal(sb.length, 1, `expected exactly 1 snapshot.build point (not 0, not 2), got ${sb.length}`);
  assert.equal(sb[0].blobs[OUTCOME_SLOT], "ok");
  assert.equal(sb[0].blobs[REASON_SLOT], "detached");
  assert.equal(sb[0].blobs[FRAMEWORK_SLOT], "next.js");
});
