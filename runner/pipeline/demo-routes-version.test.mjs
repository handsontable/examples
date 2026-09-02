// Route-level proof of Handsontable version resolution on the browser share
// routes (DEV-2565): POST /api/demos and PATCH /api/demos/:id, driven through
// the REAL router — the default export of workers/api/src/index.ts. The bug
// class: both create routes used to store `body.htVersion ?? "latest"`
// verbatim, and that dist-tag sentinel — a string the validator rejects —
// broke /edit (boot refusal) and Save (a bare PR ref reached pnpm as a
// registry range). The fix derives a concrete ref (payload pin → tag →
// previous row → catalog) and pins the files server-side; until this spec,
// only the resolver had tests — no spec proved these two handlers wire it.
//
// Bindings are the shared in-memory fakes from fixtures/worker-harness.mjs.
// Two stubs specific to this file:
//  - the login broker: `authenticate()` live-fetches LOGIN_BROKER_URL, so a
//    global fetch stub answers "Bearer test-token" with the team identity —
//    the real production auth path, not the DEV_AUTH_EMAIL loopback bypass;
//  - the same stub THROWS on every other URL, doubling as a no-network
//    tripwire: an un-seeded fallthrough to npm surfaces as a 502 (inside
//    fetchVersionCatalog) instead of silently passing against live `latest`.
//
// Build prerequisite: `npm --prefix packages/runtime run build` — the worker
// imports @handsontable/demo-runtime from dist/, and a stale dist fails the
// whole file with ERR_MODULE_NOT_FOUND (the root `npm test` script builds it).
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
// The harness imports nothing from the worker's source tree, so its (hoisted)
// evaluation before register() below is safe — see its own header comment.
import {
  AUTHOR,
  ctx,
  demoRow,
  makeEnv,
  seedCatalog,
  sourceSnapshot,
} from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");

// ---- the broker stub / network tripwire ----------------------------------------

/** Captured once, before the stub is installed. */
const REAL_FETCH = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  // authenticate() forwards the caller's Authorization header to the broker
  // and trusts only the returned email — answer exactly that exchange.
  if (url.startsWith("https://login.invalid") && init?.headers?.Authorization === "Bearer test-token") {
    return Response.json({ email: AUTHOR, sub: "u1" });
  }
  // Anything else is a test escaping its sandbox. A throw inside
  // authenticate's try/catch reads as 401, inside fetchVersionCatalog as 502 —
  // both fail the asserting test loudly instead of reaching a live registry.
  throw new Error(`unexpected network fetch in demo-routes-version.test.mjs: ${url}`);
};

// node --test runs each file in its own process, so nothing leaks either way —
// restored anyway, out of hygiene.
after(() => {
  globalThis.fetch = REAL_FETCH;
});

// ---- fixtures ------------------------------------------------------------------

const PR_URL = "https://pkg.pr.new/handsontable@13106";

/**
 * A minimal workspace whose /package.json pins Handsontable to `dep`. Kept to
 * two tiny files so the pin's re-serialisation can never trip a size cap and
 * turn a version test into something else.
 */
const filesWith = (dep) => ({
  "/package.json": JSON.stringify({ name: "demo", dependencies: { handsontable: dep } }),
  "/index.js": "console.log(1)",
});

/** A workspace with no Handsontable dependency at all — nothing to derive. */
const FILES_NO_DEP = { "/package.json": '{"name":"demo"}', "/index.js": "console.log(1)" };

const authHeaders = {
  "Content-Type": "application/json",
  Authorization: "Bearer test-token",
};

const createRequest = (body) =>
  new Request("https://demos.handsontable.com/api/demos", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body),
  });

const patchRequest = (id, body) =>
  new Request(`https://demos.handsontable.com/api/demos/${id}`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify(body),
  });

/** The parsed handsontable dependency the stored source snapshot pins. */
const snapshotDep = (artifacts, id) =>
  JSON.parse(sourceSnapshot(artifacts, id).files["/package.json"]).dependencies.handsontable;

/** The rebuild handler's D1 oracle: updateDemo's column-by-column UPDATE.
 *  parseDemosInsert only reads INSERTs, so the write log is read directly —
 *  bind order is ht_version, files_hash, updated_at, ..., id (share.ts). */
function findVersionUpdate(writes) {
  return writes.find((w) => /UPDATE demos SET ht_version=/.test(w.sql));
}

// ---- POST /api/demos -------------------------------------------------------------

test("a browser create derives the version from the payload's own pin when htVersion is absent", async () => {
  // The editor's Save sends only files for a demo whose package.json already
  // pins a release; the route must derive that pin, never default to the
  // "latest" sentinel (the DEV-2565 bug) or resolve npm behind the caller's
  // back. The catalog is deliberately NOT seeded: with the throwing fetch
  // stub, any registry fallthrough fails as 502, proving derivation was local.
  const { env, demos, artifacts } = makeEnv();
  const res = await worker.fetch(
    createRequest({ framework: "react", title: "Grid", files: filesWith("16.0.2") }),
    env,
    ctx,
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.htVersion, "16.0.2");
  assert.equal(demos.get(body.id).ht_version, "16.0.2", "the derived ref is what the row stores");
  // The stored snapshot is the pin's only artifact-side observable (built
  // output never exists under the fake build-cache hit).
  assert.equal(snapshotDep(artifacts, body.id), "16.0.2");
});

test("a browser create resolves an explicit 'latest' to the catalog's concrete release", async () => {
  // "latest" names a moving target; the column has to hold a ref the editor
  // can validate, so the tag must leave as a release. '16.2.0' exists only in
  // the seeded catalog — an exact-equality assertion on it cannot be satisfied
  // by a live registry, unlike a /\d+\.\d+\.\d+/ match.
  const { env, demos, artifacts } = makeEnv();
  await seedCatalog(env, "16.2.0");
  const res = await worker.fetch(
    // The dep is the 'latest' range too, so handsontableDependencyRef yields
    // null and the tag is genuinely what answers.
    createRequest({ framework: "react", title: "Grid", htVersion: "latest", files: filesWith("latest") }),
    env,
    ctx,
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.htVersion, "16.2.0");
  assert.equal(demos.get(body.id).ht_version, "16.2.0", "never the sentinel");
  assert.equal(snapshotDep(artifacts, body.id), "16.2.0", "the 'latest' range was rewritten to the release");
});

test("a browser create refuses an invalid explicit ref with the validator's message and writes nothing", async () => {
  // The 400 carries the shared validator's own message and lands before the
  // budget gate, the usage event, and createDemo — a bad ref costs nothing.
  // Empty write log = no usage event either; deepEqual([]) is the right oracle
  // on refusal paths only (success paths log usage/build_cache writes too).
  const { env, writes, artifacts } = makeEnv();
  const res = await worker.fetch(
    createRequest({ framework: "react", title: "Grid", htVersion: "not-a-version", files: filesWith("16.0.2") }),
    env,
    ctx,
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /semver-valid or a pkg\.pr\.new id\/URL/);
  assert.deepEqual(writes, [], "no D1 write may happen for a refused create");
  assert.deepEqual(artifacts.puts, [], "no artifact may be stored for a refused create");
});

test("a browser create is a fixed point for files already pinned to a pkg.pr.new build", async () => {
  // A caller pinning a PR build asks for that build; re-pinning it to npm
  // latest would rebuild the demo against a different core — worse than the
  // bug being fixed. Stored: the BARE ref (what the validator accepts), while
  // the snapshot keeps the exact URL. Compared as the parsed dependency value:
  // the pin re-serialises package.json (2-space indent + newline), so byte
  // equality is a cannot-pass, and "some URL present" a cannot-fail.
  const { env, demos, artifacts } = makeEnv();
  const res = await worker.fetch(
    createRequest({ framework: "react", title: "Grid", files: filesWith(PR_URL) }),
    env,
    ctx,
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.htVersion, "13106", "the bare ref, never the URL");
  assert.equal(demos.get(body.id).ht_version, "13106");
  assert.equal(snapshotDep(artifacts, body.id), PR_URL, "the submitted URL survives the re-pin exactly");
});

// ---- PATCH /api/demos/:id (rebuild branch) ---------------------------------------

test("a browser rebuild derives from the payload pin and replaces a stale sentinel row", async () => {
  // The self-repair path: a row saved before DEV-2565 holds the "latest"
  // sentinel, and the owner's next Save must move it onto the ref the files
  // actually pin — not re-store the sentinel, not consult npm (no catalog is
  // seeded; a fallthrough would 502 on the throwing stub).
  const { env, writes, artifacts } = makeEnv([demoRow({ ht_version: "latest" })]);
  const res = await worker.fetch(patchRequest("abc123", { files: filesWith("16.0.2") }), env, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, htVersion: "16.0.2" });
  const update = findVersionUpdate(writes);
  assert.ok(update, "the rebuild must update the demos row");
  assert.equal(update.binds[0], "16.0.2", "the sentinel row is repaired to the derived ref");
  assert.equal(update.binds.at(-1), "abc123");
  assert.equal(snapshotDep(artifacts, "abc123"), "16.0.2");
});

test("a browser rebuild resolves an explicit 'latest' through the catalog when the files pin nothing", async () => {
  // On the browser path a dist-tag is demoted below the payload's own pin
  // (MyDemos' fork forwards legacy sentinels) — so here the files carry only
  // the 'latest' range, and the demoted tag is what genuinely answers. The
  // inverse wiring — tag OUTRANKING a pin — is the MCP path's contract,
  // asserted in mcp-routes.test.mjs.
  const { env, writes, artifacts } = makeEnv([demoRow({ ht_version: "latest" })]);
  await seedCatalog(env, "16.2.0");
  const res = await worker.fetch(
    patchRequest("abc123", { htVersion: "latest", files: filesWith("latest") }),
    env,
    ctx,
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).htVersion, "16.2.0");
  const update = findVersionUpdate(writes);
  assert.ok(update, "the rebuild must update the demos row");
  assert.equal(update.binds[0], "16.2.0", "changed off the seeded sentinel");
  assert.equal(snapshotDep(artifacts, "abc123"), "16.2.0");
});

test("a browser rebuild refuses an invalid explicit ref and leaves the demo untouched", async () => {
  // getDemo's SELECT is a read (first(), never logged), so an empty write log
  // really does mean the demo was left alone — no UPDATE, no usage event, no
  // artifacts, and the 400 is the validator's own message.
  const { env, writes, artifacts } = makeEnv([demoRow({ ht_version: "latest" })]);
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

test("a browser rebuild is a fixed point for already-pinned pkg.pr.new files and stores the bare ref", async () => {
  // Same promise as the create fixed point, on the path that broke in
  // production: Save re-sends the loaded files verbatim, so the server's
  // re-pin must not clobber the PR URL, and the row must move off the
  // sentinel onto the bare ref (URL in the column = the next /edit refusal).
  const { env, writes, artifacts } = makeEnv([demoRow({ ht_version: "latest" })]);
  const res = await worker.fetch(patchRequest("abc123", { files: filesWith(PR_URL) }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).htVersion, "13106");
  const update = findVersionUpdate(writes);
  assert.ok(update, "the rebuild must update the demos row");
  assert.equal(update.binds[0], "13106", "bare ref stored, sentinel gone");
  assert.equal(snapshotDep(artifacts, "abc123"), PR_URL, "the pinned URL survives the re-pin exactly");
});

test("a browser rebuild falls back to the row's previous concrete ref when the payload is silent", async () => {
  // Route-only wiring: `previousRef: row.ht_version` at the PATCH handler. The
  // files pin nothing and no htVersion is sent, so the row's own ref is all
  // that answers. If the route ever dropped previousRef, resolution would fall
  // through to npm latest — and with no catalog seeded, that regression fails
  // here as a 502 on the throwing stub instead of passing by luck.
  const { env, writes } = makeEnv([demoRow({ ht_version: "16.0.2" })]);
  const res = await worker.fetch(patchRequest("abc123", { files: FILES_NO_DEP }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).htVersion, "16.0.2");
  const update = findVersionUpdate(writes);
  assert.ok(update, "the rebuild must update the demos row");
  assert.equal(update.binds[0], "16.0.2", "the demo stays on the core it was built against");
});

// DEV-2741. A demo stored with an `index.html` that loads no module renders as an empty
// page everywhere. The write gate refuses that payload now; these are the demos already
// in the bucket, repaired the first time their source is read.
//
// Measured in production before the fix: `/api/demos/6n1lu5k2s3/source` returned
// `/index.html` = `<div id="grid" style="height: 460px; width: 100%;"></div>\n`, and the
// Tier-1 preview frame reported `window.__hotRunnerScheme === undefined` — the module
// entry, where that receiver is also injected, never ran at all.

const BLANK_HTML = '<div id="grid" style="height: 460px; width: 100%;"></div>\n';

const blankSource = (framework = "javascript") => ({
  "demos/abc123/__source.json": JSON.stringify({
    framework,
    files: {
      "/package.json": JSON.stringify({ dependencies: { handsontable: "18.1.0" } }),
      "/index.js": "console.log(1)",
      "/index.html": BLANK_HTML,
    },
  }),
});

const sourceRequest = (id) =>
  new Request(`https://demos.handsontable.com/api/demos/${id}/source`);

test("a stored demo whose index.html loads no module is repaired on read", async () => {
  const { env } = makeEnv([demoRow({ framework: "javascript" })], [], blankSource());
  const res = await worker.fetch(sourceRequest("abc123"), env, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(
    body.files["/index.html"],
    `${BLANK_HTML}<script type="module" src="/index.js"></script>\n`,
  );
  // Everything else is handed back untouched.
  assert.equal(body.files["/index.js"], "console.log(1)");
});

test("the repair is written back, so the next read does not redo it", async () => {
  const { env, artifacts } = makeEnv([demoRow({ framework: "javascript" })], [], blankSource());
  await worker.fetch(sourceRequest("abc123"), env, ctx);
  const stored = artifacts.puts.filter((p) => p.key === "demos/abc123/__source.json");
  assert.equal(stored.length, 1, "the repair is persisted once");
  assert.match(JSON.parse(stored[0].value).files["/index.html"], /<script type="module"/);

  const second = await worker.fetch(sourceRequest("abc123"), env, ctx);
  assert.equal((await second.json()).files["/index.html"], JSON.parse(stored[0].value).files["/index.html"]);
  assert.equal(
    artifacts.puts.filter((p) => p.key === "demos/abc123/__source.json").length,
    1,
    "a source that already loads its module is not rewritten again",
  );
});

test("a demo that already loads its module is served byte-identical and not rewritten", async () => {
  const html = '<body><div id="grid"></div><script type="module" src="/index.js"></script></body>';
  const { env, artifacts } = makeEnv([demoRow({ framework: "javascript" })], [], {
    "demos/abc123/__source.json": JSON.stringify({
      framework: "javascript",
      files: { "/package.json": "{}", "/index.js": "x", "/index.html": html },
    }),
  });
  const res = await worker.fetch(sourceRequest("abc123"), env, ctx);
  assert.equal((await res.json()).files["/index.html"], html);
  assert.deepEqual(artifacts.puts, [], "nothing is written for a demo that is already fine");
});

test("a browser Save of a script-less document stores the repaired index.html", async () => {
  // The counterpart to the MCP routes' 400 (DEV-2741). A person's Save is repaired
  // rather than refused: their preview already ran the demo — Tier 1 adds the tag to
  // the bundler's view of the files — so failing the Save would refuse work that was
  // visibly working, and the artifact would be built from a document with no bundle.
  const { env, artifacts } = makeEnv();
  const res = await worker.fetch(
    createRequest({
      framework: "javascript",
      title: "Grid",
      files: {
        "/package.json": JSON.stringify({ dependencies: { handsontable: "18.1.0" } }),
        "/index.js": "console.log(1)",
        "/index.html": '<div id="grid"></div>\n',
      },
    }),
    env,
    ctx,
  );
  assert.equal(res.status, 201);
  const stored = sourceSnapshot(artifacts, (await res.json()).id);
  assert.equal(
    stored.files["/index.html"],
    '<div id="grid"></div>\n<script type="module" src="/index.js"></script>\n',
  );
});

test("an Angular demo's script-less index.html is served and stored untouched", () => {
  // The write side of the same exemption: repairing Angular would persist a
  // `<script src="/src/main.ts">` into documents that were always correct.
  const html = "<!doctype html><html><body><app-root></app-root></body></html>";
  return (async () => {
    const { env, artifacts } = makeEnv([demoRow({ framework: "angular" })], [], {
      "demos/abc123/__source.json": JSON.stringify({
        framework: "angular",
        files: { "/package.json": "{}", "/src/main.ts": "export {};", "/src/index.html": html },
      }),
    });
    const res = await worker.fetch(sourceRequest("abc123"), env, ctx);
    assert.equal((await res.json()).files["/src/index.html"], html);
    assert.deepEqual(artifacts.puts, [], "nothing may be written for an Angular demo");
  })();
});
