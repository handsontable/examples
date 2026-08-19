import test from "node:test";
import assert from "node:assert/strict";
import {
  AWAKE_WINDOW_SECONDS,
  classifyMeter,
  frameworkOf,
  pageOf,
  parseSessionQuery,
  refAmbiguousMessage,
  refUnknownMessage,
  resolveSessionRef,
  scanTruncated,
  sessionRef,
  SESSIONS_MAX_PAGE_SIZE,
  SESSIONS_PAGE_SIZE,
} from "../workers/api/src/session-listing.ts";

// DEV-2567. The /admin panel showed 50 "live" Angular sessions against a pool
// capped at 5 instances (`containers.max_instances`, wrangler.jsonc) with a 5m
// `sleepAfter`. Both of those numbers were and are correct; the table was wrong
// on two counts, and this file pins the decisions that fix each.
//
//  1. A row was one `session-meter:` key, and that key lives KV_METER_TTL_SECONDS
//     = 24h — far past the container it fronts. Every client that vanished
//     without a clean DELETE left one behind, Awake and Est. cost climbing all
//     day. Hence `classifyMeter`.
//  2. The scan was `list({ limit: 50 })` with no cursor. KV lists in UTF-8 key
//     order and session ids start with the framework slug, so with 50+ angular
//     meters the table *could not* render another framework. The all-angular
//     screenshot was that cap, not the traffic mix. Hence `pageOf` and the
//     truncation reporting in admin.ts.

const now = 1_800_000_000_000;
const sec = (n) => n * 1000;

test("a meter that ticked within the idle window is awake", () => {
  const state = classifyMeter({ startedAt: now - sec(600), meteredThrough: now - sec(90) }, now);
  assert.equal(state.state, "awake");
  assert.equal(state.quietSeconds, 90);
  assert.equal(state.ageSeconds, 600);
});

test("a healthy session's freshest possible tick is well inside the window", () => {
  // The keepalive fires every 60s and books a slice only once METER_FLUSH_SECONDS
  // has elapsed, so a tick can be skipped and ~120s is the worst case for a tab
  // that is doing everything right. If this ever exceeds the window, the panel
  // starts calling live sessions dead.
  assert.ok(AWAKE_WINDOW_SECONDS > 120, "no margin left for a skipped keepalive tick");
  assert.equal(classifyMeter({ startedAt: now - sec(600), meteredThrough: now - sec(120) }, now).state, "awake");
});

test("a meter quiet past the idle window is slept, however young the session", () => {
  const state = classifyMeter(
    { startedAt: now - sec(AWAKE_WINDOW_SECONDS + 10), meteredThrough: now - sec(AWAKE_WINDOW_SECONDS + 1) },
    now,
  );
  assert.equal(state.state, "slept");
});

test("the boundary is inclusive, so an exactly-at-the-window meter is still awake", () => {
  const at = classifyMeter({ startedAt: now - sec(900), meteredThrough: now - sec(AWAKE_WINDOW_SECONDS) }, now);
  assert.equal(at.state, "awake");
});

test("a 24h phantom is priced on its billable window, not its age", () => {
  // The exact shape from the ticket: created a day ago, last ticked a minute
  // later, container asleep ever since. The old table charged the whole 24h.
  const state = classifyMeter(
    { startedAt: now - sec(86_400), meteredThrough: now - sec(86_400) + sec(60) },
    now,
  );
  assert.equal(state.state, "slept");
  assert.equal(state.ageSeconds, 86_400);
  // 60s booked, plus the one idle window it took to fall asleep. Nothing more.
  assert.equal(state.billableSeconds, 60 + AWAKE_WINDOW_SECONDS);
  assert.ok(state.billableSeconds < state.ageSeconds / 100);
});

test("a brand-new session bills only what has elapsed", () => {
  const state = classifyMeter({ startedAt: now - sec(30), meteredThrough: now - sec(30) }, now);
  assert.equal(state.state, "awake");
  assert.equal(state.billableSeconds, 30);
});

test("a timestamp from the future reads as brand new, never as a negative duration", () => {
  // KV is eventually consistent across colos; a meter written elsewhere can
  // carry a clock slightly ahead of ours.
  const state = classifyMeter({ startedAt: now + sec(5), meteredThrough: now + sec(5) }, now);
  assert.equal(state.ageSeconds, 0);
  assert.equal(state.quietSeconds, 0);
  assert.equal(state.billableSeconds, 0);
  assert.equal(state.state, "awake");
});

// ---- the query ---------------------------------------------------------------

const query = (search) => parseSessionQuery(new URLSearchParams(search));

test("the awake filter is on by default, including for a caller that passes nothing", () => {
  // `adminUsage` embeds the first page by calling with empty params. If this
  // ever flips, the report goes straight back to dumping the 24h tail.
  assert.equal(query("").awakeOnly, true);
  assert.equal(query("offset=25").awakeOnly, true);
  assert.equal(query("awake=1").awakeOnly, true);
});

test("only an explicit falsey value opens the 24h window", () => {
  assert.equal(query("awake=0").awakeOnly, false);
  assert.equal(query("awake=false").awakeOnly, false);
  assert.equal(query("awake=nonsense").awakeOnly, true);
});

test("offset and limit are clamped, so a hand-written query cannot ask for the world", () => {
  assert.equal(query("").limit, SESSIONS_PAGE_SIZE);
  assert.equal(query("limit=99999").limit, SESSIONS_MAX_PAGE_SIZE);
  assert.equal(query("limit=0").limit, 1);
  assert.equal(query("limit=abc").limit, SESSIONS_PAGE_SIZE);
  assert.equal(query("offset=-5").offset, 0);
  assert.equal(query("offset=7.9").offset, 7);
});

// ---- paging -----------------------------------------------------------------

const rows = (n) => Array.from({ length: n }, (_, i) => i);

test("paging reports the filtered total, not the page length", () => {
  const page = pageOf(rows(60), { offset: 0, limit: 25 });
  assert.equal(page.total, 60);
  assert.deepEqual(page.rows, rows(25));
});

test("a middle and a final page slice where they should", () => {
  assert.deepEqual(pageOf(rows(60), { offset: 25, limit: 25 }).rows[0], 25);
  const last = pageOf(rows(60), { offset: 50, limit: 25 });
  assert.equal(last.rows.length, 10);
});

test("an offset past the end falls back to the last page, not to an empty one", () => {
  // A kill can shrink the list under an operator who is on the last page.
  // Answering with zero rows and no way back is how that becomes a bug report.
  const page = pageOf(rows(60), { offset: 400, limit: 25 });
  assert.equal(page.offset, 50);
  assert.equal(page.rows.length, 10);
});

test("an empty list pages to offset zero", () => {
  const page = pageOf([], { offset: 100, limit: 25 });
  assert.deepEqual(page.rows, []);
  assert.equal(page.offset, 0);
  assert.equal(page.total, 0);
});

// ---- truncation --------------------------------------------------------------
//
// The failure this table shipped with was a silent bound. `limit: 50`, no cursor,
// no signal — so "50 rows" and "at least 50 rows" rendered identically. Every
// combination of the two ways the scan can come up short is pinned.

test("a complete scan with every legacy key read is not truncated", () => {
  assert.equal(scanTruncated({ listComplete: true, legacyFound: 0, legacyRead: 0 }), false);
  assert.equal(scanTruncated({ listComplete: true, legacyFound: 12, legacyRead: 12 }), false);
});

test("running out of list pages is truncated, legacy keys or not", () => {
  assert.equal(scanTruncated({ listComplete: false, legacyFound: 0, legacyRead: 0 }), true);
  assert.equal(scanTruncated({ listComplete: false, legacyFound: 12, legacyRead: 12 }), true);
});

test("more pre-metadata keys than the read budget is truncated even on a complete list", () => {
  // The whole prefix was enumerated, but some rows could not be filled in — the
  // counts are still a lower bound and must say so.
  assert.equal(scanTruncated({ listComplete: true, legacyFound: 300, legacyRead: 200 }), true);
});

// ---- refs -------------------------------------------------------------------

test("the framework comes off the session id's slug prefix", () => {
  assert.equal(frameworkOf("angular-a1b2c3d4"), "angular");
  assert.equal(frameworkOf("next.js-a1b2c3d4"), "next.js");
  assert.equal(frameworkOf("next-shadcn.js-a1b2c3d4"), "next-shadcn.js");
  // Nothing to split on: report the whole thing rather than an empty column.
  assert.equal(frameworkOf("weird"), "weird");
});

test("a ref is 8 hex chars and is stable for an id", async () => {
  const ref = await sessionRef("angular-a1b2c3d4");
  assert.match(ref, /^[0-9a-f]{8}$/);
  assert.equal(ref, await sessionRef("angular-a1b2c3d4"));
  assert.notEqual(ref, await sessionRef("angular-a1b2c3d5"));
});

test("a ref resolves back to exactly one session id", async () => {
  const ids = ["angular-aaaaaaaa", "astro-bbbbbbbb", "remix-cccccccc"];
  for (const id of ids) {
    assert.deepEqual(await resolveSessionRef(ids, await sessionRef(id)), { ok: true, sessionId: id });
  }
});

test("a ref for a session that is already gone is unknown, not a wrong kill", async () => {
  const gone = await sessionRef("angular-deadbeef");
  assert.deepEqual(await resolveSessionRef(["astro-bbbbbbbb"], gone), { ok: false, reason: "unknown" });
});

test("a malformed ref never reaches the digest loop", async () => {
  for (const bad of ["", "zzzzzzzz", "abc", "0123456789", "../../etc"]) {
    assert.deepEqual(await resolveSessionRef(["astro-bbbbbbbb"], bad), { ok: false, reason: "unknown" });
  }
});

test("a ref is matched case-insensitively and trimmed", async () => {
  const id = "angular-aaaaaaaa";
  const ref = await sessionRef(id);
  assert.deepEqual(await resolveSessionRef([id], ` ${ref.toUpperCase()} `), { ok: true, sessionId: id });
});

test("two ids behind one ref refuse rather than tear down a guess", async () => {
  // 32 bits makes a real collision astronomically unlikely, and short of
  // breaking SHA-256 there is no way to construct two ids that produce one ref
  // — so the branch is driven with a duplicate entry instead. That is a weaker
  // stimulus than the real thing but it pins the decision that matters: more
  // than one match must refuse, not take the first. The action on the other side
  // is a teardown of somebody else's running work.
  const id = "angular-aaaaaaaa";
  const ref = await sessionRef(id);
  const result = await resolveSessionRef([id, id], ref);
  assert.deepEqual(result, { ok: false, reason: "ambiguous" });
});

// ---- what a refused kill actually says ---------------------------------------
//
// Bugbot caught this on the branch: the route sent `{error: "ambiguous_ref",
// message: "<sentence>"}`, and `describeApiFailure` renders `body.error` for
// every status it does not classify while never reading `message` — so the
// operator saw the wire code, in the one path added specifically to explain this
// case. The sentences live here so the contract is pinned somewhere the route
// cannot be edited away from, the same way `atCapacityMessage` is.

test("a refused kill explains itself in a sentence, not a wire code", () => {
  for (const copy of [refUnknownMessage, refAmbiguousMessage]) {
    assert.ok(copy.length > 12, "too short to be an explanation");
    // Nothing snake_case or SCREAMING: those read as an identifier that leaked.
    assert.doesNotMatch(copy, /_/, `${copy} looks like a wire code`);
    assert.doesNotMatch(copy, /^[a-z]+$/, `${copy} looks like a bare token`);
    // A sentence, so it can sit in an error banner unedited.
    assert.match(copy, /^[A-Z].*[.!]$/, `${copy} is not a sentence`);
  }
});

test("the two refusals do not say the same thing", () => {
  // 404 and 409 are different situations for the operator: one row is already
  // gone, the other needs a reload before it can be acted on at all.
  assert.notEqual(refUnknownMessage, refAmbiguousMessage);
  assert.match(refAmbiguousMessage, /reload/i);
});
