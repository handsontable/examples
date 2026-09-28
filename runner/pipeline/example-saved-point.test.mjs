// `example.saved` (contract §5, ADR-0042 §2) is written by the API worker when
// an editor Save's rebuild succeeds, with the values the browser's saved-demo
// taxonomy produces. Driven through the real router with the shared fakes.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { AUTHOR, demoRow, makeEnv } from "./fixtures/worker-harness.mjs";
import { exampleActionAttrs, exampleTaxonomy } from "../apps/authoring/src/exampleAnalytics.ts";
import { toAePoint } from "../packages/runtime/dist/telemetry/index.js";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");

const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://login.invalid") && init?.headers?.Authorization === "Bearer test-token") {
    return Response.json({ email: AUTHOR, sub: "u1" });
  }
  throw new Error(`unexpected network fetch in example-saved-point.test.mjs: ${url}`);
};
after(() => {
  globalThis.fetch = REAL_FETCH;
});

const DEMO_ID = "abc123";
const FILES = {
  "/package.json": JSON.stringify({ name: "demo", dependencies: { handsontable: "16.0.2" } }),
  "/index.js": "console.log(1)",
};

/** Points land in memory through the production `bindingSink`; `waitUntil`
 *  promises are kept so a test can wait for work scheduled past the response. */
function setup(rows = [demoRow({ id: DEMO_ID, framework: "react", ht_version: "16.0.2" })]) {
  const { env } = makeEnv(rows);
  const points = [];
  env.RUNNER_EVENTS = { writeDataPoint: (p) => points.push(p) };
  env.PREVIEW_HOST = "demos.handsontable.com";
  env.SERVICE_VERSION = "api-sha";
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p)), passThroughOnException() {} };
  const saved = async () => {
    await Promise.all(pending);
    return points.filter((p) => p.indexes[0] === "example.saved");
  };
  return { env, ctx, saved, pending, points };
}

const patch = (body, { auth = true } = {}) =>
  new Request(`https://demos.handsontable.com/api/demos/${DEMO_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer test-token" } : {}) },
    body: JSON.stringify(body),
  });

test("an editor Save writes exactly one example.saved point carrying the browser's saved-demo taxonomy", async () => {
  const { env, ctx, saved } = setup();
  const res = await worker.fetch(patch({ files: FILES, htVersion: "16.0.2", exampleHtMajor: "16" }), env, ctx);
  assert.equal(res.status, 200);
  const points = await saved();
  assert.equal(points.length, 1, `expected exactly 1 example.saved point, got ${points.length}`);

  // The row the browser path produced for this save: `App.tsx` opens a saved
  // demo with its id as the lineage, and its facade attrs become the AE point.
  const browser = toAePoint(
    "example.saved",
    { count: 1 },
    {
      service_name: "demos-authoring",
      service_version: "authoring-sha",
      environment: "production",
      ...exampleActionAttrs(exampleTaxonomy({ lineage: DEMO_ID, framework: "react", htMajor: "16" })),
    },
  );
  const [point] = points;
  assert.deepEqual(point.indexes, browser.indexes);
  assert.deepEqual(point.blobs.slice(2), browser.blobs.slice(2), "blob3..blob20 match the browser's row");
  assert.deepEqual(point.doubles, browser.doubles);
  assert.equal(point.blobs[0], "demos-api");
  assert.equal(point.blobs[1], "api-sha");
  assert.equal(point.blobs[16], "saved");
  assert.equal(point.blobs[17], DEMO_ID);
});

test("the point's ht_major is the major the editor opened the demo at, not the version the Save pins", async () => {
  const { env, ctx, saved } = setup();
  const res = await worker.fetch(patch({ files: FILES, htVersion: "16.0.2", exampleHtMajor: "15" }), env, ctx);
  assert.equal(res.status, 200);
  const points = await saved();
  assert.equal(points.length, 1);
  assert.equal(points[0].blobs[6], "15");
});

test("an unauthenticated Save writes no example.saved point", async () => {
  const { env, ctx, saved } = setup();
  const res = await worker.fetch(patch({ files: FILES, exampleHtMajor: "16" }, { auth: false }), env, ctx);
  assert.equal(res.status, 401);
  assert.equal((await saved()).length, 0);
});

test("a Save of someone else's demo writes no example.saved point", async () => {
  const { env, ctx, saved } = setup([demoRow({ id: DEMO_ID, created_by: "other@handsontable.com" })]);
  const res = await worker.fetch(patch({ files: FILES, exampleHtMajor: "16" }), env, ctx);
  assert.equal(res.status, 403);
  assert.equal((await saved()).length, 0);
});

test("a Save refused while a build is running writes no example.saved point", async () => {
  const { env, ctx, saved } = setup([
    demoRow({ id: DEMO_ID, build_status: "building", updated_at: new Date().toISOString() }),
  ]);
  const res = await worker.fetch(patch({ files: FILES, exampleHtMajor: "16" }), env, ctx);
  assert.equal(res.status, 409);
  assert.equal((await saved()).length, 0);
});

test("a Save whose rebuild fails writes no example.saved point", async () => {
  const { env, ctx, saved } = setup();
  env.ARTIFACTS.put = async () => {
    throw new Error("R2 unavailable");
  };
  const res = await worker.fetch(patch({ files: FILES, exampleHtMajor: "16" }), env, ctx);
  assert.ok(res.status >= 500, `expected a 5xx, got ${res.status}`);
  assert.equal((await saved()).length, 0);
});

test("a metadata-only PATCH (the Edit info dialog) writes no example.saved point", async () => {
  const { env, ctx, saved } = setup();
  const res = await worker.fetch(patch({ title: "Renamed", exampleHtMajor: "16" }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal((await saved()).length, 0);
});

test("a Save without a valid exampleHtMajor (closed telemetry gate, a caller that omits it) writes no point", async () => {
  for (const exampleHtMajor of [undefined, "", "20", 16, "latest"]) {
    const { env, ctx, saved } = setup();
    const res = await worker.fetch(patch({ files: FILES, exampleHtMajor }), env, ctx);
    assert.equal(res.status, 200, `status for ${JSON.stringify(exampleHtMajor)}`);
    assert.equal((await saved()).length, 0, `points for ${JSON.stringify(exampleHtMajor)}`);
  }
});

test("every rebuild response carries the exampleSaved marker, true only when the point is written", async () => {
  for (const [exampleHtMajor, expected] of [["16", true], [undefined, false], ["20", false]]) {
    const { env, ctx } = setup();
    const res = await worker.fetch(patch({ files: FILES, exampleHtMajor }), env, ctx);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.exampleSaved, expected, `exampleSaved for ${JSON.stringify(exampleHtMajor)}`);
  }
});

test("a metadata-only PATCH carries no exampleSaved marker", async () => {
  const { env, ctx } = setup();
  const res = await worker.fetch(patch({ title: "Renamed", exampleHtMajor: "16" }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal("exampleSaved" in (await res.json()), false);
});

test("the rebuild and its point are handed to waitUntil, so a client disconnect cannot cancel them", async () => {
  // The oracle is the D1 write and the point completing through `waitUntil`
  // alone: the rebuild is held until the handler has registered its work.
  const { env, ctx, pending, points } = setup();
  let release;
  const gate = new Promise((r) => { release = r; });
  const put = env.ARTIFACTS.put.bind(env.ARTIFACTS);
  env.ARTIFACTS.put = async (...args) => { await gate; return put(...args); };
  const writes = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (/UPDATE demos SET ht_version=/.test(sql)) writes.push(sql); return prepare(sql); };

  const response = worker.fetch(patch({ files: FILES, exampleHtMajor: "16" }), env, ctx);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(pending.length >= 1, "the save must be registered with waitUntil before it settles");
  release();
  await Promise.all(pending);
  assert.equal(writes.length, 1, "the waitUntil promise covers the D1 update");
  assert.equal(points.filter((p) => p.indexes[0] === "example.saved").length, 1, "and the point");
  assert.equal((await response).status, 200);
});
