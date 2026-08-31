// Route-level proof for the MCP endpoints (DEV-2501, ADR-0033): POST
// /api/mcp/demos and PATCH /api/mcp/demos/:id, driven through the REAL router —
// the default export of workers/api/src/index.ts — not through re-declared
// copies of its checks. Until this spec, nothing imported the router at all, so
// every status code and response shape it promises was untested.
//
// The worker loads under plain `node --test` via the module hooks in
// fixtures/worker-hooks.mjs (registered below, before the import). Bindings are
// in-memory fakes covering exactly what these two routes touch: D1 (with a
// recorded write log), KV, and R2 — shared with demo-routes-version.test.mjs
// via fixtures/worker-harness.mjs. No route under test may reach a container —
// the create path is steered through createDemo()'s build-cache-hit branch
// (itself production code) by a fake build_cache row, and the sandbox stub
// throws if anything asks for a container anyway.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
// The harness imports nothing from the worker's source tree, so its (hoisted)
// evaluation before register() below is safe — see its own header comment.
import {
  AUTHOR,
  SECRET,
  ctx,
  demoRow,
  makeEnv,
  seedCatalog,
  sourceSnapshot,
} from "./fixtures/worker-harness.mjs";

// register() is synchronous by contract: it blocks until the hooks module's
// initialize has completed and returns void — nothing to await (node:module
// docs). The worker imports below are dynamic, so they evaluate strictly
// after the .js→.ts remap and the sandbox stub are live.
register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");
const { demoListQuery } = await import("../workers/api/src/demos-list.ts");

// devDependencies.vite satisfies the toolchain gate (validateBuildToolchain):
// every framework these fixtures build with (react, and demoRow()'s "react")
// runs `vite build` as the last step of its buildCommand.
const FILES = {
  "/package.json": JSON.stringify({ name: "demo", devDependencies: { vite: "^5.4.0" } }),
  "/index.js": "console.log(1)",
};

const PR_URL = "https://pkg.pr.new/handsontable@13106";

/** A minimal workspace whose /package.json pins Handsontable to `dep`. */
const filesWith = (dep) => ({
  "/package.json": JSON.stringify({
    name: "demo",
    dependencies: { handsontable: dep },
    devDependencies: { vite: "^5.4.0" },
  }),
  "/index.js": "console.log(1)",
});

const mcpHeaders = {
  "Content-Type": "application/json",
  "X-MCP-Secret": SECRET,
  "X-Demo-Author": AUTHOR,
};

const createRequest = (body) =>
  new Request("https://demos.handsontable.com/api/mcp/demos", {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify(body),
  });

const patchRequest = (id, body = { files: FILES }) =>
  new Request(`https://demos.handsontable.com/api/mcp/demos/${id}`, {
    method: "PATCH",
    headers: mcpHeaders,
    body: JSON.stringify(body),
  });

// ---- create ------------------------------------------------------------------

test("a manifest that cannot run the framework's build is refused before a container is booted", async () => {
  const { env, writes, artifacts } = makeEnv();
  const res = await worker.fetch(
    createRequest({
      framework: "react",
      title: "Grid",
      description: "A sortable grid", // every other gate satisfied on purpose
      files: {
        "/package.json": JSON.stringify({
          name: "demo",
          dependencies: { handsontable: "16.0.0", react: "18.3.1" },
        }),
        "/index.js": "console.log(1)",
      },
    }),
    env,
    ctx,
  );
  assert.equal(res.status, 400);
  // THE discriminating assertion: refused, and refused for the right reason.
  assert.match((await res.json()).error, /\bvite\b/);
  assert.deepEqual(writes, [], "no D1 write for a payload that cannot build");
  assert.deepEqual(artifacts.puts, [], "no artifact stored for a payload that cannot build");
});

test("an MCP demo without a description is refused before it is built", async () => {
  const { env, writes, artifacts } = makeEnv();
  const res = await worker.fetch(
    createRequest({ framework: "react", title: "Grid", files: FILES }),
    env,
    ctx,
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /description is required/);
  // Refused up front: nothing was written, no artifact was stored, no build ran.
  assert.deepEqual(writes, [], "no D1 write may happen for a refused create");
  assert.deepEqual(artifacts.puts, [], "no artifact may be stored for a refused create");
});

test("a created demo answers with the four links and its owner", async () => {
  const { env } = makeEnv();
  // FILES pins nothing, so the route resolves npm `latest`; seeded so this
  // spec never depends on a live registry (it used to — fetch-spy proven).
  await seedCatalog(env);
  const res = await worker.fetch(
    createRequest({ framework: "react", title: "Grid", description: "A sortable grid", files: FILES }),
    env,
    ctx,
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  // Exactly these keys — an agent navigates by them, so a dropped or renamed
  // link is a breaking change of the MCP contract. `htVersion` joined the
  // response when the version catalog moved server-side (master, ht-version.ts)
  // — this assertion caught that addition, which is its job; grew, reviewed,
  // admitted.
  assert.deepEqual(
    Object.keys(body).sort(),
    ["createdBy", "editUrl", "embedUrl", "htVersion", "id", "shareUrl", "url"],
  );
  assert.equal(body.url, `/d/${body.id}`);
  assert.equal(body.embedUrl, `/embed/${body.id}`);
  assert.equal(body.editUrl, `/edit/${body.id}`);
  assert.equal(body.shareUrl, `/share/${body.id}`);
  assert.equal(body.createdBy, AUTHOR);
  // Concrete, not a dist-tag: the agent pins its follow-up update to this.
  // The exact seeded value, not a shape regex — a live-npm `latest` would also
  // match /^\d+\.\d+\.\d+/, so a shape match could pass with the seeded catalog
  // silently ignored (a drifted CACHE key) and the registry dependency back.
  assert.equal(body.htVersion, "16.2.0");
});

test("a created demo is written with the caller as its owner, and its owner's listing finds it", async () => {
  const { env, writes, demos } = makeEnv();
  await seedCatalog(env); // see the create test above — no live npm
  const res = await worker.fetch(
    createRequest({ framework: "react", title: "Grid", description: "A sortable grid", files: FILES }),
    env,
    ctx,
  );
  assert.equal(res.status, 201);
  const { id } = await res.json();

  const insert = writes.find((w) => /INSERT OR REPLACE INTO demos/.test(w.sql));
  assert.ok(insert, "the create route must insert a demos row");
  const row = demos.get(id);
  assert.equal(row.created_by, AUTHOR, "the asserted author is the stored owner");
  assert.match(row.forked_from, /^mcp:/, "provenance is stamped, or the demo can never be MCP-updated");

  // The row lands in the owner's "My demos": the same query GET /api/demos runs
  // for scope=mine matches it (the audit's G5 concern, router-side).
  const { sql, binds } = demoListQuery("mine", AUTHOR);
  assert.match(sql, /LOWER\(created_by\) = \?/);
  assert.equal(row.created_by.toLowerCase(), binds[0], "the stored owner matches the listing's bind");
});

// ---- update: every refusal the guard chain promises ---------------------------

test("someone else's demo is 403, even with a valid secret", async () => {
  const { env, writes } = makeEnv([
    demoRow({ created_by: "other@handsontable.com", forked_from: "mcp:react" }),
  ]);
  const res = await worker.fetch(patchRequest("abc123"), env, ctx);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "forbidden");
  assert.match(body.detail, /belongs to someone else/);
  assert.deepEqual(writes, [], "a refused update must not write");
});

test("a browser-made demo is 403 through the MCP, and says where to edit it", async () => {
  const { env, writes } = makeEnv([demoRow({ forked_from: "catalog:react" })]);
  const res = await worker.fetch(patchRequest("abc123"), env, ctx);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "forbidden");
  assert.match(body.detail, /not created through the MCP/);
  assert.match(body.detail, /\/edit\//, "the refusal points at the browser editor");
  assert.deepEqual(writes, [], "a refused update must not write");
});

test("a revoked demo is gone, not rebuilt", async () => {
  const { env, writes, artifacts } = makeEnv([
    demoRow({ revoked: 1, revoked_at: "2026-08-16T00:00:00.000Z" }),
  ]);
  const res = await worker.fetch(patchRequest("abc123"), env, ctx);
  assert.equal(res.status, 410);
  assert.equal((await res.json()).error, "gone");
  assert.deepEqual(writes, [], "a revoked demo must not be written to");
  assert.deepEqual(artifacts.puts, [], "a revoked demo must not get fresh artifacts");
});

test("an unknown demo is 404", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(patchRequest("nosuchid"), env, ctx);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "not found");
});

// ---- update: version resolution on the rebuild path (DEV-2565) ----------------
//
// The bug class: both create routes used to store `body.htVersion ?? "latest"`
// verbatim — a dist-tag sentinel the validator rejects — so /edit refused to
// boot and Save re-sent a ref pnpm reads as a registry range. The fix derives a
// concrete ref (payload pin → trusted tag → previous row → catalog) before
// updateDemo() runs; these specs prove the MCP rebuild handler actually wires
// that resolution, which until now had zero version assertions.

test("an MCP rebuild derives the bare ref from a pkg.pr.new-pinned payload and repairs a sentinel row", async () => {
  // A legacy row holding the "latest" sentinel — the exact shape DEV-2565 left
  // behind — whose owner now re-saves files pinned to a PR build, saying
  // nothing about htVersion. The promise: the demo stays on the build its own
  // package.json asks for (bare ref in D1, exact URL in the snapshot), and the
  // sentinel is repaired rather than re-stored.
  const { env, writes, artifacts } = makeEnv([demoRow({ ht_version: "latest" })]);
  const res = await worker.fetch(patchRequest("abc123", { files: filesWith(PR_URL) }), env, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rebuilt, true);
  // The bare ref, never the URL: the column must hold what the validator
  // accepts, or the next /edit boot refuses the demo all over again.
  assert.equal(body.htVersion, "13106");
  // updateDemo's UPDATE is the write oracle (parseDemosInsert only reads
  // INSERTs): bind order is ht_version, files_hash, updated_at, ..., id.
  const update = writes.find((w) => /UPDATE demos SET ht_version=/.test(w.sql));
  assert.ok(update, "the rebuild must update the demos row");
  assert.equal(update.binds[0], "13106", "the sentinel row is repaired to the derived ref");
  assert.equal(update.binds.at(-1), "abc123");
  // Fixed point: the server-side re-pin must hand the install the same URL the
  // caller pinned — compared as the parsed dependency value, because the pin
  // re-serialises package.json (2-space indent) and byte equality cannot pass.
  const snapshot = sourceSnapshot(artifacts, "abc123");
  assert.equal(JSON.parse(snapshot.files["/package.json"]).dependencies.handsontable, PR_URL);
});

test("an MCP rebuild lets an explicit 'latest' outrank the payload's own pin (trustDistTag)", async () => {
  // The service path's one lever for moving a demo OFF a PR build: hot-mcp
  // forwards the model's own request, so an explicit tag there must beat the
  // pin the files still carry (trustDistTag at index.ts's MCP PATCH handler).
  // If the route dropped the flag, the pin would win and '13106' would land
  // here instead — the deliberate inverse of the browser-PATCH tag test in
  // demo-routes-version.test.mjs. The seeded catalog value is the only place
  // '16.2.0' exists, so the assertion cannot pass via a live registry.
  const { env, writes, artifacts } = makeEnv([demoRow({ ht_version: "latest" })]);
  await seedCatalog(env, "16.2.0");
  const res = await worker.fetch(
    patchRequest("abc123", { htVersion: "latest", files: filesWith(PR_URL) }),
    env,
    ctx,
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).htVersion, "16.2.0");
  const update = writes.find((w) => /UPDATE demos SET ht_version=/.test(w.sql));
  assert.ok(update, "the rebuild must update the demos row");
  assert.equal(update.binds[0], "16.2.0");
  // The pin follows the winning ref: the PR URL is rewritten to the release.
  const snapshot = sourceSnapshot(artifacts, "abc123");
  assert.equal(JSON.parse(snapshot.files["/package.json"]).dependencies.handsontable, "16.2.0");
});

test("an MCP rebuild refuses an invalid explicit ref with the validator's message and writes nothing", async () => {
  // The 400 must come from the shared validator, before the budget gate, the
  // usage event, and updateDemo — a bad ref costs the caller nothing, not a
  // container boot on a doomed install. Empty write log = no usage event
  // either, which is why deepEqual([], ...) is the right oracle here and only
  // on refusal paths (success paths log usage/build_cache writes too).
  const { env, writes, artifacts } = makeEnv([demoRow()]);
  const res = await worker.fetch(
    patchRequest("abc123", { htVersion: "not-a-version", files: filesWith("16.0.2") }),
    env,
    ctx,
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /semver-valid or a pkg\.pr\.new id\/URL/);
  assert.deepEqual(writes, [], "a refused rebuild must not write");
  assert.deepEqual(artifacts.puts, [], "a refused rebuild must not store artifacts");
});
