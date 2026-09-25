// Malformed JSON on the session-family POST routes used to reach the generic
// fetch catch-all — an uncaught `SyntaxError` from `request.json()`, answered
// as a 500 — which pollutes the `api.request` 5xx rate and the `api-5xx-rate`
// alert with what is really a 400-shaped client mistake (pre-existing on
// master). `POST /api/session` is public and unauthenticated, so it is the
// easiest route on this Worker for arbitrary client garbage to reach; the
// runbook (`docs/run-and-deploy.md`) used to lean on exactly that as its
// deliberate catch-all probe (see the doc's own updated wording for why that
// probe moved).
//
// Both routes below already had the *shape* check in place
// (`isPlainRecord`/`validateFileWrite`, whose 400 the fetch catch-all already
// answers via `InvalidFilePathError`) — the only gap was that a body which
// doesn't even parse as JSON never reached that check at all. The fix is the
// same one-line `.catch(() => null)` `POST /api/theme` and `/api/chat` already
// use for the same reason.
//
// Driven through the REAL router (`workers/api/src/index.ts`'s default
// export) — same rationale as token-routes.test.mjs: a hand-rolled re-check
// of the body would not catch a regression in the actual route.
//
// Run: node --experimental-strip-types --test pipeline/session-malformed-json.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { ctx, makeEnv } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");

const HOST = "https://demos.handsontable.com";

function malformedJsonRequest(method, path) {
  return new Request(`${HOST}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    // Not valid JSON — `request.json()` rejects on this body.
    body: "{ this is not json",
  });
}

/** `api.request` (recordRequestSignal) writes an AE point for every request; with
 *  the bare `makeEnv()` env this falls through to the local-ClickHouse-HTTP sink
 *  (`serviceEnvironment`'s non-production branch) and makes a real network call to
 *  whatever is on :8123 on this machine — same fix as `snapshot-build-point.test.mjs`'s
 *  own `envWithPointCapture` helper: an in-memory sink routes the write away from
 *  the network entirely. */
function envWithPointCapture() {
  const { env, ...rest } = makeEnv();
  env.RUNNER_EVENTS = { writeDataPoint() {} };
  env.PREVIEW_HOST = "demos.handsontable.com";
  return { env, ...rest };
}

test("a malformed POST /api/session body is a 400, not the fetch catch-all's 500", async () => {
  const { env } = envWithPointCapture();
  const res = await worker.fetch(malformedJsonRequest("POST", "/api/session"), env, ctx);
  assert.equal(res.status, 400, "must not reach the generic 500 catch-all");
  const body = await res.json();
  // The existing error JSON shape (`isPlainRecord`'s own 400 for a body that
  // fails the record check) — a parse failure now lands in that same branch
  // rather than getting its own new shape.
  assert.equal(body.error, "request body must be a plain record");
});

test("a malformed POST /api/session/:id/file body is a 400, not a 500", async () => {
  const { env } = envWithPointCapture();
  const res = await worker.fetch(malformedJsonRequest("POST", "/api/session/sess-1/file"), env, ctx);
  assert.equal(res.status, 400, "must not reach the generic 500 catch-all");
  const body = await res.json();
  // validateFileWrite's own InvalidFilePathError message — unchanged by this
  // fix, just reachable for an unparseable body now instead of only a
  // wrong-shaped one.
  assert.equal(body.error, "file write must be a plain record");
});
