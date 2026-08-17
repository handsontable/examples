import test from "node:test";
import assert from "node:assert/strict";
import {
  AT_CAPACITY_RETRY_AFTER_SECONDS,
  atCapacityBody,
  isPoolExhausted,
} from "../workers/api/src/pool-capacity.ts";

// DEV-2554. What happens when the Tier-2 container pool has no slot left.
//
// The ticket reported visitors being refused with "no container slots". That string
// is a TEST FIXTURE — `e2e/preview-recovery.spec.ts` stubs it — and a repo-wide grep
// finds it in that one place and nowhere else. No worker, no runtime and no version
// of `@cloudflare/sandbox` emits it. What Cloudflare actually raises when
// `max_instances` is reached is the sentence pinned below, and it appears nowhere in
// this tree either, because nothing has ever handled it.
//
// The classifier is pinned here because the two seams in `index.ts` that call it
// cannot be exercised from `pipeline/` at all — reproducing a full pool needs five
// live containers. Same limitation `preview-boot.test.mjs` documents for its own
// Durable Object seam, and the same answer: keep the logic in a pure module so the
// seam stays a two-line branch.

/** The verbatim workerd sentence, from the two real events on 2026-08-10. */
const WORKERD =
  "Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances";

test("the verbatim workerd capacity sentence is recognised", () => {
  assert.equal(isPoolExhausted(new Error(WORKERD)), true);
});

test("case and surrounding text do not matter", () => {
  // workerd has prefixed this with its own framing before; the match is a substring
  // test on purpose so a wrapper sentence does not silently stop firing.
  assert.equal(
    isPoolExhausted(new Error(`Error in Durable Object: ${WORKERD.toLowerCase()}`)),
    true,
  );
});

test("a capacity failure wrapped in a cause chain is still recognised", () => {
  // The SDK re-throws through its own error types, so the sentence is routinely one
  // or two `.cause` hops down rather than on the error we catch.
  const inner = new Error(WORKERD);
  const middle = new Error("sandbox rpc failed", { cause: inner });
  const outer = new Error("could not start session", { cause: middle });

  assert.equal(isPoolExhausted(outer), true);
});

test("a self-referencing cause terminates instead of hanging", () => {
  // Not hypothetical — the same guard `isPortNotListening` carries. A cycle here
  // would hang the worker's catch block rather than answer the request.
  const looped = new Error("boom");
  looped.cause = looped;

  assert.equal(isPoolExhausted(looped), false);
});

test("a cause chain deeper than the bound gives up rather than walking forever", () => {
  let err = new Error(WORKERD);
  for (let i = 0; i < 12; i += 1) err = new Error(`wrapper ${i}`, { cause: err });

  assert.equal(isPoolExhausted(err), false, "the depth bound is what stops an adversarial chain");
});

test("non-Error values and empty input are not capacity failures", () => {
  for (const value of [undefined, null, "", WORKERD, { message: WORKERD }]) {
    assert.equal(isPoolExhausted(value), false, `${String(value)} should not match`);
  }
});

test("the neighbouring real failures are somebody else's job", () => {
  // All three are real messages from this project's own Sentry breakdown, and each
  // has its own owner: the port refusal is DEV-2537's (`preview-boot.ts`), the other
  // two are undiagnosed and must keep today's 500 and today's Sentry report. A
  // classifier that widened to catch them would silently convert real faults into a
  // soothing "we're busy, retrying" the visitor can do nothing about.
  const neighbours = [
    "There has been an internal error connecting to the port.",
    "The container is not running, consider calling start()",
    "Sandbox operation sandbox.writeFile was interrupted while the platform was updating the sandbox runtime",
  ];

  for (const message of neighbours) {
    assert.equal(isPoolExhausted(new Error(message)), false, `must not claim: ${message}`);
  }
});

test("the envelope names the reason machine-readably and carries a usable delay", () => {
  const body = atCapacityBody();

  // `error` is what the client keys on — `code === "at_capacity"` is what routes the
  // failure past App.tsx's install-Docker heuristic and into the retry. A rename here
  // silently restores the Docker text for a production visitor.
  assert.equal(body.error, "at_capacity");
  assert.ok(typeof body.message === "string" && body.message.length > 0);
  assert.ok(
    Number.isInteger(body.retryAfterSeconds) && body.retryAfterSeconds > 0,
    "Retry-After must be a positive integer number of seconds",
  );
  assert.equal(body.retryAfterSeconds, AT_CAPACITY_RETRY_AFTER_SECONDS);
});

test("the server's sentence is aimed at a user, not at a log reader", () => {
  // It reaches Sentry as the issue title and could reach a user through any client
  // that shows `e.message` verbatim. It must not leak the platform's own wording,
  // which tells the reader to reconfigure `max_instances` — advice for us, not them.
  const { message } = atCapacityBody();

  assert.doesNotMatch(message, /max_instances/i);
  assert.doesNotMatch(message, /maximum number of running container/i);
});
