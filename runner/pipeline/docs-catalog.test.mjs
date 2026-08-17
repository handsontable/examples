// Response-shape guards for the docs catalog loaders (DEV-2535).
//
// The deployed host does NOT 404 a missing docs asset: apps/authoring/wrangler.jsonc
// sets `not_found_handling: "single-page-application"`, so Workers Assets answers
// 200 + index.html for every miss under /docs-examples/. Gating on `res.ok` alone
// therefore hands index.html to `res.json()`, and the resulting SyntaxError was
// classified as a transient fetch failure instead of a missing bucket/artifact.
//
// Every test uses a DISTINCT bucket name: `manifestPromises` and `entryCache` in
// docs-catalog.ts are module-scoped and survive across tests in this file.

import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchDocsManifest,
  loadDocsExample,
  isDocsResourceMissing,
} from "../apps/authoring/src/docs-catalog.ts";

const HTML = `<!doctype html><html><head></head><body><div id="root"></div></body></html>`;

/** A minimal Response-alike. `contentType: null` omits the header entirely —
 *  undici's `new Response(string)` always synthesises `text/plain`, so a real
 *  Response cannot express the no-content-type case. */
function reply({ status = 200, contentType = "application/json", body = "" }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

function manifestBody(bucket) {
  return JSON.stringify({
    bucket,
    docsBranch: `prod-docs/${bucket}`,
    generatedFrom: "unit fixture",
    hotVersion: "18.0.0",
    count: 0,
    examples: [],
  });
}

/** Install a fetch stub for one test and restore the real one afterwards. */
function withFetch(t, handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return handler(String(url), calls.length);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the promise to reject");
}

// --- fetchDocsManifest -----------------------------------------------------

test("manifest: an SPA fallback (200 + text/html) is a missing bucket, not a fetch failure", async (t) => {
  withFetch(t, () => reply({ contentType: "text/html", body: HTML }));

  const error = await rejection(fetchDocsManifest("spa-fallback"));

  assert.equal(isDocsResourceMissing(error), true);
  // The bucket key must ride along so Sentry groups per bucket: one bucket
  // failing is user traffic, every bucket failing is a broken deploy.
  assert.match(error.message, /spa-fallback/);
});

test("manifest: an HTML body with no content-type header at all is still a missing bucket", async (t) => {
  withFetch(t, () => reply({ contentType: null, body: HTML }));

  const error = await rejection(fetchDocsManifest("no-content-type"));

  assert.equal(isDocsResourceMissing(error), true);
});

test("manifest: a real 404 is a missing bucket (the dev-server / correct-host path)", async (t) => {
  withFetch(t, () => reply({ status: 404, contentType: "text/plain", body: "not found" }));

  const error = await rejection(fetchDocsManifest("real-404"));

  assert.equal(isDocsResourceMissing(error), true);
});

test("manifest: a 500 rejects but is NOT missing — a transient failure stays transient", async (t) => {
  withFetch(t, () => reply({ status: 500, contentType: "text/plain", body: "boom" }));

  const error = await rejection(fetchDocsManifest("server-error"));

  assert.equal(isDocsResourceMissing(error), false);
  assert.match(error.message, /500/);
});

test("manifest: the happy path parses and is fetched once per bucket", async (t) => {
  const calls = withFetch(t, () => reply({ body: manifestBody("happy") }));

  const first = await fetchDocsManifest("happy");
  const second = await fetchDocsManifest("happy");

  assert.equal(first.bucket, "happy");
  assert.equal(second, first);
  assert.equal(calls.length, 1);
});

test("manifest: valid JSON served with a wrong content-type still parses", async (t) => {
  withFetch(t, () => reply({ contentType: "text/plain", body: manifestBody("wrong-type") }));

  const manifest = await fetchDocsManifest("wrong-type");

  assert.equal(manifest.bucket, "wrong-type");
});

test("manifest: a 200 body that is neither HTML nor JSON rejects as non-missing", async (t) => {
  withFetch(t, () => reply({ contentType: "text/plain", body: "not json at all" }));

  const error = await rejection(fetchDocsManifest("garbage"));

  assert.equal(isDocsResourceMissing(error), false);
});

test("manifest: a rejected bucket is evicted from the cache so a retry can succeed", async (t) => {
  const calls = withFetch(t, (_url, n) => (n === 1
    ? reply({ contentType: "text/html", body: HTML })
    : reply({ body: manifestBody("retry") })));

  const error = await rejection(fetchDocsManifest("retry"));
  assert.equal(isDocsResourceMissing(error), true);

  const manifest = await fetchDocsManifest("retry");

  assert.equal(manifest.bucket, "retry");
  assert.equal(calls.length, 2);
});

// --- loadDocsExample -------------------------------------------------------

const DOCS_PATH = "guides/columns/column-adding/react/example2.tsx";

function entryBody(bucket) {
  return JSON.stringify({ framework: "react", docsPath: DOCS_PATH, files: { "/src/App.tsx": bucket } });
}

test("example: an SPA fallback is a missing artifact, not a fetch failure", async (t) => {
  const calls = withFetch(t, () => reply({ contentType: "text/html", body: HTML }));

  const error = await rejection(loadDocsExample("entry-spa", DOCS_PATH));

  assert.equal(isDocsResourceMissing(error), true);
  assert.match(error.message, /entry-spa/);
  assert.match(error.message, new RegExp(DOCS_PATH.replace(/[/.]/g, "\\$&")));
  assert.deepEqual(calls, [
    `/docs-examples/entry-spa/${DOCS_PATH.replace(/\//g, "__")}.json`,
  ]);
});

test("example: a real 404 is a missing artifact", async (t) => {
  withFetch(t, () => reply({ status: 404, contentType: "text/plain", body: "not found" }));

  const error = await rejection(loadDocsExample("entry-404", DOCS_PATH));

  assert.equal(isDocsResourceMissing(error), true);
});

test("example: a 500 rejects but is NOT missing", async (t) => {
  withFetch(t, () => reply({ status: 500, contentType: "text/plain", body: "boom" }));

  const error = await rejection(loadDocsExample("entry-500", DOCS_PATH));

  assert.equal(isDocsResourceMissing(error), false);
});

test("example: the happy path parses and caches per bucket+path", async (t) => {
  const calls = withFetch(t, () => reply({ body: entryBody("entry-happy") }));

  const first = await loadDocsExample("entry-happy", DOCS_PATH);
  const second = await loadDocsExample("entry-happy", DOCS_PATH);

  assert.equal(first.files["/src/App.tsx"], "entry-happy");
  assert.equal(second, first);
  assert.equal(calls.length, 1);
});

test("example: a failure is not cached, so a retry can succeed", async (t) => {
  const calls = withFetch(t, (_url, n) => (n === 1
    ? reply({ contentType: "text/html", body: HTML })
    : reply({ body: entryBody("entry-retry") })));

  await rejection(loadDocsExample("entry-retry", DOCS_PATH));
  const entry = await loadDocsExample("entry-retry", DOCS_PATH);

  assert.equal(entry.files["/src/App.tsx"], "entry-retry");
  assert.equal(calls.length, 2);
});
