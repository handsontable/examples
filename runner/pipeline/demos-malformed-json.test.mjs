// F33 (o11y-local-verification-findings.md): `POST /api/demos` and
// `PATCH /api/demos/:id` both called `request.json()` with no `.catch()`, so
// an unparseable body (or a JSON array where an object is expected — both
// pass `JSON.parse`, neither is a plain record) threw a raw `SyntaxError`/hit
// `body.framework` on a non-object past the handler, into the generic fetch
// catch-all — a 500 on ordinary client garbage that pollutes the
// `api.request` 5xx rate and the `api-5xx-rate` alert, same class the
// `/api/session` fix (session-malformed-json.test.mjs) already closed for
// the public, unauthenticated routes. These two are authenticated, but the
// body itself is still ordinary client input reachable by anything with a
// token. The fix reuses the exact same helper (`isPlainRecord`) and error
// shape as the session fix — no new abstraction needed.
//
// Driven through the REAL router (`workers/api/src/index.ts`'s default
// export), same rationale as demo-routes-version.test.mjs — a hand-rolled
// re-check of the body would not catch a regression in the actual route.
//
// Run: node --experimental-strip-types --test pipeline/demos-malformed-json.test.mjs

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { AUTHOR, ctx, demoRow, makeEnv } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");

// ---- the broker stub / network tripwire (same shape as demo-routes-version.test.mjs) ----

const REAL_FETCH = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://login.invalid") && init?.headers?.Authorization === "Bearer test-token") {
    return Response.json({ email: AUTHOR, sub: "u1" });
  }
  throw new Error(`unexpected network fetch in demos-malformed-json.test.mjs: ${url}`);
};

after(() => {
  globalThis.fetch = REAL_FETCH;
});

const authHeaders = {
  "Content-Type": "application/json",
  Authorization: "Bearer test-token",
};

function malformedJsonRequest(method, path) {
  return new Request(`https://demos.handsontable.com${path}`, {
    method,
    headers: authHeaders,
    // Not valid JSON — `request.json()` rejects on this body.
    body: "{ this is not json",
  });
}

function arrayBodyRequest(method, path) {
  return new Request(`https://demos.handsontable.com${path}`, {
    method,
    headers: authHeaders,
    // Valid JSON — parses fine — but not a plain record: `isPlainRecord`
    // must still reject it, same as the session fix's own array-body case.
    body: JSON.stringify([1, 2, 3]),
  });
}

// ---- POST /api/demos --------------------------------------------------------------

test("a malformed POST /api/demos body is a 400, not the fetch catch-all's 500", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(malformedJsonRequest("POST", "/api/demos"), env, ctx);
  assert.equal(res.status, 400, "must not reach the generic 500 catch-all");
  const body = await res.json();
  // Same error shape the /api/session fix uses (isPlainRecord's own 400).
  assert.equal(body.error, "request body must be a plain record");
});

test("a JSON array body on POST /api/demos is a 400, not a 500", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(arrayBodyRequest("POST", "/api/demos"), env, ctx);
  assert.equal(res.status, 400, "an array is valid JSON but not a plain record");
  const body = await res.json();
  assert.equal(body.error, "request body must be a plain record");
});

// ---- PATCH /api/demos/:id ----------------------------------------------------------

test("a malformed PATCH /api/demos/:id body is a 400, not the fetch catch-all's 500", async () => {
  const { env } = makeEnv([demoRow()]);
  const res = await worker.fetch(malformedJsonRequest("PATCH", "/api/demos/abc123"), env, ctx);
  assert.equal(res.status, 400, "must not reach the generic 500 catch-all");
  const body = await res.json();
  assert.equal(body.error, "request body must be a plain record");
});

test("a JSON array body on PATCH /api/demos/:id is a 400, not a 500", async () => {
  const { env } = makeEnv([demoRow()]);
  const res = await worker.fetch(arrayBodyRequest("PATCH", "/api/demos/abc123"), env, ctx);
  assert.equal(res.status, 400, "an array is valid JSON but not a plain record");
  const body = await res.json();
  assert.equal(body.error, "request body must be a plain record");
});
