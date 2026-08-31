import test from "node:test";
import assert from "node:assert/strict";
import {
  AT_CAPACITY_CODE,
  atCapacityMessage,
  destroyConfirmed,
  isAtCapacityFailure,
  isExpectedTeardownFailure,
  TOMBSTONE_ATTEMPTED,
  TOMBSTONE_DESTROYED,
  TOMBSTONE_TTL_SECONDS,
} from "../workers/api/src/session-lifecycle.ts";

// DEV-2556. Sentry DEMOS-1 caught two `DELETE /api/session/:id` calls, 328 ms
// apart, failing with "Maximum number of running container instances exceeded".
// A teardown cannot be a cause of a full pool — an instance that cannot be
// allocated is not occupying a slot — so those 500s bought a Sentry event and
// nothing else: `deleteSession()` in packages/runtime/src/container.ts is a
// fire-and-forget `keepalive` fetch that discards the response entirely.
//
// Both decisions the fix rests on live in `session-lifecycle.ts` because
// `index.ts` is a Worker entrypoint and cannot be imported under
// `--experimental-strip-types` (the constraint `sentry-gating.test.mjs`
// documents). This file is therefore the only place either is pinned.

/** The DEMOS-1 event message, verbatim. */
const CAPACITY =
  "Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances";
/** The 2026-08-07 event that Sentry grouped alongside it (same culprit). */
const UNREACHABLE = "The container service is unreachable, try again later";
const NOT_RUNNING = "The container is not running, consider calling start()";

// ---- the tombstone state machine ------------------------------------------

test("a marker that was never written means the sandbox RPC still has to run", () => {
  assert.equal(destroyConfirmed(null), false);
  assert.equal(destroyConfirmed(undefined), false);
});

test("an ATTEMPTED marker does NOT skip the destroy", () => {
  // THE REGRESSION THIS FILE EXISTS FOR. The obvious form of this fix — "skip
  // the sandbox RPC whenever the session is tombstoned" — is wrong twice over.
  // The DELETE handler writes the marker itself, immediately before its own
  // destroy, so a *first* DELETE would skip the very teardown it exists to do;
  // and a DELETE whose destroy just failed would never be retried by the next
  // one, turning a transient platform failure into a guaranteed leak until
  // `sleepAfter`. Only a destroy we watched resolve may skip.
  assert.equal(destroyConfirmed(TOMBSTONE_ATTEMPTED), false);
  assert.equal(destroyConfirmed("1"), false, "the legacy KV value is an attempt, not a confirmation");
});

test("only a confirmed destroy skips the sandbox RPC", () => {
  assert.equal(destroyConfirmed(TOMBSTONE_DESTROYED), true);
});

test("an unrecognised marker falls back to doing the work", () => {
  // A value from a future release, or a partial write. Every mistake here must
  // cost an extra RPC, never a stranded container.
  assert.equal(destroyConfirmed(""), false);
  assert.equal(destroyConfirmed("destroyed "), false);
  assert.equal(destroyConfirmed("DESTROYED"), false);
  assert.equal(destroyConfirmed("2"), false);
});

test("the attempted marker keeps the byte value already in KV", () => {
  // A rolling deploy has both versions live, and markers written by the old one
  // survive for their whole TTL. `isTombstoned` in index.ts treats any non-null
  // value as tombstoned, so the resurrection gate keeps working either way —
  // but changing this literal would still be a needless flag day.
  assert.equal(TOMBSTONE_ATTEMPTED, "1");
  assert.notEqual(TOMBSTONE_DESTROYED, TOMBSTONE_ATTEMPTED);
});

test("the marker outlives the container it guards", () => {
  // `sleepAfter` is 5m (index.ts). A marker that expired first would let a
  // straggler request resurrect a container under a dead id.
  assert.ok(TOMBSTONE_TTL_SECONDS >= 300, `${TOMBSTONE_TTL_SECONDS}s must outlast sleepAfter=5m`);
});

// ---- the teardown failure classifier --------------------------------------

test("the three platform messages are expected teardown failures", () => {
  assert.equal(isExpectedTeardownFailure(new Error(CAPACITY)), true);
  assert.equal(isExpectedTeardownFailure(new Error(UNREACHABLE)), true);
  assert.equal(isExpectedTeardownFailure(new Error(NOT_RUNNING)), true);
});

test("it sees through a cause chain", () => {
  const wrapped = new Error("destroy failed", { cause: new Error(CAPACITY) });
  assert.equal(isExpectedTeardownFailure(wrapped), true);
  assert.equal(isExpectedTeardownFailure(new Error("outer", { cause: wrapped })), true);
});

test("a self-referencing cause chain terminates", () => {
  const loop = new Error("boom");
  loop.cause = loop;
  assert.equal(isExpectedTeardownFailure(loop), false);
});

test("anything we have not diagnosed keeps today's 500 and today's report", () => {
  assert.equal(isExpectedTeardownFailure(new TypeError("x is not a function")), false);
  assert.equal(isExpectedTeardownFailure(new Error("Network connection lost.")), false);
  assert.equal(isExpectedTeardownFailure("Maximum number of running container instances exceeded"), false,
    "a non-Error throw is not a platform message we recognise");
  assert.equal(isExpectedTeardownFailure(null), false);
  assert.equal(isExpectedTeardownFailure(undefined), false);
});

test("a reworded capacity message degrades to today's behaviour, not to silence", () => {
  // The documented degrade direction, same as `isPreviewPortUnreachable`: these
  // strings are raised by the platform, not by any package here, so a match is
  // the only signal available. If Cloudflare rewords one, the predicate stops
  // matching and we go back to reporting a 500 — noisy, never silent.
  assert.equal(isExpectedTeardownFailure(new Error("Too many container instances are running")), false);
});

// ---- the create-side capacity classifier ----------------------------------

test("only the capacity message means 'at capacity' on create", () => {
  // Narrower than the teardown predicate on purpose. Telling a visitor the
  // service is full when the platform actually said "the container is not
  // running" would be a lie, and an unreachable service already has an honest
  // tier client-side (`sessionStartMessage`, DEV-2553).
  assert.equal(isAtCapacityFailure(new Error(CAPACITY)), true);
  assert.equal(isAtCapacityFailure(new Error(UNREACHABLE)), false);
  assert.equal(isAtCapacityFailure(new Error(NOT_RUNNING)), false);
  assert.equal(isAtCapacityFailure(new Error("boom")), false);
});

test("the at-capacity sentence never trips the App.tsx connectivity heuristic", () => {
  // Same cross-package contract `session-start-failure.test.mjs` pins:
  // `describeRuntimeError` in apps/authoring/src/App.tsx REPLACES a container
  // message matching this alternation with "install Docker, run the API
  // worker". A visitor who found the pool full is not a developer with no
  // worker running.
  assert.doesNotMatch(atCapacityMessage, /session start failed/i);
  assert.doesNotMatch(atCapacityMessage, /fetch/i);
  assert.doesNotMatch(atCapacityMessage, /failed to fetch|networkerror|load failed/i);
  // And it must not leak the platform's own words: "configuring a higher value
  // for max_instances" is an instruction to us, not to a visitor.
  assert.doesNotMatch(atCapacityMessage, /max_instances|container instances/i);
  assert.ok(atCapacityMessage.length < 200, "a sentence, not a log excerpt");
});

test("the envelope code is stable", () => {
  // `sessionStartMessage` in packages/runtime/src/container.ts matches this
  // exact code to pass the sentence through unwrapped.
  assert.equal(AT_CAPACITY_CODE, "at_capacity");
});
