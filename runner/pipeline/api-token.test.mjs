// The persistent API token's own rules (DEV-2583, ADR-0037), tested against the
// real `token.ts` — the module the Worker's auth path calls, not a local copy of
// its regex. `token.ts` imports nothing and touches no binding for exactly this
// reason (the rule demos-list.ts records), so it loads directly under
// `node --experimental-strip-types` with no module hooks and no fakes.
//
// What is proved here is the credential's shape and the arithmetic around it.
// That the router actually enforces any of it is token-routes.test.mjs's job:
// a shape check that only ever runs in this file would stay green with the
// branch deleted from auth.ts (the #201 lesson).
//
// Run: node --experimental-strip-types --test pipeline/api-token.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const {
  PAT_PREFIX,
  MAX_TOKEN_NAME,
  hashToken,
  isTokenBearerValue,
  mintToken,
  normalizeTokenName,
  parseTokenId,
  touchThreshold,
} = await import("../workers/api/src/token.ts");

test("a minted token carries its own public id and is shaped for parsing", async () => {
  const { id, token } = mintToken();
  assert.match(id, /^[0-9a-f]{16}$/, "the id is 16 hex characters");
  assert.ok(token.startsWith(PAT_PREFIX), `a token announces itself: ${token}`);
  assert.equal(
    parseTokenId(token),
    id,
    "the id the caller stores is the id read back out of the token string",
  );
});

test("two mints never collide, and the secret is not derived from the id", () => {
  const a = mintToken();
  const b = mintToken();
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.token, b.token);
  // Same id, different secret must be a different token — otherwise the public
  // half would be enough to reconstruct the credential.
  const secretOf = (t) => t.slice(PAT_PREFIX.length + 16 + 1);
  assert.notEqual(secretOf(a.token), secretOf(b.token));
  assert.equal(secretOf(a.token).length, 43, "base64url over 32 random bytes");
});

test("only the exact token shape parses", () => {
  const { id, token } = mintToken();
  const secret = token.slice(PAT_PREFIX.length + 16 + 1);

  assert.equal(parseTokenId(token), id, "the control case parses");

  for (const [label, raw] of [
    ["a broker JWT", "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.e30.sig"],
    ["the empty string", ""],
    ["the prefix alone", PAT_PREFIX],
    ["a near-miss prefix", `hot_pat${id}_${secret}`],
    ["an uppercase prefix", `HOT_PAT_${id}_${secret}`],
    ["a non-hex id", `${PAT_PREFIX}${"g".repeat(16)}_${secret}`],
    ["an uppercase id", `${PAT_PREFIX}${id.toUpperCase()}_${secret}`],
    ["a short id", `${PAT_PREFIX}${id.slice(0, 15)}_${secret}`],
    ["a long id", `${PAT_PREFIX}${id}a_${secret}`],
    ["no separator", `${PAT_PREFIX}${id}${secret}`],
    ["a short secret", `${PAT_PREFIX}${id}_${secret.slice(0, 42)}`],
    ["a long secret", `${PAT_PREFIX}${id}_${secret}a`],
    ["a secret with a dot", `${PAT_PREFIX}${id}_${`.${secret.slice(1)}`}`],
    ["trailing whitespace", `${token} `],
    ["a leading Bearer", `Bearer ${token}`],
  ]) {
    assert.equal(parseTokenId(raw), null, `${label} is not a token`);
  }
});

test("the bearer test is the prefix and nothing else — it never validates", () => {
  // This is what decides whether a credential goes to the local lookup or to the
  // broker, so it must answer on the prefix alone: a malformed `hot_pat_…` has to
  // be refused here rather than fall through and be posted to a third-party host.
  assert.equal(isTokenBearerValue(mintToken().token), true);
  assert.equal(isTokenBearerValue(`${PAT_PREFIX}nonsense`), true, "malformed but ours");
  assert.equal(isTokenBearerValue("eyJhbGciOiJSUzI1NiJ9.e30.sig"), false, "a broker JWT is not");
  assert.equal(isTokenBearerValue(""), false);
});

test("the stored digest is a SHA-256 of the whole token, not of its id", async () => {
  const { id, token } = mintToken();
  const digest = await hashToken(token);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, await hashToken(token), "stable for the same input");
  assert.notEqual(digest, await hashToken(id), "the public half does not produce the digest");
  assert.notEqual(digest, await hashToken(mintToken().token));
  // The known-answer case, so a future refactor cannot quietly change algorithm.
  assert.equal(
    await hashToken("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("a token name is required, trimmed and capped", () => {
  assert.deepEqual(normalizeTokenName({ name: "  nightly e2e  " }), { ok: true, value: "nightly e2e" });
  assert.equal(normalizeTokenName({ name: "x".repeat(MAX_TOKEN_NAME) }).ok, true, "the cap itself fits");

  for (const [label, body] of [
    ["a missing body", null],
    ["a missing name", {}],
    ["an empty name", { name: "" }],
    ["a whitespace-only name", { name: "   " }],
    ["a non-string name", { name: 42 }],
    ["an over-long name", { name: "x".repeat(MAX_TOKEN_NAME + 1) }],
  ]) {
    const result = normalizeTokenName(body);
    assert.equal(result.ok, false, `${label} is refused`);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0, "the refusal says why");
  }
});

test("last_used_at is bounded to one write per clock hour", () => {
  // The threshold is the bound in `UPDATE … WHERE last_used_at IS NULL OR
  // last_used_at < ?`. A stamp from this hour must not pass it; anything older
  // must. Asserting the comparison, not just the string, because the string
  // format is only load-bearing insofar as ISO8601 sorts lexicographically.
  const now = "2026-08-21T13:47:12.345Z";
  const threshold = touchThreshold(now);
  assert.equal(threshold, "2026-08-21T13:00:00.000Z");

  assert.ok(!("2026-08-21T13:05:00.000Z" < threshold), "a stamp from this hour does not re-write");
  assert.ok(!(threshold < threshold), "the hour boundary itself does not re-write");
  assert.ok("2026-08-21T12:59:59.999Z" < threshold, "the previous hour does");
  assert.ok("2026-08-20T23:00:00.000Z" < threshold, "so does yesterday");

  // Midnight and the turn of the year, where a naive slice-and-concat breaks.
  assert.equal(touchThreshold("2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z");
  assert.equal(touchThreshold("2025-12-31T23:59:59.999Z"), "2025-12-31T23:00:00.000Z");
});
