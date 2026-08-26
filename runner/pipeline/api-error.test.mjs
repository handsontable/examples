// How an API failure is described to the user (DEV-2534).
//
// The point of the ticket: an expired session used to reach a toast as the
// worker's own wire string, "unauthorized". These assertions are what stop that
// string — and the Sentry issue behind it — from coming back.
//
// `apiError.ts` is imported straight from source under
// `--experimental-strip-types`, which is why that module is an import-free leaf
// written in erasable syntax only (no parameter properties, no `enum`). The
// sibling `api.ts` cannot be tested here: it imports `auth.js`, which touches
// `sessionStorage` and `import.meta.env`. It is covered in the Playwright spec.

import test from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  describeApiFailure,
  isSessionExpired,
} from "../apps/authoring/src/apiError.ts";

test("a 401 becomes a sentence about the session, never the wire string", () => {
  const failure = describeApiFailure(401, { error: "unauthorized" }, "save failed (401)");

  assert.equal(failure.kind, "session-expired");
  assert.equal(failure.status, 401);
  assert.equal(failure.reportable, false);
  assert.match(failure.message, /session expired/i);
  // The regression this ticket exists for.
  assert.doesNotMatch(failure.message, /unauthorized/i);
  assert.ok(failure instanceof ApiError);
  assert.ok(failure instanceof Error);
});

test("the 401 branch does not depend on the body at all", () => {
  // A 401 with no JSON body at all (`res.json()` rejected, so the caller hands
  // us `{}`) has to reach the same place: the status is the whole signal.
  const failure = describeApiFailure(401, {}, "save failed (401)");

  assert.equal(failure.kind, "session-expired");
  assert.equal(failure.reportable, false);
  assert.match(failure.message, /session expired/i);
});

test("a bare 403 names ownership and stays reportable", () => {
  // `{ error: "forbidden" }` with no detail is exactly what the PATCH and DELETE
  // ownership checks send (workers/api/src/index.ts:887 and :954).
  const failure = describeApiFailure(403, { error: "forbidden" }, "delete failed (403)");

  assert.equal(failure.kind, "forbidden");
  assert.equal(failure.status, 403);
  // Deliberate: the UI only draws Delete on a demo it believes is `mine`, so a
  // server refusal is a real UI/server disagreement and Sentry should see it.
  assert.equal(failure.reportable, true);
  assert.match(failure.message, /belongs to someone else/i);
  assert.doesNotMatch(failure.message, /forbidden/i);
});

test("a 403 that carries a detail surfaces it", () => {
  const failure = describeApiFailure(
    403,
    { error: "forbidden", detail: "this demo was not created through the MCP" },
    "save failed (403)",
  );

  assert.equal(failure.kind, "forbidden");
  assert.match(failure.message, /belongs to someone else/i);
  assert.match(failure.message, /not created through the MCP/);
});

test("every other status keeps the server's message, else the caller's fallback", () => {
  const withError = describeApiFailure(500, { error: "boom" }, "embed failed (500)");
  assert.equal(withError.kind, "other");
  assert.equal(withError.status, 500);
  assert.equal(withError.reportable, true);
  assert.equal(withError.message, "boom");

  const empty = describeApiFailure(500, {}, "embed failed (500)");
  assert.equal(empty.message, "embed failed (500)");
});

test("`preferFallback` keeps a callsite's own copy for the unclassified statuses", () => {
  // `MyDemos`'s list and revoke never read `body.error` — they throw their own
  // sentence. Migrating them onto the shared helper must not start rendering the
  // server's wire string where a human sentence used to be.
  const failure = describeApiFailure(500, { error: "boom" }, "Couldn't load your demos (500).", {
    preferFallback: true,
  });
  assert.equal(failure.message, "Couldn't load your demos (500).");

  // …but the two classified branches are the point of the ticket and are not
  // opt-out-able.
  const expired = describeApiFailure(401, { error: "unauthorized" }, "Delete failed (401).", {
    preferFallback: true,
  });
  assert.equal(expired.kind, "session-expired");
  assert.match(expired.message, /session expired/i);
});

test("a function fallback is called with the status", () => {
  // `profile.ts` inlines its `fetch` into the call, so it has no `res` in scope
  // to interpolate; it passes the shape of the message instead.
  const failure = describeApiFailure(502, {}, (status) => `Request failed (${status}).`);
  assert.equal(failure.message, "Request failed (502).");
});

test("isSessionExpired is true only for the 401 ApiError", () => {
  assert.equal(isSessionExpired(describeApiFailure(401, {}, "x")), true);
  assert.equal(isSessionExpired(describeApiFailure(403, { error: "forbidden" }, "x")), false);
  assert.equal(isSessionExpired(describeApiFailure(500, {}, "x")), false);
  assert.equal(isSessionExpired(new Error("unauthorized")), false);
  assert.equal(isSessionExpired(null), false);
  assert.equal(isSessionExpired("session-expired"), false);
});

test("a capability refusal reads as itself, not as an ownership problem (DEV-2583)", () => {
  // A persistent API token is fenced off AI features and the admin writes
  // (ADR-0037). Those refusals share the 403 status with the ownership checks,
  // and the ownership sentence is the wrong explanation for them: nothing
  // belongs to anybody else, the credential simply may not do this.
  const failure = describeApiFailure(
    403,
    { error: "token_forbidden", detail: "an API token cannot use the AI features" },
    "ask failed (403)",
  );

  assert.equal(failure.kind, "forbidden");
  assert.equal(failure.status, 403);
  assert.equal(failure.message, "an API token cannot use the AI features");
  assert.doesNotMatch(failure.message, /belongs to someone else/i);
  assert.doesNotMatch(failure.message, /token_forbidden/i, "never the wire string");
  // Not reportable: unlike an ownership 403, this is the fence working as
  // designed, so it is not a UI/server disagreement worth a Sentry issue.
  assert.equal(failure.reportable, false);
  assert.equal(isSessionExpired(failure), false, "a fence is not an expired session");
});

test("a token_forbidden without a detail still says something useful", () => {
  // Defensive: every route that sends this code sends a detail, but a proxy or
  // a truncated body must not produce an empty toast.
  const failure = describeApiFailure(403, { error: "token_forbidden" }, "ask failed (403)");

  assert.equal(failure.kind, "forbidden");
  assert.ok(failure.message.length > 0);
  assert.doesNotMatch(failure.message, /token_forbidden/i);
});

// ── A 403 that never reached the Worker (DEV-2631, ADR-0038) ────────────────────
//
// The Cloudflare Managed Ruleset blocks any request body containing `<script`, and
// 16 of the 19 frameworks ship an HTML entry that has one, so Fork/Save/Embed on
// demos.handsontable.com answered 403 with a Cloudflare error page. The default
// branch of this module then told owners their own demo belonged to someone else —
// a confident, specific, wrong sentence — and filed a Sentry issue saying so.
//
// The whole discrimination rests on one invariant: every 403 the Worker itself
// sends carries an `error` code. These tests are what hold both halves of that.

test("a 403 with no error code is an edge block, not an ownership refusal", () => {
  // What `res.json().catch(() => ({}))` in api.ts yields for a Cloudflare HTML page.
  const failure = describeApiFailure(403, {}, "fork failed (403)");

  assert.equal(failure.kind, "edge-blocked");
  assert.equal(failure.status, 403);
  assert.doesNotMatch(failure.message, /belongs to someone else/i, "the sentence that misled");
  assert.doesNotMatch(failure.message, /fork/i, "the action is not the cause");
  assert.match(failure.message, /blocked before it reached/i);
  assert.ok(failure instanceof ApiError);
  assert.equal(isSessionExpired(failure), false);
});

test("an edge block names the two things the ownership copy got wrong", () => {
  // Both conclusions were actually drawn from "fork failed (403)": logged in, button
  // visible, 403 — so it read as an entitlement bug, and the next move was to retry.
  const failure = describeApiFailure(403, {}, "save failed (403)");

  assert.match(failure.message, /not a login or permissions problem/i);
  assert.match(failure.message, /retrying will not/i);
});

test("an edge block is reportable, because nothing else can report it", () => {
  // Unlike the capability fence, this is not the system working as designed. And the
  // Worker never runs: no server-side event, no usage row, nothing in `wrangler tail`.
  // Silence this and an edge block becomes invisible from both ends at once.
  assert.equal(describeApiFailure(403, {}, "fork failed (403)").reportable, true);
});

test("an ownership 403 still keeps its own sentence", () => {
  // ⚠ THE ORDERING TEST. `PATCH /api/demos/:id` really does answer a bare
  // `{"error":"forbidden"}` for someone else's demo. Check for an empty body after the
  // ownership default instead of before it and this owner is sent hunting for a
  // firewall outage that is not happening.
  const failure = describeApiFailure(403, { error: "forbidden" }, "save failed (403)");

  assert.equal(failure.kind, "forbidden");
  assert.match(failure.message, /belongs to someone else/i);
  assert.doesNotMatch(failure.message, /blocked before it reached/i);
});

test("the edge branch does not swallow the capability fence", () => {
  // `token_forbidden` carries an error code, so it must never reach the edge branch —
  // it has its own copy and its own non-reportable verdict.
  const failure = describeApiFailure(403, { error: "token_forbidden", detail: "no AI" }, "ask failed (403)");

  assert.equal(failure.kind, "forbidden");
  assert.doesNotMatch(failure.message, /blocked before it reached/i);
});

test("only 403 gets the edge sentence", () => {
  // An empty body on any other status keeps the caller's fallback. A 500 from a
  // gateway is not an edge refusal, and claiming a security rule refused it would be
  // an invention.
  for (const status of [500, 502, 503, 413]) {
    const failure = describeApiFailure(status, {}, `save failed (${status})`);
    assert.equal(failure.kind, "other", `${status} must stay unclassified`);
    assert.equal(failure.message, `save failed (${status})`);
  }
});
