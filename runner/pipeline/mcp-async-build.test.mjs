// Detached tier-2 snapshot builds on the MCP service path (snapshot-jobs.ts,
// share.ts 0007). The defect: POST/PATCH /api/mcp/demos ran the container build
// inside the request, and the MCP clients calling them abort the tool call at
// ~60s — which cancelled the chain mid-build, so a cold tier-2 create could
// never succeed and left nothing behind. These specs pin the new contract:
//
//  - a cold tier-2 create answers 202 `building` with the usual links, records
//    the row as building, parks the payload, and hands the build to BUILD_JOBS —
//    all without touching a container (the sandbox stub throws on any ask);
//  - a cached build and everything tier-1 keep the synchronous answer;
//  - GET /api/mcp/demos/:id/status is the polling half of that contract;
//  - PATCH refuses to race a running build (409), and a row stuck in
//    'building' past the stale window stops blocking everything forever;
//  - the BuildJob alarm finalizes through the real updateDemo(), marks
//    deterministic failures as failed instead of spending retries on them, and
//    waits out an at-capacity pool a bounded number of times;
//  - /d and /embed answer "still building" (503, self-refreshing) and "build
//    failed" (500) only when there is no artifact to serve — a demo mid-rebuild
//    keeps serving its previous build.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import {
  AUTHOR,
  SECRET,
  ctx,
  demoRow,
  makeEnv,
  seedCatalog,
} from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");
const { STALE_BUILD_MS, demoBuildState, serveDemoAsset } = await import("../workers/api/src/share.ts");
const {
  BuildJobBase,
  CAPACITY_RETRY_MS,
  MAX_CAPACITY_ATTEMPTS,
  runSnapshotJob,
} = await import("../workers/api/src/snapshot-jobs.ts");

// A minimal payload that passes every request gate for the "next.js" starter:
// the toolchain gate wants the build command's binary (`next`) declared, and
// next.js declares no HTML entry, so the entry-document gate has nothing to ask.
const NEXT_FILES = {
  "/package.json": JSON.stringify({
    name: "demo",
    dependencies: { handsontable: "latest", react: "^18.3.1", "react-dom": "^18.3.1" },
    devDependencies: { next: "^14.2.0" },
  }),
  "/app/page.jsx": "export default function Page() { return null; }",
};

const createRequest = (files = NEXT_FILES, framework = "next.js") =>
  new Request("https://demos.handsontable.com/api/mcp/demos", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-MCP-Secret": SECRET,
      "X-Demo-Author": AUTHOR,
    },
    body: JSON.stringify({ framework, files, title: "A demo", description: "words" }),
  });

const patchRequest = (id, body) =>
  new Request(`https://demos.handsontable.com/api/mcp/demos/${id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "X-MCP-Secret": SECRET,
      "X-Demo-Author": AUTHOR,
    },
    body: JSON.stringify(body),
  });

const statusRequest = (id, secret = SECRET) =>
  new Request(`https://demos.handsontable.com/api/mcp/demos/${id}/status`, {
    headers: secret ? { "X-MCP-Secret": secret, "X-Demo-Author": AUTHOR } : {},
  });

/** A tier-2, MCP-created row — what the PATCH route's async branch operates on. */
const tier2Row = (overrides = {}) =>
  demoRow({ framework: "next.js", tier: 2, forked_from: "mcp:next.js", ...overrides });

test("a cold tier-2 create answers 202 building without touching a container", async () => {
  const { env, demos, artifacts, scheduled } = makeEnv([], [], {}, { buildCacheHit: false });
  const latest = await seedCatalog(env);

  const resp = await worker.fetch(createRequest(), env, ctx);
  assert.equal(resp.status, 202);
  const body = await resp.json();
  assert.equal(body.status, "building");
  assert.ok(body.id, "a demo id is minted before the build runs");
  assert.equal(body.url, `/d/${body.id}`);
  assert.equal(body.statusUrl, `/api/mcp/demos/${body.id}/status`);
  assert.equal(body.htVersion, latest);

  const row = demos.get(body.id);
  assert.ok(row, "the demo row exists while the build runs");
  assert.equal(row.build_status, "building");

  // The payload waits in R2 for the alarm, already version-pinned.
  const parked = artifacts.puts.find((p) => p.key === `demos/${body.id}/__source.json`);
  assert.ok(parked, "the source snapshot is parked up front");
  const snapshot = JSON.parse(parked.value);
  assert.match(snapshot.files["/package.json"], new RegExp(latest.replaceAll(".", "\\.")));

  assert.deepEqual(scheduled, [
    {
      demoId: body.id,
      framework: "next.js",
      htVersion: latest,
      filesKey: `demos/${body.id}/__source.json`,
    },
  ]);
});

test("a tier-2 create with a cached identical build keeps the synchronous 201", async () => {
  const { env, scheduled } = makeEnv();
  await seedCatalog(env);

  const resp = await worker.fetch(createRequest(), env, ctx);
  assert.equal(resp.status, 201);
  const body = await resp.json();
  assert.equal(body.status, "ready");
  assert.equal(scheduled.length, 0, "nothing was handed to BUILD_JOBS");
});

test("the status route needs the service secret and reports each state", async () => {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - STALE_BUILD_MS - 60_000).toISOString();
  const { env } = makeEnv([
    tier2Row({ id: "b1", build_status: "building", updated_at: now }),
    tier2Row({ id: "s1", build_status: "building", updated_at: stale }),
    tier2Row({ id: "f1", build_status: "failed", build_error: "install failed: boom" }),
    tier2Row({ id: "r1" }),
    tier2Row({ id: "v1", revoked: 1 }),
  ]);

  assert.equal((await worker.fetch(statusRequest("b1", null), env, ctx)).status, 401);
  assert.equal((await worker.fetch(statusRequest("missing"), env, ctx)).status, 404);
  assert.equal((await worker.fetch(statusRequest("v1"), env, ctx)).status, 410);

  const building = await (await worker.fetch(statusRequest("b1"), env, ctx)).json();
  assert.deepEqual(
    { status: building.status, error: building.error },
    { status: "building", error: null },
  );

  const failed = await (await worker.fetch(statusRequest("f1"), env, ctx)).json();
  assert.deepEqual(
    { status: failed.status, error: failed.error },
    { status: "failed", error: "install failed: boom" },
  );

  const ready = await (await worker.fetch(statusRequest("r1"), env, ctx)).json();
  assert.equal(ready.status, "ready");

  // A row stuck in 'building' past the stale window reads as failed, with an
  // explanation even though no failure was ever recorded for it.
  const stuck = await (await worker.fetch(statusRequest("s1"), env, ctx)).json();
  assert.equal(stuck.status, "failed");
  assert.ok(stuck.error, "a stale build still explains itself");
});

test("PATCH refuses to race a running build", async () => {
  const { env, scheduled } = makeEnv(
    [tier2Row({ id: "abc123", build_status: "building", updated_at: new Date().toISOString() })],
    [],
    {},
    { buildCacheHit: false },
  );
  await seedCatalog(env);

  const resp = await worker.fetch(patchRequest("abc123", { files: NEXT_FILES }), env, ctx);
  assert.equal(resp.status, 409);
  const body = await resp.json();
  assert.equal(body.error, "already_building");
  assert.equal(body.statusUrl, "/api/mcp/demos/abc123/status");
  assert.equal(scheduled.length, 0);
});

test("a cold tier-2 rebuild detaches: 202, __job.json parked, metadata applied now", async () => {
  const stale = new Date(Date.now() - STALE_BUILD_MS - 60_000).toISOString();
  // A stale 'building' row also proves the stuck state stops blocking rebuilds.
  const { env, writes, artifacts, scheduled } = makeEnv(
    [tier2Row({ id: "abc123", build_status: "building", updated_at: stale })],
    [],
    {},
    { buildCacheHit: false },
  );
  const latest = await seedCatalog(env);

  const resp = await worker.fetch(
    patchRequest("abc123", { files: NEXT_FILES, title: "Renamed" }),
    env,
    ctx,
  );
  assert.equal(resp.status, 202);
  const body = await resp.json();
  assert.deepEqual(
    { ok: body.ok, rebuilt: body.rebuilt, status: body.status },
    { ok: true, rebuilt: true, status: "building" },
  );

  // The rebuild payload waits apart from the stored source, which must keep
  // matching the artifact still being served until the rebuild succeeds.
  assert.ok(artifacts.puts.some((p) => p.key === "demos/abc123/__job.json"));
  assert.ok(!artifacts.puts.some((p) => p.key === "demos/abc123/__source.json"));

  const marked = writes.find((w) => /SET build_status='building'/.test(w.sql));
  assert.ok(marked, "the row is marked building before the alarm runs");
  assert.ok(marked.binds.includes("Renamed"), "the rename lands now, not with the build");

  assert.deepEqual(scheduled, [
    { demoId: "abc123", framework: "next.js", htVersion: latest, filesKey: "demos/abc123/__job.json" },
  ]);
});

test("runSnapshotJob finalizes through updateDemo and cleans up a rebuild payload", async () => {
  const payload = JSON.stringify({ framework: "next.js", files: NEXT_FILES });
  const { env, writes, artifacts } = makeEnv([], [], { "demos/u1/__job.json": payload });

  await runSnapshotJob(env, {
    demoId: "u1",
    framework: "next.js",
    htVersion: "16.2.0",
    filesKey: "demos/u1/__job.json",
    attempt: 0,
  });

  const finalized = writes.find((w) => /UPDATE demos SET .*build_status='ready'/.test(w.sql));
  assert.ok(finalized, "the row flips to ready through updateDemo's own UPDATE");
  assert.equal(finalized.binds.at(-1), "u1");
  assert.ok(
    artifacts.puts.some((p) => p.key === "demos/u1/__source.json"),
    "the stored source now matches the freshly built artifact",
  );
  assert.ok(!artifacts.store.has("demos/u1/__job.json"), "the parked payload is gone");
});

test("runSnapshotJob leaves a create's __source.json in place", async () => {
  const payload = JSON.stringify({ framework: "next.js", files: NEXT_FILES });
  const { env, artifacts } = makeEnv([], [], { "demos/c1/__source.json": payload });

  await runSnapshotJob(env, {
    demoId: "c1",
    framework: "next.js",
    htVersion: "16.2.0",
    filesKey: "demos/c1/__source.json",
    attempt: 0,
  });

  assert.ok(artifacts.store.has("demos/c1/__source.json"));
});

function fakeDoState() {
  const map = new Map();
  const alarms = [];
  return {
    alarms,
    map,
    storage: {
      async get(key) { return map.get(key); },
      async put(key, value) { map.set(key, value); },
      async deleteAll() { map.clear(); },
      async setAlarm(at) { alarms.push(at); },
    },
  };
}

test("the alarm turns a deterministic failure into a failed row instead of a retry", async () => {
  const { env, writes } = makeEnv();
  const state = fakeDoState();
  state.map.set("job", {
    demoId: "d1",
    framework: "no-such-framework",
    htVersion: "16.2.0",
    filesKey: "demos/d1/__source.json",
    attempt: 0,
  });

  const job = new BuildJobBase(state, env);
  await job.alarm(); // must not throw — a throw would spend platform retries re-running the build

  const failed = writes.find((w) => /SET build_status='failed'/.test(w.sql));
  assert.ok(failed, "the failure is recorded on the row");
  assert.match(String(failed.binds[0]), /unknown framework/);
  assert.equal(failed.binds.at(-1), "d1");
  assert.equal(state.map.size, 0, "the job is cleared");
  assert.equal(state.alarms.length, 0, "no retry is scheduled");
});

test("the alarm waits out an at-capacity pool a bounded number of times", async () => {
  const { env, writes } = makeEnv();
  // The classifier reads the error's message; where it was thrown from does not
  // matter, so the cheapest capacity-shaped throw is the payload read itself.
  env.ARTIFACTS.get = async () => {
    throw new Error("maximum number of running container instances exceeded");
  };
  const state = fakeDoState();
  const jobRecord = {
    demoId: "d2",
    framework: "next.js",
    htVersion: "16.2.0",
    filesKey: "demos/d2/__source.json",
    attempt: 0,
  };
  state.map.set("job", jobRecord);
  const job = new BuildJobBase(state, env);

  const before = Date.now();
  await job.alarm();
  assert.equal(state.map.get("job").attempt, 1, "the job stays parked with one attempt burned");
  assert.equal(state.alarms.length, 1);
  assert.ok(state.alarms[0] >= before + CAPACITY_RETRY_MS, "the retry waits, it does not spin");
  assert.ok(!writes.some((w) => /build_status='failed'/.test(w.sql)));

  // The last allowed attempt fails for real rather than waiting forever.
  state.map.set("job", { ...jobRecord, attempt: MAX_CAPACITY_ATTEMPTS - 1 });
  await job.alarm();
  assert.ok(writes.some((w) => /build_status='failed'/.test(w.sql)));
  assert.equal(state.map.size, 0);
});

test("demoBuildState: absent column is ready, building goes stale into failed", () => {
  const now = Date.now();
  const fresh = new Date(now - 60_000).toISOString();
  const stale = new Date(now - STALE_BUILD_MS - 60_000).toISOString();
  assert.equal(demoBuildState({ updated_at: fresh }, now), "ready");
  assert.equal(demoBuildState({ build_status: "ready", updated_at: fresh }, now), "ready");
  assert.equal(demoBuildState({ build_status: "building", updated_at: fresh }, now), "building");
  assert.equal(demoBuildState({ build_status: "building", updated_at: stale }, now), "failed");
  assert.equal(demoBuildState({ build_status: "failed", updated_at: fresh }, now), "failed");
});

test("/d while building is a self-refreshing 503, failed is 500, and old artifacts keep serving", async () => {
  const now = new Date().toISOString();
  const rows = [
    tier2Row({ id: "b1", build_status: "building", updated_at: now, r2_prefix: "demos/b1/" }),
    tier2Row({ id: "f1", build_status: "failed", updated_at: now, r2_prefix: "demos/f1/" }),
    tier2Row({ id: "x1", build_status: "building", updated_at: now, r2_prefix: "demos/x1/" }),
  ];
  const { env } = makeEnv(rows, [], { "demos/x1/index.html": "<html>previous build</html>" });

  const building = await serveDemoAsset(env, "b1", "", { embed: false });
  assert.equal(building.status, 503);
  assert.equal(building.headers.get("Retry-After"), "10");
  assert.match(await building.text(), /still building/i);
  assert.match(building.headers.get("Content-Type") ?? "", /text\/html/);

  // An asset request during the build answers plainly, not with a document.
  const asset = await serveDemoAsset(env, "b1", "assets/index-abc.js", { embed: false });
  assert.equal(asset.status, 503);

  const failed = await serveDemoAsset(env, "f1", "", { embed: false });
  assert.equal(failed.status, 500);
  assert.match(await failed.text(), /build failed/i);

  // A demo mid-rebuild (or whose rebuild failed) keeps serving what it has.
  const serving = await serveDemoAsset(env, "x1", "", { embed: false });
  assert.equal(serving.status, 200);
  assert.match(await serving.text(), /previous build/);
});
