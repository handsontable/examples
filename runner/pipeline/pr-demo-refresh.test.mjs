// Demos pinned to a pull request's pkg.pr.new preview (DEV-3338). The defect: a
// build keyed on the PR number served the PR's first build forever, because the
// number never changes while the commit behind it does. These specs pin:
//
//  - the build cache key and the installed dependency carry the PR's commit, so a
//    new commit misses the cache and installs exactly the commit the key names;
//  - opening such a demo after its PR moved on claims one rebuild and shows the
//    self-refreshing wait page instead of the old commit;
//  - the claim is atomic and never retries a commit that already failed;
//  - nothing changes for demos on a released version.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { AUTHOR, SECRET, ctx, demoRow, makeEnv } from "./fixtures/worker-harness.mjs";
import { setSandboxFactory } from "./fixtures/cloudflare-sandbox-stub.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");
const { hasCachedBuild, updateDemo } = await import("../workers/api/src/share.ts");
const { runSnapshotJob } = await import("../workers/api/src/snapshot-jobs.ts");
const { latestPrSha, pinPrFiles, prNumber, resolvePrSha } = await import("../workers/api/src/pr-build.ts");
const { refreshPrDemo } = await import("../workers/api/src/pr-refresh.ts");

const OLD_SHA = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "f66dd0d4c2c2bfc842fc7b1601b3a5b7ed80f4b2";

/** Answer pkg.pr.new HEADs with `sha`; record every request. */
function stubPkgPrNew(sha, { status = 200 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response(null, {
      status,
      headers: sha ? { "x-commit-key": `handsontable:handsontable:${sha}` } : {},
    });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const prRow = (overrides = {}) => demoRow({
  ht_version: "13766",
  ht_built_sha: OLD_SHA,
  ht_attempt_sha: OLD_SHA,
  ...overrides,
});

const ARTIFACT = { "demos/abc123/index.html": "<!doctype html><html><head></head><body>old build</body></html>" };

const view = (env) => worker.fetch(new Request("https://demos.handsontable.com/d/abc123/"), env, ctx);

test("prNumber names only a PR id, never a release, nightly or commit", () => {
  assert.equal(prNumber("13766"), "13766");
  assert.equal(prNumber("https://pkg.pr.new/handsontable@13766"), "13766");
  assert.equal(prNumber("18.1.1"), null);
  assert.equal(prNumber("0.0.0-next-b0dc2e1-20261002"), null);
  assert.equal(prNumber("16"), null);
});

test("pinPrFiles pins every package of the PR to the commit and leaves the rest alone", () => {
  const files = {
    "/package.json": JSON.stringify({
      dependencies: {
        handsontable: "https://pkg.pr.new/handsontable@13766",
        "@handsontable/react-wrapper": "https://pkg.pr.new/@handsontable/react-wrapper@13766",
        react: "^18.3.1",
        other: "https://pkg.pr.new/other@99999",
      },
    }),
    "/index.js": "x",
  };
  const deps = JSON.parse(pinPrFiles(files, "13766", NEW_SHA)["/package.json"]).dependencies;
  assert.deepEqual(deps, {
    handsontable: `https://pkg.pr.new/handsontable@${NEW_SHA}`,
    "@handsontable/react-wrapper": `https://pkg.pr.new/@handsontable/react-wrapper@${NEW_SHA}`,
    react: "^18.3.1",
    other: "https://pkg.pr.new/other@99999",
  });
});

test("latestPrSha reads x-commit-key once per TTL and gives up quietly", async () => {
  const { env } = makeEnv();
  const ok = stubPkgPrNew(NEW_SHA);
  try {
    assert.equal(await latestPrSha(env, "13766"), NEW_SHA);
    assert.equal(await latestPrSha(env, "13766"), NEW_SHA);
    assert.equal(ok.calls.length, 1, "the second ask is served from KV");
    assert.deepEqual(ok.calls[0], { url: "https://pkg.pr.new/handsontable@13766", method: "HEAD" });
  } finally {
    ok.restore();
  }
  for (const [sha, status] of [[NEW_SHA, 404], [null, 200], ["not-a-sha", 200]]) {
    const { env: fresh } = makeEnv();
    const stub = stubPkgPrNew(sha, { status });
    try {
      assert.equal(await latestPrSha(fresh, "13766"), null, `sha=${sha} status=${status}`);
    } finally {
      stub.restore();
    }
  }
});

test("a view after the PR moved on claims one rebuild of the stored source and shows the wait page", async () => {
  const { env, demos, scheduled } = makeEnv([prRow()], [], ARTIFACT);
  const stub = stubPkgPrNew(NEW_SHA);
  try {
    const first = await view(env);
    assert.equal(first.status, 503);
    const body = await first.text();
    assert.match(body, /Pull request #13766 has a newer commit \(f66dd0d\)/);
    assert.equal(first.headers.get("Retry-After"), "10");
    assert.deepEqual(scheduled, [{
      demoId: "abc123",
      framework: "react",
      htVersion: "13766",
      filesKey: "demos/abc123/__source.json",
      prSha: NEW_SHA,
    }]);
    assert.equal(demos.get("abc123").build_status, "building");
    assert.equal(demos.get("abc123").ht_attempt_sha, NEW_SHA);

    // The next viewer waits for the same build rather than starting another.
    const second = await view(env);
    assert.equal(second.status, 503);
    assert.equal(scheduled.length, 1);
  } finally {
    stub.restore();
  }
});

test("a view of a demo already built from the PR's commit serves it", async () => {
  const { env, scheduled, writes } = makeEnv([prRow({ ht_built_sha: NEW_SHA, ht_attempt_sha: NEW_SHA })], [], ARTIFACT);
  const stub = stubPkgPrNew(NEW_SHA);
  try {
    const res = await view(env);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /old build/);
    assert.equal(scheduled.length, 0);
    assert.equal(writes.filter((w) => /UPDATE demos/.test(w.sql)).length, 0);
  } finally {
    stub.restore();
  }
});

test("a stale KV commit is confirmed with pkg.pr.new before it can rebuild a demo backwards", async () => {
  const { env, scheduled } = makeEnv([prRow({ ht_built_sha: NEW_SHA, ht_attempt_sha: NEW_SHA })], [], ARTIFACT);
  await env.CACHE.put("prsha:13766", OLD_SHA);
  const stub = stubPkgPrNew(NEW_SHA);
  try {
    const res = await view(env);
    assert.equal(res.status, 200);
    assert.equal(scheduled.length, 0);
    assert.equal(stub.calls.filter((c) => c.url.startsWith("https://pkg.pr.new/")).length, 1);
  } finally {
    stub.restore();
  }
});

test("a build asks pkg.pr.new directly rather than trusting a cached commit", async () => {
  const { env } = makeEnv();
  await env.CACHE.put("prsha:13766", OLD_SHA);
  const stub = stubPkgPrNew(NEW_SHA);
  try {
    assert.equal(await resolvePrSha(env, "13766"), NEW_SHA);
    assert.equal(await resolvePrSha(env, "13766", OLD_SHA), OLD_SHA, "a commit handed in is built as is");
    assert.equal(await resolvePrSha(env, "18.1.1"), null);
  } finally {
    stub.restore();
  }
});

test("a commit that already failed to build is not retried on every view", async () => {
  const { env, scheduled } = makeEnv(
    [prRow({ ht_attempt_sha: NEW_SHA, build_status: "failed", build_error: "vite exploded" })],
    [],
    ARTIFACT,
  );
  const stub = stubPkgPrNew(NEW_SHA);
  try {
    const res = await view(env);
    assert.equal(res.status, 200);
    assert.equal(scheduled.length, 0);
  } finally {
    stub.restore();
  }
});

test("a rebuild the owner started is not presented as a PR refresh", async () => {
  // PATCH flips the row to building without touching the commit columns; that
  // rebuild keeps serving the previous artifact, as it always has.
  const { env, scheduled } = makeEnv(
    [prRow({ build_status: "building", updated_at: new Date().toISOString() })],
    [],
    ARTIFACT,
  );
  const stub = stubPkgPrNew(NEW_SHA);
  try {
    const res = await view(env);
    assert.equal(res.status, 200);
    assert.equal(scheduled.length, 0);
  } finally {
    stub.restore();
  }
});

test("a refresh stuck past the stale window is claimed again", async () => {
  const { env, scheduled } = makeEnv(
    [prRow({ build_status: "building", ht_attempt_sha: "2222222", updated_at: "2026-01-01T00:00:00.000Z" })],
    [],
    ARTIFACT,
  );
  const stub = stubPkgPrNew(NEW_SHA);
  try {
    const res = await view(env);
    assert.equal(res.status, 503);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].prSha, NEW_SHA);
  } finally {
    stub.restore();
  }
});

test("a cached row still naming the PR does not refresh a demo its owner moved off it", async () => {
  const { env, scheduled } = makeEnv([demoRow({ ht_version: "18.1.1" })], [], ARTIFACT);
  await env.CACHE.put("demo:abc123", JSON.stringify(prRow()));
  const stub = stubPkgPrNew(NEW_SHA);
  try {
    const res = await view(env);
    assert.equal(res.status, 200);
    assert.equal(scheduled.length, 0);
  } finally {
    stub.restore();
  }
});

test("a demo on a released version never asks pkg.pr.new", async () => {
  const { env, scheduled } = makeEnv([demoRow({ ht_version: "18.1.1" })], [], ARTIFACT);
  const stub = stubPkgPrNew(NEW_SHA);
  try {
    const res = await view(env);
    assert.equal(res.status, 200);
    assert.equal(stub.calls.filter((c) => c.url.startsWith("https://pkg.pr.new/")).length, 0);
    assert.equal(scheduled.length, 0);
  } finally {
    stub.restore();
  }
});

test("a denied budget or an unreachable pkg.pr.new keeps serving the old build", async () => {
  const opts = { budgetDenied: async () => true, recordBuild: async () => {} };
  {
    const { env, scheduled, demos } = makeEnv([prRow()]);
    const stub = stubPkgPrNew(NEW_SHA);
    try {
      assert.equal(await refreshPrDemo(env, prRow(), opts), null);
      assert.equal(scheduled.length, 0);
      assert.equal(demos.get("abc123").build_status, "ready");
    } finally {
      stub.restore();
    }
  }
  {
    const { env, scheduled } = makeEnv([prRow()]);
    const stub = stubPkgPrNew(null, { status: 503 });
    try {
      assert.equal(await refreshPrDemo(env, prRow(), { ...opts, budgetDenied: async () => false }), null);
      assert.equal(scheduled.length, 0);
    } finally {
      stub.restore();
    }
  }
});

test("a PR build is keyed on its commit and installs exactly that commit", async () => {
  const { env, cacheLookups } = makeEnv([prRow()], [], {}, { buildCacheHit: false });
  const written = {};
  setSandboxFactory(() => ({
    mkdir: async () => {},
    async writeFile(path, contents) { written[path] = contents; },
    readFile: async () => "",
    destroy: async () => {},
    // Stop after the install: what was written is the observable.
    exec: async () => ({ success: false, exitCode: 1, stdout: "", stderr: "stop" }),
  }));
  const files = {
    "/package.json": JSON.stringify({ dependencies: { handsontable: "https://pkg.pr.new/handsontable@13766" } }),
    "/index.js": "import 'handsontable';",
  };
  try {
    await updateDemo(env, {
      id: "abc123",
      entry: { framework: "javascript", tier: 1, installCommand: "pnpm install", buildCommand: "vite build", outputDir: "dist", outputGlob: null },
      files,
      htVersion: "13766",
      now: "2026-10-07T00:00:00.000Z",
      prSha: NEW_SHA,
    }).catch(() => {});
  } finally {
    setSandboxFactory(null);
  }
  assert.equal(cacheLookups.length, 1);
  assert.match(cacheLookups[0], new RegExp(`^v\\d+:javascript:13766@${NEW_SHA}:`));
  assert.equal(
    JSON.parse(written["/app/package.json"]).dependencies.handsontable,
    `https://pkg.pr.new/handsontable@${NEW_SHA}`,
  );
});

test("the refresh job builds the commit it was claimed for and records it as built", async () => {
  const source = {
    framework: "react",
    files: { "/package.json": JSON.stringify({ dependencies: { handsontable: "https://pkg.pr.new/handsontable@13766" } }) },
  };
  const { env, writes, cacheLookups } = makeEnv(
    [prRow({ build_status: "building", ht_attempt_sha: NEW_SHA })],
    [],
    { "demos/abc123/__source.json": JSON.stringify(source) },
  );
  // No fetch stub: the job must not ask pkg.pr.new for a commit it was handed.
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("pkg.pr.new must not be asked"); };
  try {
    await runSnapshotJob(env, {
      demoId: "abc123",
      framework: "react",
      htVersion: "13766",
      filesKey: "demos/abc123/__source.json",
      prSha: NEW_SHA,
      attempt: 0,
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.match(cacheLookups[0], new RegExp(`:13766@${NEW_SHA}:`));
  const finalize = writes.find((w) => /UPDATE demos SET ht_version=\?/.test(w.sql));
  assert.ok(finalize, "updateDemo finalized the row");
  assert.match(finalize.sql, /build_status='ready'.*ht_built_sha=\?, ht_attempt_sha=\?/s);
  assert.deepEqual(finalize.binds.slice(3, 5), [NEW_SHA, NEW_SHA]);
});

// Tier-2 payload pinned to the PR, so both MCP routes take their detached path.
const NEXT_PR_FILES = {
  "/package.json": JSON.stringify({
    name: "demo",
    dependencies: { handsontable: "https://pkg.pr.new/handsontable@13766", react: "^18.3.1", "react-dom": "^18.3.1" },
    devDependencies: { next: "^14.2.0" },
  }),
  "/app/page.jsx": "export default function Page() { return null; }",
};

const mcpRequest = (path, method, body) =>
  new Request(`https://demos.handsontable.com/api/mcp/demos${path}`, {
    method,
    headers: { "content-type": "application/json", "X-MCP-Secret": SECRET, "X-Demo-Author": AUTHOR },
    body: JSON.stringify(body),
  });

test("an MCP create and rebuild count the commit they build as attempted", async () => {
  const stub = stubPkgPrNew(NEW_SHA);
  try {
    {
      const { env, demos, scheduled } = makeEnv([], [], {}, { buildCacheHit: false });
      const res = await worker.fetch(mcpRequest("", "POST", { framework: "next.js", files: NEXT_PR_FILES, title: "t", description: "d" }), env, ctx);
      assert.equal(res.status, 202);
      const { id } = await res.json();
      assert.equal(demos.get(id).ht_attempt_sha, NEW_SHA);
      assert.equal(scheduled[0].prSha, NEW_SHA);
    }
    {
      const row = prRow({ framework: "next.js", tier: 2, forked_from: "mcp:next.js" });
      const { env, writes, scheduled } = makeEnv([row], [], {}, { buildCacheHit: false });
      const res = await worker.fetch(mcpRequest("/abc123", "PATCH", { files: NEXT_PR_FILES }), env, ctx);
      assert.equal(res.status, 202);
      const flip = writes.find((w) => /UPDATE demos SET build_status='building'/.test(w.sql));
      assert.match(flip.sql, /ht_attempt_sha=\?/);
      assert.ok(flip.binds.includes(NEW_SHA));
      assert.equal(scheduled[0].prSha, NEW_SHA);
    }
  } finally {
    stub.restore();
  }
});

test("a PR build whose commit is unknown skips the cache instead of reusing the bare-number build", async () => {
  const { env, cacheLookups, writes } = makeEnv([prRow()], [], {}, { buildCacheHit: true });
  const written = {};
  setSandboxFactory(() => ({
    mkdir: async () => {},
    async writeFile(path, contents) { written[path] = contents; },
    readFile: async () => "",
    destroy: async () => {},
    exec: async () => ({ success: false, exitCode: 1, stdout: "", stderr: "stop" }),
  }));
  const files = {
    "/package.json": JSON.stringify({ dependencies: { handsontable: "https://pkg.pr.new/handsontable@13766" } }),
    "/index.js": "import 'handsontable';",
  };
  try {
    assert.equal(await hasCachedBuild(env, "javascript", "13766", files, null), false);
    await updateDemo(env, {
      id: "abc123",
      entry: { framework: "javascript", tier: 1, installCommand: "pnpm install", buildCommand: "vite build", outputDir: "dist", outputGlob: null },
      files,
      htVersion: "13766",
      now: "2026-10-07T00:00:00.000Z",
      prSha: null,
    }).catch(() => {});
  } finally {
    setSandboxFactory(null);
  }
  assert.deepEqual(cacheLookups, [], "the build_cache is never asked");
  assert.ok(written["/app/package.json"], "the build ran instead of copying a cached artifact");
  assert.equal(JSON.parse(written["/app/package.json"]).dependencies.handsontable, "https://pkg.pr.new/handsontable@13766");
  assert.equal(writes.filter((w) => /INTO build_cache/.test(w.sql)).length, 0);
});

test("a viewer who loses the claim to a concurrent view waits for the same build", async () => {
  const { env, scheduled } = makeEnv([prRow()]);
  const stub = stubPkgPrNew(NEW_SHA);
  const opts = { budgetDenied: async () => false, recordBuild: async () => {} };
  try {
    const [a, b] = await Promise.all([refreshPrDemo(env, prRow(), opts), refreshPrDemo(env, prRow(), opts)]);
    assert.equal(scheduled.length, 1);
    assert.deepEqual(a, { pr: "13766", sha: NEW_SHA });
    assert.deepEqual(b, { pr: "13766", sha: NEW_SHA });
  } finally {
    stub.restore();
  }
});

test("a first build keeps its own still-building page", async () => {
  const { env, scheduled } = makeEnv([prRow({
    build_status: "building",
    ht_built_sha: null,
    ht_attempt_sha: NEW_SHA,
    updated_at: new Date().toISOString(),
  })]);
  const stub = stubPkgPrNew(NEW_SHA);
  try {
    const res = await view(env);
    assert.equal(res.status, 503);
    const body = await res.text();
    assert.match(body, /This demo is still building/);
    assert.doesNotMatch(body, /newer commit/);
    assert.equal(scheduled.length, 0);
  } finally {
    stub.restore();
  }
});

test("a refresh that cannot be scheduled is undone so the next view tries again", async () => {
  const stale = prRow({ build_status: "building", updated_at: "2026-01-01T00:00:00.000Z" });
  const { env, demos } = makeEnv([stale], [], ARTIFACT);
  let calls = 0;
  env.BUILD_JOBS = {
    idFromName: (name) => name,
    get: () => ({ async fetch() { calls++; return new Response("down", { status: 500 }); } }),
  };
  const stub = stubPkgPrNew(NEW_SHA);
  try {
    const res = await view(env);
    assert.equal(res.status, 200, "the old build is served when no rebuild could start");
    assert.deepEqual(
      { status: demos.get("abc123").build_status, attempt: demos.get("abc123").ht_attempt_sha, updated: demos.get("abc123").updated_at },
      { status: "building", attempt: OLD_SHA, updated: "2026-01-01T00:00:00.000Z" },
      "the row is back exactly as it was, so the stale window still lets the next view claim it",
    );
    await view(env);
    assert.equal(calls, 2, "the next view tries to schedule again");
  } finally {
    stub.restore();
  }
});

test("a refresh check that throws serves the current build instead of a 500", async () => {
  const { env } = makeEnv([prRow()], [], ARTIFACT);
  const stub = stubPkgPrNew(NEW_SHA);
  const realPrepare = env.DB.prepare;
  env.DB.prepare = (sql) => {
    if (/SELECT ht_version, build_status/.test(sql)) throw new Error("D1 is down");
    return realPrepare(sql);
  };
  try {
    const res = await view(env);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /old build/);
  } finally {
    stub.restore();
  }
});
