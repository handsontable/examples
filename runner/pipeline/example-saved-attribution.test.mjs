// `example.saved` is attributed to the example the demo came from (DEV-3146).
// The Examples funnel reads `blob17='docs'` grouped by area, so a save has to carry
// its source example's kind/ref/area, not the demo id. Driven through the real
// router with the shared fakes, like example-saved-point.test.mjs.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/example-saved-attribution.test.mjs

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { AUTHOR, demoRow, makeEnv } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");

const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://login.invalid") && init?.headers?.Authorization === "Bearer test-token") {
    return Response.json({ email: AUTHOR, sub: "u1" });
  }
  throw new Error(`unexpected network fetch in example-saved-attribution.test.mjs: ${url}`);
};
after(() => {
  globalThis.fetch = REAL_FETCH;
});

const DEMO_ID = "abc123";
const DOCS_PATH = "guides/accessibility/accessibility/react/example2.tsx";
const DOCS_GUIDE = "guides/accessibility/accessibility/accessibility.md";
const FILES = {
  "/package.json": JSON.stringify({ name: "demo", dependencies: { handsontable: "16.0.2" } }),
  "/index.js": "console.log(1)",
};

function setup(rows) {
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
  return { env, ctx, saved };
}

const patch = (body) =>
  new Request(`https://demos.handsontable.com/api/demos/${DEMO_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });

const SAVE = { files: FILES, htVersion: "16.0.2", exampleHtMajor: "16" };

/** bucket (blob16), kind (blob17), ref (blob18), area (blob19) of the one point a Save writes. */
async function savedBlobs(rows) {
  const { env, ctx, saved } = setup(rows);
  const res = await worker.fetch(patch(SAVE), env, ctx);
  assert.equal(res.status, 200);
  const points = await saved();
  assert.equal(points.length, 1);
  const [point] = points;
  return { kind: point.blobs[16], ref: point.blobs[17], area: point.blobs[18], bucket: point.blobs[15] };
}

const row = (forked_from, id = DEMO_ID) => demoRow({ id, framework: "react", ht_version: "16.0.2", forked_from });

test("a save of a docs fork is attributed to its guide and area, the row its example.open carried", async () => {
  const got = await savedBlobs([row(`docs:18.1:${DOCS_PATH}`)]);
  assert.deepEqual(got, { kind: "docs", ref: DOCS_GUIDE, area: "Accessibility", bucket: "18.1" });
});

test("a save of a starter fork is attributed to the starter", async () => {
  const got = await savedBlobs([row("catalog:react")]);
  assert.equal(got.kind, "starter");
  assert.equal(got.ref, "react");
});

test("a save of a fork of a saved demo follows the lineage back to the example", async () => {
  const got = await savedBlobs([row("parent1"), row("parent2", "parent1"), row(`docs:next:${DOCS_PATH}`, "parent2")]);
  assert.equal(got.kind, "docs");
  assert.equal(got.ref, DOCS_GUIDE);
});

test("a lineage that loops, runs too deep, or ends nowhere stays kind=saved with the demo id", async () => {
  const loop = await savedBlobs([row("other"), row(DEMO_ID, "other")]);
  assert.deepEqual([loop.kind, loop.ref], ["saved", DEMO_ID]);

  const chain = [row("h1")];
  for (let i = 1; i <= 8; i++) chain.push(row(i === 8 ? "catalog:react" : `h${i + 1}`, `h${i}`));
  const deep = await savedBlobs(chain);
  assert.deepEqual([deep.kind, deep.ref], ["saved", DEMO_ID]);

  const dangling = await savedBlobs([row("gone")]);
  assert.deepEqual([dangling.kind, dangling.ref], ["saved", DEMO_ID]);
});

test("an MCP demo and a docs path the taxonomy does not know stay kind=saved with the demo id", async () => {
  for (const forked_from of ["mcp:react", "docs:18.1:guides/nope/nope/react/example1.tsx", "docs:18.1:__proto__", null]) {
    const got = await savedBlobs([row(forked_from)]);
    assert.deepEqual([got.kind, got.ref], ["saved", DEMO_ID], String(forked_from));
  }
});

test("a lineage read that throws costs the attribution, never the save", async () => {
  const { env, ctx, saved } = setup([row("parent1")]);
  const get = env.CACHE.get.bind(env.CACHE);
  env.CACHE.get = async (key, ...rest) => {
    if (key === "demo:parent1") throw new Error("KV down");
    return get(key, ...rest);
  };
  const res = await worker.fetch(patch(SAVE), env, ctx);
  assert.equal(res.status, 200);
  const [point] = await saved();
  assert.deepEqual([point.blobs[16], point.blobs[17]], ["saved", DEMO_ID]);
});

test("the lineage walk reads at most 5 parents, and only after the demo's own D1 update was issued", async () => {
  const { env, ctx, saved } = setup([
    row("h1"), ...Array.from({ length: 8 }, (_, i) => row(`h${i + 2}`, `h${i + 1}`)),
  ]);
  const events = [];
  const get = env.CACHE.get.bind(env.CACHE);
  env.CACHE.get = async (key, ...rest) => {
    if (key.startsWith("demo:h")) events.push(key);
    return get(key, ...rest);
  };
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (/UPDATE demos SET ht_version=/.test(sql)) events.push("update");
    return prepare(sql);
  };
  const res = await worker.fetch(patch(SAVE), env, ctx);
  assert.equal(res.status, 200);
  await saved();
  assert.equal(events.filter((e) => e !== "update").length, 5);
  assert.equal(events[0], "update", "the save is registered before any lineage read");
});

test("no lineage read happens when the Save writes no point", async () => {
  const { env, ctx } = setup([row("parent1")]);
  const lookups = [];
  const get = env.CACHE.get.bind(env.CACHE);
  env.CACHE.get = async (key, ...rest) => {
    lookups.push(key);
    return get(key, ...rest);
  };
  const res = await worker.fetch(patch({ files: FILES, htVersion: "16.0.2" }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(lookups.includes("demo:parent1"), false);
});
