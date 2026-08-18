// What a failed POST /api/session tells the user (DEV-2538).
//
// Sentry DEMOS-9 collected 82 events titled `Error: session start failed (504): `,
// stopping at a colon: the platform (not our Worker — its catch-all always answers
// with a JSON `{error}` envelope) timed the container start out and returned an empty
// body, which the message template interpolated as nothing.
//
// The empty sentence was only the issue title. What the *user* saw was worse: every
// message on this path reaches `describeRuntimeError` in apps/authoring/src/App.tsx,
// whose container-engine heuristic matches /…|session start failed|fetch/i and
// replaces the message with "run the local API worker (requires Docker)". A visitor
// on demos.handsontable.com whose sandbox timed out was told to install Docker.
//
// So the timeout tier has to say something true AND has to stay clear of the words
// that heuristic keys on. That second half is a contract across a package boundary,
// enforced nowhere but here.
//
// DEV-2553 extends the same contract to an envelope-less 503. The ticket asked for the
// dangling colon — but DEV-2538 had already removed it: an empty body has produced
// `session start failed (503)` (no colon, no tail) since the tier at the bottom of
// `sessionStartMessage` landed. What survived is the half DEV-2538 fixed only for
// 504/522/524: that sentence still contains "session start failed", so the App.tsx
// heuristic still replaces it with "install Docker" for a visitor on
// demos.handsontable.com whose session start was refused above our Worker.
//
// A 503 without an envelope did not come from us. Every refusal our Worker makes on
// POST /api/session is a `json({error}, status)` — the budget guardrail included, and
// its catch-all answers `json({error}, 500)` — so an envelope-less 503 was emitted
// above us. That is all it supports: the tier says "unavailable", never "timed out"
// or "out of capacity", because two Sentry events across two releases (one of which
// could equally have been an unreadable body rather than an empty one) do not name a
// cause. The 503 the preview proxy emits with a bare body (workers/api/src/index.ts,
// DEV-2537) is gated on PREVIEW_PROXY_HEADER and cannot reach this route.

import test from "node:test";
import assert from "node:assert/strict";
import { ContainerRuntime, SessionStartError } from "../packages/runtime/dist/container.js";

const ENTRY = {
  framework: "angular",
  displayName: "Angular",
  tier: 2,
  engine: "container",
  sandpackTemplate: null,
  sandpackEnvironment: null,
  container: "angular",
  htWrappers: [],
  entry: "/src/main.ts",
  htmlEntry: null,
  devCommand: "start",
  buildCommand: "build",
  outputDir: "dist",
  outputGlob: null,
  staticExport: false,
  spaMode: true,
  port: 4200,
  installCommand: "install",
  htCoreRange: null,
  minCoreMajor: null,
  fileCount: 2,
  assets: [],
  skipped: [],
  files: {},
};

const FILES = {
  "/package.json": JSON.stringify({ dependencies: { handsontable: "16.0.1" } }),
  "/src/main.ts": "console.log('demo');",
};

/**
 * Drive the real `mount()` against a stubbed create response and return the error it
 * rejects with. Driven through mount() rather than by calling `readFailure` directly:
 * the tiering under test lives in mount()'s throw, and the failure path there also
 * disposes and DELETEs the half-created session — so the stub has to survive that
 * follow-up request too (a throwing DELETE would mask the assertion).
 */
async function sessionStartError(status, body) {
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = (url, init = {}) => {
    if (url.endsWith("/api/session") && init.method === "POST") {
      // `readFailure` reads the body with res.text(), not res.json().
      return Promise.resolve({ ok: false, status, text: () => Promise.resolve(body) });
    }
    // The cleanup DELETE, and anything else the teardown reaches for.
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };

  const runtime = new ContainerRuntime(ENTRY, { iframe: {}, apiBase: "https://api.test" });
  try {
    await runtime.mount({ ...FILES });
    assert.fail(`mount() resolved on a ${status}`);
  } catch (err) {
    assert.ok(err instanceof SessionStartError, `expected a SessionStartError, got ${err}`);
    assert.equal(err.status, status);
    return err;
  } finally {
    runtime.dispose();
    globalThis.fetch = fetchBefore;
    globalThis.window = windowBefore;
  }
}

test("an empty-bodied 504 says the sandbox timed out, in words the app will not swallow", async () => {
  const err = await sessionStartError(504, "");

  assert.ok(err.message.trim().length > 0, "the user must be told something");
  assert.doesNotMatch(err.message, /:\s*$/, "no dangling colon where the body should have been");
  assert.match(err.message, /504/, "the status keeps Sentry titles distinguishable per status");

  // THE CONTRACT. The container-engine heuristic in `describeRuntimeError`
  // (apps/authoring/src/App.tsx — grep the function, not a line number) tests
  // /failed to fetch|networkerror|load failed|session start failed|fetch/i against this
  // message and, on a match, replaces it with the local-dev "install Docker, run the API
  // worker" text. That is the right answer when a developer's worker is down and the
  // wrong one for a production visitor whose container timed out. Nothing else in the
  // repo pins this — the regex lives in another package — so a copy edit that reads
  // better but says "fetch" would silently restore the misattribution.
  assert.doesNotMatch(err.message, /session start failed/i, "would trip the App.tsx heuristic");
  assert.doesNotMatch(err.message, /fetch/i, "would trip the App.tsx heuristic");
  assert.doesNotMatch(err.message, /failed to fetch|networkerror|load failed/i);
});

test("522 and 524 read as timeouts too, not just 504", async () => {
  // Cloudflare's own "origin never answered" statuses. Without a case per member,
  // a typo in TIMEOUT_STATUSES leaves the 504 test green and ships the old message
  // for the other two.
  for (const status of [522, 524]) {
    const err = await sessionStartError(status, "");
    assert.match(err.message, /took too long/, `${status} should read as a timeout`);
    assert.match(err.message, new RegExp(String(status)));
    assert.doesNotMatch(err.message, /session start failed/i, "would trip the App.tsx heuristic");
  }
});

test("a 504 that does carry an {error} envelope keeps the server's own words", async () => {
  // What `envelope` is for. The timeout tier is deliberately gated on the ABSENCE of
  // an envelope: a body we recognise came from a handler that chose its own words, and
  // discarding them for a generic "took too long" would lose the only explanation.
  // Nothing in our Worker emits a 504 today (its handler and its catch-all both answer
  // with `json({error}, status)` and neither uses 504), so this tier is defensive —
  // but drop the `!failure.envelope` guard and this is the case that silently changes.
  //
  // KNOWN RESIDUAL (DEV-2538): the message this produces still contains "session start
  // failed", so the App.tsx heuristic would still rewrite it as the local-dev hint.
  // Left as is because no producer of an enveloped 504 exists to fix it for; asserted
  // on the server's words rather than on the full string so the wrapper stays free to
  // change without this test blessing the misattribution.
  const err = await sessionStartError(504, JSON.stringify({ error: "boom", message: "the pool is full" }));

  assert.equal(err.code, "boom");
  assert.match(err.message, /the pool is full/, "the envelope's message must survive");
  assert.doesNotMatch(err.message, /took too long/, "the timeout tier must not swallow an envelope");
});

test("a gateway HTML error page never becomes the user's message", async () => {
  // Cloudflare answers some timeouts with a whole HTML page. Interpolated verbatim it
  // becomes both the <pre> the user reads and the Sentry issue title.
  const page = `<html><head><title>Gateway time-out</title></head><body>${"x".repeat(4000)}</body></html>`;
  const err = await sessionStartError(504, page);

  assert.doesNotMatch(err.message, /<html/i);
  assert.ok(err.message.length < 300, `message should be a sentence, got ${err.message.length} chars`);
});

test("an empty-bodied 503 says the service is unavailable, in words the app will not swallow", async () => {
  // DEV-2553. The colon was already gone here — `session start failed (503)` is what
  // this produced before, and it is well-formed English. The defect is the other half
  // of DEMOS-9: those three words hand the message to the App.tsx heuristic, which
  // tells a production visitor to install Docker for a refusal that happened above our
  // Worker entirely.
  const err = await sessionStartError(503, "");

  assert.ok(err.message.trim().length > 0, "the user must be told something");
  assert.doesNotMatch(err.message, /:\s*$/, "no dangling colon where the body should have been");
  assert.match(err.message, /503/, "the status keeps Sentry titles distinguishable per status");

  // THE CONTRACT — same one the 504 test pins, for the same reason. See that test.
  assert.doesNotMatch(err.message, /session start failed/i, "would trip the App.tsx heuristic");
  assert.doesNotMatch(err.message, /fetch/i, "would trip the App.tsx heuristic");
  assert.doesNotMatch(err.message, /failed to fetch|networkerror|load failed/i);

  // Nothing observed supports naming a cause. Two events, two releases, and one of the
  // two candidate mechanisms is a body that threw on read rather than a body that was
  // empty — so "timed out" and "no capacity" are both claims we cannot make.
  assert.doesNotMatch(err.message, /took too long|timed out|capacity/i, "unsupported by the evidence");
});

test("a gateway page on a 503 never becomes the user's message", async () => {
  // The discriminator between the gate we shipped and the obvious alternative. Gating
  // the tier on `!failure.message` would fix only the empty-bodied case and let a
  // platform 503 that DOES carry text — a gateway's HTML page — fall through to
  // "session start failed (503): <html>…", which is just as much not-ours and trips
  // the heuristic just the same. The gate is on the envelope, so this lands on the
  // same sentence and the page is discarded.
  const page = `<html><head><title>Service Unavailable</title></head><body>${"x".repeat(4000)}</body></html>`;
  const err = await sessionStartError(503, page);

  assert.doesNotMatch(err.message, /<html/i, "the page is not the user's message");
  // Anchored at the start, not a bare /unavailable/i: the fixture's own <title> is
  // "Service Unavailable" and sits inside the 200-char truncation cap, so a loose match
  // would pass on `session start failed (503): <html><head><title>Service Unavailable…`
  // — i.e. on the very body tier this test exists to rule out.
  assert.match(
    err.message,
    /^The sandbox service is unavailable/,
    "the envelope-less tier, not the body tier",
  );
  assert.doesNotMatch(err.message, /session start failed/i, "would trip the App.tsx heuristic");
  assert.ok(err.message.length < 300, `message should be a sentence, got ${err.message.length} chars`);
});

test("a 503 that carries an {error} envelope keeps the server's own words", async () => {
  // Body copied verbatim from e2e/preview-recovery.spec.ts's stub, which is the only
  // producer of an enveloped 503 on this route other than the budget guardrail.
  //
  // KNOWN RESIDUAL (DEV-2553): the message below still contains "session start failed",
  // so the App.tsx heuristic still rewrites it as the local-dev Docker hint. Not fixed
  // here — an enveloped failure came from a handler that chose its own words, and the
  // fix for the wrapper around them is to stop wrapping in those three words at all,
  // which would take the local-dev hint with it (see the empty-bodied 500 test below).
  // Asserted on the server's words rather than the whole string so the wrapper stays
  // free to change without this test blessing the misattribution.
  const err = await sessionStartError(503, JSON.stringify({ error: "no container slots" }));

  assert.equal(err.code, "no container slots");
  assert.match(err.message, /no container slots/, "the envelope's message must survive");
  assert.doesNotMatch(err.message, /unavailable/i, "the envelope-less tier must not swallow an envelope");
});

test("a non-timeout status still shows the body, but bounded", async () => {
  // The truncation cap only bites on this tier — a timeout discards the body outright,
  // so a 504 + HTML case proves nothing about the cap.
  const page = `<html><body>${"x".repeat(4000)}</body></html>`;
  const err = await sessionStartError(500, page);

  assert.match(err.message, /^session start failed \(500\): /);
  assert.ok(err.message.length < 300, `body must be capped, got ${err.message.length} chars`);
  assert.match(err.message, /\.\.\.$/, "truncateMessage marks what it cut");
});

test("a budget refusal still reaches the user as the server phrased it", async () => {
  // DEV-2030's guardrail sentence is written for users and must arrive unwrapped —
  // `isBudgetRefusal` and App.tsx's own budget branch both depend on it.
  const sentence = "Live editing is paused for today. Try again tomorrow.";
  const err = await sessionStartError(
    503,
    JSON.stringify({ error: "budget_exhausted", message: sentence }),
  );

  assert.equal(err.code, "budget_exhausted");
  assert.equal(err.message, sentence);
});

test("an at-capacity refusal reaches the user as the server phrased it", async () => {
  // DEV-2556. When every container slot is taken the Worker now answers 503
  // `{ error: "at_capacity", message }` instead of letting the platform's own
  // words ("…try configuring a higher value for max_instances") leave as a 500.
  // That sentence is written for a visitor, so it must arrive unwrapped — the
  // generic tier would prefix "session start failed (503):" and hand the whole
  // thing to the App.tsx heuristic, which answers with the local-dev Docker
  // hint. `pipeline/session-lifecycle.test.mjs` pins the sentence itself; this
  // pins that the runtime does not wrap it.
  const sentence = "All live-preview sandboxes are busy right now. Try again in a minute.";
  const err = await sessionStartError(503, JSON.stringify({ error: "at_capacity", message: sentence }));

  assert.equal(err.code, "at_capacity");
  assert.equal(err.message, sentence);
  assert.doesNotMatch(err.message, /unavailable/i, "the envelope-less tier must not swallow an envelope");
});

test("an ordinary envelope error is unchanged", async () => {
  const err = await sessionStartError(500, JSON.stringify({ error: "boom", message: "boom" }));

  assert.equal(err.code, "boom");
  assert.equal(err.message, "session start failed (500): boom");
});

test("an empty-bodied 500 drops the colon but keeps the connectivity hint", async () => {
  // Deliberately NOT a timeout tier: a local vite proxy answering 500 with nothing
  // usable is exactly the "your API worker isn't running" case App.tsx:115 exists for,
  // so this message must keep tripping it.
  const err = await sessionStartError(500, "");

  assert.equal(err.message, "session start failed (500)");
  assert.match(err.message, /session start failed/i, "must still trip App.tsx:115");
});
