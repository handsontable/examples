// Sentry identity decisions (DEV-2859): visitor ids, the signed-in id hash, and
// `auth_mode`. Every Sentry issue in this project reports `users: 0` because
// nothing ever calls `Sentry.setUser` — see `identity.ts`'s header. These tests
// pin the two things that made "0 users" a misleading reading: the id is a
// session-scoped floor, not a headcount, and the hash never leaks a raw address.
//
// Imported straight from the .ts, the way `pipeline/sentry-gating.test.mjs`
// imports `reportingGate.ts` — the root `test` script runs node with
// `--experimental-strip-types`, which cannot resolve a sibling `./x.js`
// specifier (verified empirically against a throwaway probe file), so
// `identity.ts` must stay import-free.

import test from "node:test";
import assert from "node:assert/strict";
import { authMode, hashedUserId, visitorId } from "../apps/authoring/src/identity.ts";

const PAT_PREFIX = "hot_pat_";

// --- visitorId ---------------------------------------------------------

/** A minimal in-memory stand-in for sessionStorage. */
function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    _store: store,
  };
}

test("visitorId mints once and returns the same id on a second call", () => {
  const storage = memoryStorage();
  const first = visitorId(storage);
  const second = visitorId(storage);
  assert.equal(first, second);
  assert.match(first, /^s_/);
});

test("visitorId survives a throwing storage (Safari private mode) without throwing", () => {
  const throwing = {
    getItem() { throw new DOMException("denied"); },
    setItem() { throw new DOMException("denied"); },
  };
  // Fails with the change reverted only if a real implementation ever forgets
  // the try/catch — this is a guard against regressing that, not a behavioural
  // claim about what id comes out (a throwing storage can't persist one).
  assert.doesNotThrow(() => visitorId(throwing));
  assert.match(visitorId(throwing), /^s_/);
});

test("visitorId reads back what a prior mint wrote (same storage instance)", () => {
  const storage = memoryStorage();
  const minted = visitorId(storage);
  assert.equal(storage.getItem("hot_sid"), minted);
});

// --- hashedUserId --------------------------------------------------------

test("hashedUserId matches a known SHA-256 vector", async () => {
  // sha256("foo@bar.com") = 0c7e6a405862e402... — pins the exact algorithm and
  // truncation, so a swap to a different hash or a different slice length
  // fails loudly instead of merely "still looking hash-shaped".
  assert.equal(await hashedUserId("foo@bar.com"), "u_0c7e6a405862e402");
});

test("hashedUserId output never contains the raw address or its local part", async () => {
  // A real, non-hex-heavy local part: "artur.medrygal" contains letters
  // (r, t, u, l, g, ...) that are not valid hex digits, so it cannot appear as
  // a substring of a lowercase-hex string by chance — this is a real privacy
  // assertion, not a coincidence-prone one.
  const email = "artur.medrygal@handsontable.com";
  const id = await hashedUserId(email);
  assert.equal(id.includes("@"), false);
  assert.equal(id.toLowerCase().includes("artur.medrygal"), false);
  assert.match(id, /^u_[0-9a-f]{16}$/);
});

test("hashedUserId normalises case and trailing whitespace", async () => {
  const a = await hashedUserId("Foo@Bar.com");
  const b = await hashedUserId("  foo@bar.com  ");
  const c = await hashedUserId("foo@bar.com");
  assert.equal(a, c);
  assert.equal(b, c);
});

// --- authMode --------------------------------------------------------------

test("authMode: dev bypass wins even when a resolved user is also present", () => {
  // The dev-bypass early return in auth.ts's currentUser() returns a User too
  // ({ email: devUser }) — this pins that devUser is checked first, or a local
  // dev session would misreport as "google".
  assert.equal(
    authMode({ devUser: "dev@handsontable.com", token: null, user: { email: "dev@handsontable.com" } }, PAT_PREFIX),
    "dev-bypass",
  );
});

test("authMode: no user at all is anonymous", () => {
  assert.equal(authMode({ token: null, user: null }, PAT_PREFIX), "anonymous");
});

test("authMode: a resolved user with a PAT-prefixed token is api-token", () => {
  assert.equal(
    authMode({ token: "hot_pat_abc123", user: { email: "a@b.com" } }, PAT_PREFIX),
    "api-token",
  );
});

test("authMode: a resolved user with a non-PAT token is google", () => {
  assert.equal(
    authMode({ token: "some-broker-jwt", user: { email: "a@b.com" } }, PAT_PREFIX),
    "google",
  );
});
