// The `GET /api/demos` scopes (DEV-2506).
//
// Imports the Worker's source directly, as profile.test.mjs does: there is no
// worker-level harness here, so the decision worth pinning — which rows a scope
// asks for — lives in a binding-free module.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { demoListQuery, parseDemoScope } from "../workers/api/src/demos-list.ts";

const EMAIL = "someone@handsontable.com";

test("the scope defaults to mine, and anything unrecognized falls back to it", () => {
  assert.equal(parseDemoScope("all"), "all");
  assert.equal(parseDemoScope("mine"), "mine");
  // A typo must not widen the listing: "show me less" is the safe reading.
  for (const raw of [null, undefined, "", "everyone", "ALL", "1", "true"]) {
    assert.equal(parseDemoScope(raw), "mine", JSON.stringify(raw));
  }
});

test("mine filters by the caller and binds their address", () => {
  const { sql, binds } = demoListQuery("mine", EMAIL);
  assert.match(sql, /WHERE created_by = \?/);
  assert.deepEqual(binds, [EMAIL]);
});

test("all returns the team's demos and binds nothing", () => {
  const { sql, binds } = demoListQuery("all", EMAIL);
  assert.deepEqual(binds, []);
  assert.equal(sql.includes("created_by = ?"), false, "no owner filter");
  // Someone else's revoked demo is a dead link and nothing more; your own stays
  // in your list so you can see what happened to something you shared.
  assert.match(sql, /WHERE revoked = 0/);
  assert.equal(demoListQuery("mine", EMAIL).sql.includes("revoked = 0"), false);
});

test("both scopes select created_by, because the UI renders ownership", () => {
  for (const scope of ["mine", "all"]) {
    assert.match(demoListQuery(scope, EMAIL).sql, /created_by/, scope);
  }
});

test("both scopes are ordered by recency", () => {
  for (const scope of ["mine", "all"]) {
    assert.match(demoListQuery(scope, EMAIL).sql, /ORDER BY updated_at DESC$/, scope);
  }
});

test("the projection never leaks a column the card has no use for", () => {
  // `files` and the R2 keys live elsewhere; a listing that selected them would
  // turn a page load into a full workspace download per row.
  for (const scope of ["mine", "all"]) {
    const { sql } = demoListQuery(scope, EMAIL);
    assert.equal(sql.includes("*"), false, `${scope}: no SELECT *`);
    for (const column of ["files", "artifact", "r2_key", "revoked_at"]) {
      assert.equal(sql.includes(column), false, `${scope}: ${column}`);
    }
  }
});
