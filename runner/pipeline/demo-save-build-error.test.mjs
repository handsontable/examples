// A Save or create whose build rejects the demo's own input is client input: 422 with
// the build error, an `api.request` 4xx, a `snapshot.build failed` point, and the stored
// demo untouched. A failure that is ours stays a 5xx. Driven through the real router
// with a scripted builder container.
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/demo-save-build-error.test.mjs

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { AUTHOR, SECRET, demoRow, makeEnv, seedCatalog } from "./fixtures/worker-harness.mjs";
import { setSandboxFactory } from "./fixtures/cloudflare-sandbox-stub.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");

const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://login.invalid") && init?.headers?.Authorization === "Bearer test-token") {
    return Response.json({ email: AUTHOR, sub: "u1" });
  }
  throw new Error(`unexpected network fetch in demo-save-build-error.test.mjs: ${url}`);
};
after(() => {
  globalThis.fetch = REAL_FETCH;
  setSandboxFactory(null);
});

const DEMO_ID = "abc123";
const INDEX_HTML =
  '<!doctype html><html><body><div id="root"></div>'
  + '<script type="module" src="/src/index.tsx"></script></body></html>';
const FILES = {
  "/package.json": JSON.stringify({ name: "demo", dependencies: { handsontable: "16.0.2" }, devDependencies: { vite: "^5.4.0" } }),
  "/index.html": INDEX_HTML,
  "/src/index.tsx": "const X = ;\n",
};

/** The stderr of a `vite build` that rejects a syntax error. Its announced cause is
 *  only headings, so the useful line is the one after them. */
const SYNTAX_ERROR_LOG =
  "vite v7.1.0 building for production...\ntransforming...\nerror during build:\n"
  + "Build failed with 1 error:\n/app/src/index.tsx:1:10: ERROR: Unexpected \";\"\n";

/** A builder whose install succeeds and whose build command answers `build`. */
function builder(build) {
  return () => ({
    mkdir: async () => {},
    writeFile: async () => {},
    readFile: async () => "",
    destroy: async () => {},
    async exec(cmd) {
      if (cmd.includes("pnpm install")) return { success: true, exitCode: 0, stdout: "", stderr: "" };
      return build(cmd);
    },
  });
}

const rejectsCode = builder(() => ({ success: false, exitCode: 1, stdout: "", stderr: SYNTAX_ERROR_LOG }));

/** The route's env with a build-cache miss (so the builder runs) and points in memory. */
function setup(rows = [demoRow({ id: DEMO_ID, framework: "react", ht_version: "16.0.2" })]) {
  const harness = makeEnv(rows, [], {}, { buildCacheHit: false });
  const { env } = harness;
  const points = [];
  env.RUNNER_EVENTS = { writeDataPoint: (p) => points.push(p) };
  env.PREVIEW_HOST = "demos.handsontable.com";
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p)), passThroughOnException() {} };
  /** Every point of `metric`, once the work scheduled past the response (which
   *  itself schedules more) has settled. */
  const pointsOf = async (metric) => {
    for (let seen = -1; seen !== pending.length;) {
      seen = pending.length;
      await Promise.allSettled(pending);
    }
    return points.filter((p) => p.indexes[0] === metric);
  };
  return { ...harness, ctx, pointsOf };
}

const authed = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
const mcpHeaders = { "Content-Type": "application/json", "X-MCP-Secret": SECRET, "X-Demo-Author": AUTHOR };

const request = (method, path, headers, body) =>
  new Request(`https://demos.handsontable.com${path}`, { method, headers, body: JSON.stringify(body) });

const ROUTES = [
  ["PATCH /api/demos/:id (editor Save)", () => request("PATCH", `/api/demos/${DEMO_ID}`, authed, { files: FILES, htVersion: "16.0.2" })],
  ["POST /api/demos (fork, embed)", () => request("POST", "/api/demos", authed, { framework: "react", files: FILES, title: "Grid", htVersion: "16.0.2" })],
  ["PATCH /api/mcp/demos/:id", () => request("PATCH", `/api/mcp/demos/${DEMO_ID}`, mcpHeaders, { files: FILES, htVersion: "16.0.2" })],
  ["POST /api/mcp/demos", () => request("POST", "/api/mcp/demos", mcpHeaders, { framework: "react", files: FILES, title: "Grid", description: "A grid", htVersion: "16.0.2" })],
];

/** What `api.request` recorded for the one request: its outcome blob. */
async function requestOutcomes(pointsOf) {
  return (await pointsOf("api.request")).map((p) => p.blobs.find((b) => /^[2-5]xx$/.test(b)));
}

for (const [name, makeRequest] of ROUTES) {
  test(`${name}: code the build rejects is a 422 build_failed with the build error, recorded as 4xx`, async () => {
    setSandboxFactory(rejectsCode);
    const { env, ctx, pointsOf, writes, artifacts, demos } = setup();
    await seedCatalog(env);
    const before = JSON.stringify(demos.get(DEMO_ID));

    const res = await worker.fetch(makeRequest(), env, ctx);

    assert.equal(res.status, 422);
    const detail = 'error during build: Build failed with 1 error: src/index.tsx:1:10: ERROR: Unexpected ";"';
    // `error` carries the diagnostic too: MCP clients (hot-mcp) read only that field.
    assert.deepEqual(await res.json(), { error: `build failed: ${detail}`, code: "build_failed", detail });
    assert.deepEqual(await requestOutcomes(pointsOf), ["4xx"], "one api.request point, and it is not a 5xx");
    const builds = await pointsOf("snapshot.build");
    assert.equal(builds.length, 1);
    assert.ok(builds[0].blobs.includes("failed"), "snapshot.build keeps its failed outcome");
    // The demo is unchanged: no artifact, no source snapshot, no row written.
    assert.deepEqual(artifacts.puts.filter((p) => p.key.startsWith("demos/")), []);
    assert.deepEqual(writes.filter((w) => /\bdemos\b/.test(w.sql) && !/build_cache/.test(w.sql)), []);
    assert.equal(JSON.stringify(demos.get(DEMO_ID)), before);
  });
}

/** A builder whose install answers `install` (the frozen install and its retry alike). */
function installer(install) {
  return () => ({
    mkdir: async () => {},
    writeFile: async () => {},
    readFile: async () => "",
    destroy: async () => {},
    exec: async () => install(),
  });
}

const failedInstall = (stderr) => installer(() => ({ success: false, exitCode: 1, stdout: "", stderr }));

const USER_INSTALL_FAILURES = [
  ["ERR_PNPM_NO_MATCHING_VERSION", " ERR_PNPM_NO_MATCHING_VERSION  No matching version found for dayjs@^99\n"],
  ["ERR_PNPM_FETCH_404", " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/dayjss: Not Found - 404\n"],
  ["ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER", " ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER  dayjs@latest-ish isn't supported by any available resolver.\n"],
  ["ERR_PNPM_BAD_PM_VERSION", " ERR_PNPM_BAD_PM_VERSION  This project is configured to use v8 of pnpm. Your current pnpm is v10.34.5\n"],
];

for (const [code, stderr] of USER_INSTALL_FAILURES) {
  test(`an install refused with ${code} (the author's dependency) is a 422 build_failed with the pnpm error`, async () => {
    setSandboxFactory(failedInstall(stderr));
    const { env, ctx, pointsOf } = setup();
    await seedCatalog(env);
    const res = await worker.fetch(ROUTES[0][1](), env, ctx);
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.code, "build_failed");
    assert.ok(body.detail.includes(code), body.detail);
    assert.equal(body.error, `install failed: ${body.detail}`);
    assert.deepEqual(await requestOutcomes(pointsOf), ["4xx"]);
  });
}

test("an MCP client reading only `error` gets the build diagnostic", async () => {
  setSandboxFactory(rejectsCode);
  const { env, ctx } = setup();
  await seedCatalog(env);
  for (const [, makeRequest] of ROUTES.filter(([name]) => name.includes("/api/mcp/"))) {
    const res = await worker.fetch(makeRequest(), env, ctx);
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /src\/index\.tsx:1:10: ERROR: Unexpected ";"/);
  }
});

const INFRA_FAILURES = [
  ["a build killed by a signal (OOM)", builder(() => ({ success: false, exitCode: 137, stdout: "", stderr: "Killed\n" }))],
  ["a build command that is not executable (126)", builder(() => ({ success: false, exitCode: 126, stdout: "", stderr: "sh: vite: Permission denied\n" }))],
  ["a build command that is not found (127)", builder(() => ({ success: false, exitCode: 127, stdout: "", stderr: "sh: vite: not found\n" }))],
  ["a build that exits 1 on a network failure", builder(() => ({
    success: false,
    exitCode: 1,
    stdout: "",
    stderr: "`next/font` error:\nFailed to fetch `Inter` from Google Fonts.\nTypeError: fetch failed\n",
  }))],
  ["a build that exits 1 after its worker ran out of memory", builder(() => ({
    success: false,
    exitCode: 1,
    stdout: "",
    stderr: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\nerror during build:\nBuild failed\n",
  }))],
  ["an install that fails on a registry 5xx", failedInstall(" ERR_PNPM_FETCH_503  GET https://registry.npmjs.org/dayjs: Service Unavailable - 503\n")],
  ["an install that fails on a reset connection", failedInstall(" ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/dayjs: request to https://registry.npmjs.org/dayjs failed, reason: read ECONNRESET\n")],
  ["an install that times out", failedInstall(" ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/dayjs: request to https://registry.npmjs.org/dayjs failed, reason: connect ETIMEDOUT 104.16.0.35:443\n")],
  ["a build result without an exit code", builder(() => ({ success: false, stdout: "", stderr: "error during build:\nsomething\n" }))],
  ["an exec that throws (container lost)", builder(() => { throw new Error("container is not running"); })],
];

for (const [name, factory] of INFRA_FAILURES) {
  test(`an editor Save that fails on ${name} stays a 5xx`, async () => {
    setSandboxFactory(factory);
    const { env, ctx, pointsOf } = setup();
    await seedCatalog(env);
    const res = await worker.fetch(ROUTES[0][1](), env, ctx);
    assert.equal(res.status, 500);
    assert.notEqual((await res.json()).error, "build_failed");
    assert.deepEqual(await requestOutcomes(pointsOf), ["5xx"]);
  });
}

// DEV-3143: `Failed to fetch` / `fetch failed` are free text, so an author's own build output can
// print them. Only an error line (`TypeError: fetch failed`) counts as the tool naming infrastructure.
const USER_BUILD_FAILURES_PRINTING_INFRA_TEXT = [
  ["a build script that logs `Failed to fetch` before a real compile error", { stdout: "Failed to fetch\n", stderr: SYNTAX_ERROR_LOG }],
  ["a build script that logs `fetch failed` before a real compile error", { stdout: "step 2: fetch failed, using fallback\n", stderr: SYNTAX_ERROR_LOG }],
  ["a compile error whose last line is the author's own `Failed to fetch` log", { stdout: "", stderr: `${SYNTAX_ERROR_LOG}Failed to fetch\n` }],
];

for (const [name, output] of USER_BUILD_FAILURES_PRINTING_INFRA_TEXT) {
  test(`${name} is the author's build error: 422, not a 5xx`, async () => {
    setSandboxFactory(builder(() => ({ success: false, exitCode: 1, ...output })));
    const { env, ctx, pointsOf } = setup();
    await seedCatalog(env);
    const res = await worker.fetch(ROUTES[0][1](), env, ctx);
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, "build_failed");
    assert.deepEqual(await requestOutcomes(pointsOf), ["4xx"]);
  });
}

test("a build that exits 1 on undici's own `TypeError: fetch failed` line stays a 5xx", async () => {
  setSandboxFactory(builder(() => ({
    success: false,
    exitCode: 1,
    stdout: "",
    stderr: "error during build:\nTypeError: fetch failed\n    at node:internal/deps/undici\n",
  })));
  const { env, ctx } = setup();
  await seedCatalog(env);
  const res = await worker.fetch(ROUTES[0][1](), env, ctx);
  assert.equal(res.status, 500);
});

test("api.request records the exact status of a 5xx in its reason blob, and nothing for a 4xx (DEV-3143)", async () => {
  const REASON_SLOT = 8; // reason = blob9
  setSandboxFactory(builder(() => ({ success: false, exitCode: 137, stdout: "", stderr: "Killed\n" })));
  const five = setup();
  await seedCatalog(five.env);
  assert.equal((await worker.fetch(ROUTES[0][1](), five.env, five.ctx)).status, 500);
  assert.deepEqual((await five.pointsOf("api.request")).map((p) => p.blobs[REASON_SLOT]), ["500"]);

  setSandboxFactory(rejectsCode);
  const four = setup();
  await seedCatalog(four.env);
  assert.equal((await worker.fetch(ROUTES[0][1](), four.env, four.ctx)).status, 422);
  assert.deepEqual((await four.pointsOf("api.request")).map((p) => p.blobs[REASON_SLOT]), [""]);
});
