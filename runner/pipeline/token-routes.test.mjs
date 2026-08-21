// Persistent API tokens at the route level (DEV-2583, ADR-0037), driven through
// the REAL router — the default export of workers/api/src/index.ts — so every
// property asserted here is a property of the deployed Worker rather than of a
// re-declared copy of its checks (the #201 lesson).
//
// Three things are only provable here, not in api-token.test.mjs:
//
//  1. A minted token authenticates, and does it WITHOUT the broker. The stub
//     below counts calls, so "verified locally" is an assertion rather than an
//     inference. The same counter proves the security property in ADR-0037:
//     a malformed `hot_pat_…` is refused here and never forwarded to a
//     third-party host.
//  2. The capability fence. Delete a `tokenForbidden` line from a route and the
//     matching case below goes red, because the request really travels through
//     that route.
//  3. That the broker path still works, unchanged, beside the new one.
//
// Bindings are the in-memory fakes from fixtures/worker-harness.mjs, whose D1
// models `api_tokens` including the two conditional UPDATEs the store relies on.
//
// Run: node --experimental-strip-types --test pipeline/token-routes.test.mjs

import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { AUTHOR, ctx, makeEnv } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");
const { PAT_PREFIX, hashToken, mintToken } = await import("../workers/api/src/token.ts");
const { touchToken, verifyToken } = await import("../workers/api/src/token-store.ts");

// ---- the broker stub / network tripwire ---------------------------------------

const OTHER = "someone.else@handsontable.com";
const REAL_FETCH = globalThis.fetch;
let brokerCalls = 0;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://login.invalid")) {
    brokerCalls += 1;
    const presented = init?.headers?.Authorization;
    if (presented === "Bearer test-token") return Response.json({ email: AUTHOR, sub: "u1" });
    if (presented === "Bearer other-token") return Response.json({ email: OTHER, sub: "u2" });
    return new Response("no", { status: 401 });
  }
  throw new Error(`unexpected network fetch in token-routes.test.mjs: ${url}`);
};

after(() => {
  globalThis.fetch = REAL_FETCH;
});

// ---- fixtures ----------------------------------------------------------------

const HOST = "https://demos.handsontable.com";

let env;
let tokens;

beforeEach(() => {
  ({ env, tokens } = makeEnv());
  brokerCalls = 0;
});

const asPerson = (token = "test-token") => ({ Authorization: `Bearer ${token}` });

const req = (method, path, { headers = {}, body } = {}) =>
  new Request(`${HOST}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Mint through the real route, and hand back the plaintext it answered with. */
async function mintViaRoute(name = "nightly e2e", who = "test-token") {
  const res = await worker.fetch(
    req("POST", "/api/tokens", { headers: asPerson(who), body: { name } }),
    env,
    ctx,
  );
  assert.equal(res.status, 201, "the mint route answers 201");
  const body = await res.json();
  return body;
}

// ---- minting -----------------------------------------------------------------

test("minting returns the plaintext once and stores only its digest", async () => {
  const body = await mintViaRoute("nightly e2e");

  assert.ok(body.token.startsWith(PAT_PREFIX), `the response carries a token: ${body.token}`);
  assert.equal(body.name, "nightly e2e");
  assert.equal(body.created_by, AUTHOR, "the token acts as the person who minted it");
  assert.equal(body.revoked_at, null);
  assert.equal(body.last_used_at, null, "never used yet");

  const row = tokens.get(body.id);
  assert.ok(row, "the row exists");
  assert.equal(row.token_hash, await hashToken(body.token), "the digest of the whole token");
  assert.equal(
    JSON.stringify(row).includes(body.token),
    false,
    "the plaintext is nowhere in the stored row",
  );
});

test("a mint needs a usable name", async () => {
  for (const body of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(65) }]) {
    const res = await worker.fetch(
      req("POST", "/api/tokens", { headers: asPerson(), body }),
      env,
      ctx,
    );
    assert.equal(res.status, 400, `${JSON.stringify(body)} is refused`);
    assert.equal(tokens.size, 0, "and nothing was written");
  }
});

// ---- the credential actually works, without the broker -----------------------

test("a minted token authenticates, and never touches the broker", async () => {
  const { token } = await mintViaRoute();
  brokerCalls = 0;

  const res = await worker.fetch(
    req("GET", "/api/demos?scope=mine", { headers: asPerson(token) }),
    env,
    ctx,
  );

  assert.equal(res.status, 200, "an auth-gated route accepts the token");
  assert.equal(brokerCalls, 0, "verified locally — the credential never left this Worker");
  const body = await res.json();
  assert.equal(body.scope, "mine", "and it authenticated as somebody");
});

test("a token acts as its creator, so ownership is unchanged", async () => {
  const { token } = await mintViaRoute();
  // `?scope=mine` binds the identity's own address into the listing query, so a
  // 200 here means the token resolved to an address — and the write log shows
  // which one, without needing a seeded demo to come back.
  await worker.fetch(req("GET", "/api/demos?scope=mine", { headers: asPerson(token) }), env, ctx);
  const row = tokens.get(token.slice(PAT_PREFIX.length, PAT_PREFIX.length + 16));
  assert.equal(row.created_by, AUTHOR);
});

test("a malformed token of ours is refused on the anonymous routes too, not served", async () => {
  // `/api/chat` admits anonymous callers, so the fence there reads the header
  // rather than an identity. A truncated or corrupted `hot_pat_…` is therefore a
  // 403 rather than an anonymous request: it is still a credential of ours being
  // presented, and answering it as "no credential" would let a broken paste
  // silently spend AI budget as an anonymous visitor.
  for (const bearer of [`${PAT_PREFIX}truncated`, `${PAT_PREFIX}`]) {
    const res = await worker.fetch(
      req("POST", "/api/chat", { headers: asPerson(bearer), body: { question: "hi" } }),
      env,
      ctx,
    );
    assert.equal(res.status, 403, `${bearer} on /api/chat`);
    assert.equal((await res.json()).error, "token_forbidden");
  }
});

test("a row with no usable digest verifies as nothing, rather than throwing", async () => {
  // A partial insert, a hand-edited row, or a future migration mid-backfill. The
  // digest comparison is length-guarded, so this is a null and not a 500 — worth
  // an assertion because it is the last unexercised branch in verifyToken.
  const { id, token } = await mintViaRoute();
  for (const bad of ["", "not-a-digest", null]) {
    tokens.get(id).token_hash = bad;
    assert.equal(
      await verifyToken(env, token, "2026-08-21T13:05:00.000Z"),
      null,
      `token_hash ${JSON.stringify(bad)} verifies as nothing`,
    );
  }
});

test("a malformed token of ours is refused here, not forwarded to the broker", async () => {
  // The security property in ADR-0037: falling through to the broker would post
  // our own permanent credential to a third-party host, and the failure would
  // look like a slow success.
  for (const bearer of [
    `${PAT_PREFIX}nonsense`,
    `${PAT_PREFIX}0123456789abcdef_short`,
    PAT_PREFIX,
  ]) {
    brokerCalls = 0;
    const res = await worker.fetch(
      req("GET", "/api/demos", { headers: asPerson(bearer) }),
      env,
      ctx,
    );
    assert.equal(res.status, 401, `${bearer} is refused`);
    assert.equal(brokerCalls, 0, `${bearer} was never forwarded`);
  }
});

test("an unknown id, and a right id with a wrong secret, are both refused", async () => {
  const { token, id } = await mintViaRoute();
  const secret = token.slice(PAT_PREFIX.length + 16 + 1);
  const otherSecret = mintToken().token.slice(PAT_PREFIX.length + 16 + 1);

  const unknown = `${PAT_PREFIX}${"0".repeat(16)}_${secret}`;
  const tampered = `${PAT_PREFIX}${id}_${otherSecret}`;

  for (const [label, bearer] of [["an unknown id", unknown], ["a wrong secret", tampered]]) {
    brokerCalls = 0;
    const res = await worker.fetch(req("GET", "/api/demos", { headers: asPerson(bearer) }), env, ctx);
    assert.equal(res.status, 401, `${label} is refused`);
    assert.equal(brokerCalls, 0, `${label} did not reach the broker`);
  }

  // The control: the real token still works, so the two refusals above are the
  // digest comparison doing its job rather than the whole path being broken.
  const ok = await worker.fetch(req("GET", "/api/demos", { headers: asPerson(token) }), env, ctx);
  assert.equal(ok.status, 200);
});

test("extra whitespace after Bearer does not leak the token to the broker", async () => {
  // RFC 7235 allows `1*SP` between the scheme and the credential, so
  // `Bearer  hot_pat_…` is a well-formed header — and slicing a fixed "Bearer "
  // off the front used to leave the space attached, miss the prefix test, and
  // forward our own permanent credential to the broker (Bugbot, #252).
  const { token } = await mintViaRoute();

  for (const header of [`Bearer  ${token}`, `Bearer \t${token}`, `Bearer   ${token}  `]) {
    brokerCalls = 0;
    const res = await worker.fetch(
      new Request(`${HOST}/api/demos`, { headers: { Authorization: header } }),
      env,
      ctx,
    );
    assert.equal(res.status, 200, `${JSON.stringify(header)} still authenticates`);
    assert.equal(brokerCalls, 0, `${JSON.stringify(header)} was not forwarded to the broker`);
  }
});

test("extra whitespace after Bearer does not slip past the capability fence either", async () => {
  // The other half of the same defect: `/api/chat` admits anonymous callers, so
  // a token it failed to recognise would have been served as a visitor and
  // allowed to spend AI budget.
  const { token } = await mintViaRoute();

  const res = await worker.fetch(
    new Request(`${HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer  ${token}` },
      body: JSON.stringify({ question: "hi" }),
    }),
    env,
    ctx,
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "token_forbidden");
});

test("a lower-case auth scheme is still a token, not a fall-through", async () => {
  // RFC 7235 makes `auth-scheme` case-insensitive. Returning null for
  // `bearer hot_pat_…` would drop the request through to the DEV_AUTH_EMAIL
  // bypass on a loopback host and grant a *person* identity with no `via`, so
  // the capability fence would not engage locally — the exact failure the
  // ordering in `authenticate()` exists to prevent.
  const { token } = await mintViaRoute();

  for (const scheme of ["bearer", "BEARER", "BeArEr"]) {
    brokerCalls = 0;
    const res = await worker.fetch(
      new Request(`${HOST}/api/demos`, { headers: { Authorization: `${scheme} ${token}` } }),
      env,
      ctx,
    );
    assert.equal(res.status, 200, `${scheme} authenticates`);
    assert.equal(brokerCalls, 0, `${scheme} was not forwarded to the broker`);
  }

  // And the fence sees it too, on a route that admits anonymous callers.
  const chat = await worker.fetch(
    new Request(`${HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `bearer ${token}` },
      body: JSON.stringify({ question: "hi" }),
    }),
    env,
    ctx,
  );
  assert.equal(chat.status, 403);
});

test("the broker path still works, beside the new one", async () => {
  const res = await worker.fetch(req("GET", "/api/demos", { headers: asPerson() }), env, ctx);
  assert.equal(res.status, 200);
  assert.ok(brokerCalls > 0, "a broker JWT is still validated by the broker");
});

// ---- listing and revocation ---------------------------------------------------

test("the listing shows every token in the organization and no secrets", async () => {
  const mine = await mintViaRoute("mine", "test-token");
  const theirs = await mintViaRoute("theirs", "other-token");

  const res = await worker.fetch(req("GET", "/api/tokens", { headers: asPerson() }), env, ctx);
  assert.equal(res.status, 200);
  const { tokens: listed } = await res.json();

  assert.deepEqual(
    listed.map((t) => t.id).sort(),
    [mine.id, theirs.id].sort(),
    "both people's tokens, to everybody",
  );
  for (const row of listed) {
    assert.equal("token_hash" in row, false, "no digest in the listing");
    assert.equal("token" in row, false, "no plaintext in the listing");
    assert.ok(row.created_by, "attribution is shown");
  }
});

test("anyone on the team can revoke anyone's token, and it stops working at once", async () => {
  const { id, token } = await mintViaRoute("nightly e2e", "test-token");

  const del = await worker.fetch(
    req("DELETE", `/api/tokens/${id}`, { headers: asPerson("other-token") }),
    env,
    ctx,
  );
  assert.equal(del.status, 204, "a different team member may revoke it (ADR-0037)");
  assert.equal(tokens.get(id).revoked_by, OTHER, "and is recorded as the one who did");

  brokerCalls = 0;
  const after = await worker.fetch(
    req("GET", "/api/demos", { headers: asPerson(token) }),
    env,
    ctx,
  );
  assert.equal(after.status, 401, "the next request is refused");
  assert.equal(brokerCalls, 0, "a revoked token is not retried against the broker");
});

test("revoking twice keeps the first kill's attribution; revoking nothing is a 404", async () => {
  const { id } = await mintViaRoute();

  await worker.fetch(req("DELETE", `/api/tokens/${id}`, { headers: asPerson() }), env, ctx);
  const firstAt = tokens.get(id).revoked_at;
  assert.ok(firstAt);

  const second = await worker.fetch(
    req("DELETE", `/api/tokens/${id}`, { headers: asPerson("other-token") }),
    env,
    ctx,
  );
  assert.equal(second.status, 204, "idempotent");
  assert.equal(tokens.get(id).revoked_at, firstAt, "history is not rewritten");
  assert.equal(tokens.get(id).revoked_by, AUTHOR, "nor is the attribution");

  const missing = await worker.fetch(
    req("DELETE", "/api/tokens/deadbeefdeadbeef", { headers: asPerson() }),
    env,
    ctx,
  );
  assert.equal(missing.status, 404);
});

test("every token route requires an identity", async () => {
  for (const [method, path] of [
    ["GET", "/api/tokens"],
    ["POST", "/api/tokens"],
    ["DELETE", "/api/tokens/0123456789abcdef"],
  ]) {
    const res = await worker.fetch(
      req(method, path, method === "POST" ? { body: { name: "x" } } : {}),
      env,
      ctx,
    );
    assert.equal(res.status, 401, `${method} ${path} is gated`);
  }
});

// ---- the capability fence ------------------------------------------------------

test("a token cannot read the token list either", async () => {
  // Fenced along with the writes: no digests are exposed, but the listing names
  // every credential in the organization and its owner (ADR-0037).
  const { token } = await mintViaRoute();

  const res = await worker.fetch(req("GET", "/api/tokens", { headers: asPerson(token) }), env, ctx);
  assert.equal(res.status, 403);
  const failure = await res.json();
  assert.equal(failure.error, "token_forbidden");
  assert.ok(failure.detail?.length > 0);
});

test("a token cannot mint or revoke a token", async () => {
  // The fence that matters most: a leaked credential must not be able to mint
  // itself a successor, nor revoke the token that would be used to kill it.
  const first = await mintViaRoute("nightly e2e");
  const target = await mintViaRoute("the one it would kill");

  const mint = await worker.fetch(
    req("POST", "/api/tokens", { headers: asPerson(first.token), body: { name: "successor" } }),
    env,
    ctx,
  );
  assert.equal(mint.status, 403);
  assert.equal((await mint.json()).error, "token_forbidden");
  assert.equal(tokens.size, 2, "and nothing was minted");

  const revoke = await worker.fetch(
    req("DELETE", `/api/tokens/${target.id}`, { headers: asPerson(first.token) }),
    env,
    ctx,
  );
  assert.equal(revoke.status, 403);
  assert.equal(tokens.get(target.id).revoked_at, null, "the target is still live");
});

test("a token cannot change the guardrail settings or kill a session", async () => {
  const { token } = await mintViaRoute();

  for (const [method, path, body] of [
    ["PUT", "/api/admin/settings", { limitUsd: 9999 }],
    ["DELETE", "/api/admin/settings", undefined],
    ["DELETE", "/api/admin/sessions/deadbeef", undefined],
  ]) {
    const res = await worker.fetch(
      req(method, path, { headers: asPerson(token), body }),
      env,
      ctx,
    );
    assert.equal(res.status, 403, `${method} ${path} is fenced`);
    const failure = await res.json();
    assert.equal(failure.error, "token_forbidden");
    assert.ok(failure.detail?.length > 0, "and says why, so the client shows a sentence");
  }
});

test("a token cannot spend AI budget", async () => {
  const { token } = await mintViaRoute();

  for (const path of ["/api/chat", "/api/theme"]) {
    const res = await worker.fetch(
      req("POST", path, { headers: asPerson(token), body: { question: "hi" } }),
      env,
      ctx,
    );
    assert.equal(res.status, 403, `${path} is fenced`);
    assert.equal((await res.json()).error, "token_forbidden");
  }
});

test("a token may still read the admin listings the nightly canary needs", async () => {
  // Deliberately NOT fenced, unlike the token listing: the session-leak spec
  // reads this, and internal spend figures are internal rather than secret
  // (admin.ts).
  const { token } = await mintViaRoute();

  const res = await worker.fetch(
    req("GET", "/api/admin/sessions?awake=0&limit=5", { headers: asPerson(token) }),
    env,
    ctx,
  );
  assert.equal(res.status, 200, "reading is allowed");
});

// ---- last_used_at --------------------------------------------------------------

test("an authenticated request records use", async () => {
  const { id, token } = await mintViaRoute();
  assert.equal(tokens.get(id).last_used_at, null);

  await worker.fetch(req("GET", "/api/demos", { headers: asPerson(token) }), env, ctx);
  assert.ok(tokens.get(id).last_used_at, "the row now knows the token is in use");
});

test("use is recorded at most once per clock hour", async () => {
  // Driven through the store with injected stamps rather than through the route:
  // the route reads the real clock, so a route-level version of this would
  // depend on which minute the suite happened to run in.
  const { id } = await mintViaRoute();

  await touchToken(env, id, "2026-08-21T13:05:00.000Z");
  assert.equal(tokens.get(id).last_used_at, "2026-08-21T13:05:00.000Z", "the first use lands");

  await touchToken(env, id, "2026-08-21T13:47:12.345Z");
  assert.equal(
    tokens.get(id).last_used_at,
    "2026-08-21T13:05:00.000Z",
    "a second use in the same hour does not re-write",
  );

  await touchToken(env, id, "2026-08-21T14:00:00.000Z");
  assert.equal(tokens.get(id).last_used_at, "2026-08-21T14:00:00.000Z", "the next hour does");
});

test("verifying a revoked token neither matches nor records use", async () => {
  const { id, token } = await mintViaRoute();
  await worker.fetch(req("DELETE", `/api/tokens/${id}`, { headers: asPerson() }), env, ctx);

  const verified = await verifyToken(env, token, "2026-08-21T13:05:00.000Z");
  assert.equal(verified, null);
  assert.equal(tokens.get(id).last_used_at, null, "a refused credential leaves no use stamp");
});
