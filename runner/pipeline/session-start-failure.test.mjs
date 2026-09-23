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
//
// The DEMOS-9 facet analysis that followed DEV-2559 found a fourth tier's worth of
// evidence: 459 events of `session_status:504`, none of them carrying `cf-ray` — 371
// of the 459 also carry `session_elapsed_bucket` (the other 88 predate the DEV-2559
// instrumentation deploy and have no elapsed measurement at all), and every one of
// those 371 measured 35-82ms — far under Cloudflare's own ~100s ceiling, so "took too
// long" is false for the events it can be checked against — on a code path where
// every other status from the same deploy (403, 500) carries a ray, 11/11. Nothing
// timed out, and "try Restart preview" cannot help if
// something between the browser and this service answered instead of the edge. That
// tier is gated on `edge.headersReadable` as well as the missing ray, because a
// cross-origin dev setup (App.tsx's `:8787` fallback) makes every header — including
// `cf-ray` — unreadable regardless of who answered, and reading that as evidence would
// fire the tier on every developer's machine. See the tests below this file's
// pre-existing ones.

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

/** The ray the failing create stub advertises, in the shape Cloudflare actually
 *  emits — `<hex>-<COLO>`. */
const RAY = "a2cee5e30f0c08c1-PRG";

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
 *
 * `type: "basic"` is the DEFAULT, not an omission. Production is same-origin
 * (`.env.production` pins `VITE_API_BASE` to the app's own host), so every real
 * failing create is a `basic` response with every header readable — that is the
 * shape the default reproduces. An `undefined` `type` exercises a branch that
 * exists nowhere in production, which is the exact mistake `container.ts`'s own
 * comments (the `cf-ray` read, ~line 592-597) already warn against making for the
 * ray. `headers` defaults to carrying the ray so the eleven pre-existing tests
 * below keep exercising the timeout/edge tiers they were written for; the new
 * interception tests pass `headers` without one.
 */
async function sessionStartError(status, body, { type = "basic", headers: rawHeaders = { "cf-ray": RAY } } = {}) {
  // A real `Headers`, not a hand-rolled `{ get }`: mount() reads `cf-ray` off the
  // failing response (DEV-2559), and every test in this file goes through here, so
  // they all exercise that read rather than a guard around it. If this stub ever
  // loses its headers the fix is to give them back — NOT to make the read optional
  // in container.ts, which would leave the ray assertion below passing on nothing.
  const headers = new Headers(rawHeaders);
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = (url, init = {}) => {
    if (url.endsWith("/api/session") && init.method === "POST") {
      // `readFailure` reads the body with res.text(), not res.json().
      return Promise.resolve({ ok: false, status, type, headers, text: () => Promise.resolve(body) });
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

test("a container-starting refusal reaches the user as the server phrased it, DEV-2857", async () => {
  // The trap this tier exists to close: without a `container_starting` case in
  // `sessionStartMessage`, a 503 WITH an envelope and this unknown code falls
  // through to the generic body tier ("session start failed (503): …"), which
  // trips the same App.tsx heuristic every other tier in this file guards
  // against — and for this refusal specifically, that heuristic's answer is
  // "install Docker", the exact opposite of the truth (the container is ours,
  // just slow). `pipeline/session-lifecycle.test.mjs` pins the sentence
  // itself; this pins that the runtime does not wrap it.
  const sentence =
    "The sandbox is still starting up and did not become ready in time. Nothing is wrong with the code — try \"Restart preview\".";
  const err = await sessionStartError(
    503,
    JSON.stringify({ error: "container_starting", message: sentence }),
  );

  assert.equal(err.code, "container_starting");
  assert.equal(err.message, sentence, "the envelope's message must survive, unwrapped");
  assert.doesNotMatch(err.message, /session start failed/i, "would trip the App.tsx heuristic");
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

test("a failed create carries the edge id and how long it took", async () => {
  // DEV-2559. Sentry DEMOS-9 has 83 events and no way to tell its two candidate causes
  // apart: a fixed ceiling above our Worker, or container starts that are honestly too
  // slow. Neither the duration nor the `cf-ray` is observable at the report site in
  // App.tsx — only mount() holds the clock and the Response — so they ride out on the
  // error, and this pins that they survive the throw.
  //
  // Surviving the throw is the non-obvious half: mount()'s catch tears the runtime
  // down, DELETEs the half-created session and rethrows with
  // `err instanceof Error ? err : …`, i.e. the same instance. Construct a fresh
  // SessionStartError there instead and the diagnostics are silently dropped while
  // every other test in this file stays green.
  const err = await sessionStartError(504, "");

  assert.equal(err.diagnostics?.ray, RAY, "the cf-ray of the failing response, read off it");
  assert.equal(typeof err.diagnostics?.elapsedMs, "number");
  assert.ok(err.diagnostics.elapsedMs >= 0, "a monotonic clock never goes backwards");
});

test("the diagnostics ride alongside the message contract, not inside it", async () => {
  // The behaviour-neutrality half. Everything above about the five message tiers is
  // unchanged by DEV-2559, and the guardrail refusals are the sharpest case: their
  // sentences must still arrive verbatim, and the status/code the App.tsx branch keys
  // on must still be the first things on the error.
  const sentence = "Live editing is paused for today. Try again tomorrow.";
  const err = await sessionStartError(
    503,
    JSON.stringify({ error: "budget_exhausted", message: sentence }),
  );

  assert.equal(err.message, sentence, "the diagnostics argument must not disturb the message");
  assert.equal(err.code, "budget_exhausted");
  assert.equal(err.status, 503);
  assert.equal(err.diagnostics?.ray, RAY);
});

// ── The edge-block tier (DEV-2631, ADR-0038) ────────────────────────────────────
//
// A zone-wide Cloudflare Managed Ruleset rule blocks any request body containing
// `<script`, and 16 of the 19 frameworks ship an HTML entry that has one. So
// `POST /api/session` answered 403 with a Cloudflare error page for most Tier-2
// demos at once — 28 blocks from ~25 distinct external IPs on the first day.
//
// Before this tier, that produced `session start failed (403): <!DOCTYPE html>…`,
// which trips the same `describeRuntimeError` heuristic as DEMOS-9 and told every
// one of those visitors to install Docker and run a local API worker. The Worker
// never ran, so nothing else in the system recorded the event: no Sentry issue, no
// usage row, no `wrangler tail` line. The message was the only evidence there was.

test("a 403 with no envelope reads as an edge block, not as a broken example", async () => {
  const page = `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>${"x".repeat(4000)}</body></html>`;
  const err = await sessionStartError(403, page);

  assert.match(err.message, /blocked before it reached/i, "the cause has to be in the sentence");
  assert.match(err.message, /403/, "the status keeps Sentry titles distinguishable");
  assert.doesNotMatch(err.message, /<html|DOCTYPE|Cloudflare/i, "the edge's error page is not a message");
  assert.ok(err.message.length < 300, `message should be a sentence, got ${err.message.length} chars`);

  // THE SAME CONTRACT the timeout tier above is pinned against, and it matters more
  // here: an edge block hits every visitor of an affected framework simultaneously,
  // so "install Docker" is the one answer that guarantees nobody reports the real
  // cause. See the note on `sessionStartMessage`.
  assert.doesNotMatch(err.message, /session start failed/i, "would trip the App.tsx heuristic");
  assert.doesNotMatch(err.message, /fetch/i, "would trip the App.tsx heuristic");
  assert.doesNotMatch(err.message, /failed to fetch|networkerror|load failed/i);
});

test("the edge tier does not invite a retry", async () => {
  // The timeout tier ends with `try "Restart preview"` and should. A rule that refused
  // this request will refuse the retry too, so the same hint here buys a loop the
  // visitor reads as our flakiness — and buries the one sentence naming the cause.
  const err = await sessionStartError(403, "<html>blocked</html>");

  assert.doesNotMatch(err.message, /restart preview/i);
  assert.doesNotMatch(err.message, /try again|retry/i);
});

test("a 403 that does carry an {error} envelope keeps the server's own words", async () => {
  // Gated on the ABSENCE of an envelope, exactly like the timeout tier. Nothing in the
  // session handler emits a 403 today — it answers 400, 410 and the guardrail's 401/503
  // — so this is defensive; drop the `!failure.envelope` guard and a handler that starts
  // returning one has its explanation silently replaced by a firewall story.
  const err = await sessionStartError(
    403,
    JSON.stringify({ error: "forbidden", message: "this session belongs to someone else" }),
  );

  assert.equal(err.code, "forbidden");
  assert.match(err.message, /belongs to someone else/, "the envelope's message must survive");
  assert.doesNotMatch(err.message, /blocked before it reached/i, "the edge tier must not swallow an envelope");
});

// ── The interception tier (DEMOS-9 facet analysis) ──────────────────────────────
//
// 459 events of `session_status:504` over 90 days, none carrying a `cf-ray` — 371 of
// them also measured, all 35-82ms (the other 88 predate the DEV-2559 instrumentation
// deploy and carry no elapsed measurement at all) — on a code path where every other
// status from the same deploy (11/11 events, mixed 403/500) does carry a ray. Nothing
// timed out — the measured median is two orders of magnitude under Cloudflare's own
// ~100s ceiling — so "took too long" is a false claim, and "try Restart preview" cannot help if
// something local intercepted the request before it reached our edge. This tier
// replaces that sentence for exactly the case the evidence supports: an unreached
// 504 whose headers we CAN read (so absence of a ray means something, rather than
// an artefact of CORS hiding all headers from us).
//
// The `headersReadable` conjunct is load-bearing, not decorative: local dev
// defaults to cross-origin (`API_BASE` falls back to `:8787`), where `cors()`
// exposes no headers, so ray-absence proves nothing there. Without this conjunct
// the new tier would fire on every developer's machine. See T2/T4.

test("an unreached 504 says the reply carries no sign of our edge, in words the app will not swallow", async () => {
  const err = await sessionStartError(504, "", {
    type: "basic",
    headers: { "content-type": "text/html" },
  });

  assert.match(
    err.message,
    /^The sandbox service could not be reached \(504\)\./,
    "today's message is 'The sandbox took too long to start (504)…'",
  );
  assert.doesNotMatch(err.message, /took too long|timed out/i, "35-82ms is not a timeout");

  // Guards — pass today too (they pin the copy contract, same four calls the 504
  // and 403 tests above already make, copied verbatim).
  assert.doesNotMatch(err.message, /session start failed/i, "would trip the App.tsx heuristic");
  assert.doesNotMatch(err.message, /fetch/i, "would trip the App.tsx heuristic");
  assert.doesNotMatch(err.message, /failed to fetch|networkerror|load failed/i);
  assert.match(err.message, /504/, "the status keeps Sentry titles distinguishable per status");
  assert.doesNotMatch(err.message, /:\s*$/, "no dangling colon where the body should have been");
  assert.ok(err.message.length < 300, `message should be a sentence, got ${err.message.length} chars`);
  assert.doesNotMatch(
    err.message,
    /restart preview/i,
    "whatever answered instead will answer the retry the same way",
  );
});

test("the tier turns on where the response came from, not on the status", async () => {
  const a = await sessionStartError(504, "", { type: "basic", headers: { "cf-ray": RAY } });
  const b = await sessionStartError(504, "", { type: "basic", headers: { "content-type": "text/html" } });
  const c = await sessionStartError(504, "", { type: "cors", headers: {} });

  assert.notEqual(b.message, a.message, "a ray-bearing 504 is a different claim");
  assert.notEqual(b.message, c.message, "unreadable headers are not evidence");

  // The forward-compatibility guard: no production event has ever taken branch A
  // (§2.2 of the plan — 0 of 371 post-instrumentation 504s carry a ray), so this is
  // pinned in test only. And the cross-origin fallback: without `headersReadable`
  // a developer pointed at :8787 would be told the request never reached us on no
  // evidence at all.
  assert.match(a.message, /took too long/, "a ray-bearing 504 keeps the old timeout wording");
  assert.match(c.message, /took too long/, "an unreadable (cross-origin) response falls back too");
});

test("a failed create carries what the response's headers say about where it came from", async () => {
  const err = await sessionStartError(504, "", {
    type: "basic",
    headers: { "cf-ray": RAY, server: "cloudflare", "content-type": "text/plain" },
  });

  assert.deepEqual(err.diagnostics.headerNames, ["cf-ray", "content-type", "server"]);
  assert.equal(err.diagnostics.responseType, "basic");
  assert.equal(err.diagnostics.headersReadable, true);
  assert.equal(err.diagnostics.server, "cloudflare");
  assert.equal(err.diagnostics.headerCount, 3);
  // These survive mount()'s catch for the same non-obvious reason the ray does
  // (see "a failed create carries the edge id and how long it took" above) — it
  // rethrows the same instance rather than constructing a fresh one.
});

test("a cross-origin response reports that its headers were unreadable, not that they were absent", async () => {
  const err = await sessionStartError(504, "", { type: "cors", headers: {} });

  assert.equal(err.diagnostics.headersReadable, false);
  assert.deepEqual(err.diagnostics.headerNames, []);
  assert.equal(err.diagnostics.server, null);
  assert.equal(err.diagnostics.ray, null);
  // This is the shape a developer pointed straight at :8787 produces — `cors()` in
  // workers/api exposes no headers — and the reason the copy gate carries
  // `headersReadable` at all rather than trusting a null ray on its own.
});

test("the header-name list is capped, and says it was", async () => {
  const many = {};
  for (let i = 0; i < 30; i += 1) many[`x-h-${String(i).padStart(2, "0")}`] = "v";
  const err = await sessionStartError(504, "", { type: "basic", headers: many });

  assert.equal(err.diagnostics.headerNames.length, 20);
  assert.equal(err.diagnostics.headerCount, 30, "a truncated list must be detectable as truncated");
  // `extra` is not free — a response can carry arbitrarily many headers, and this
  // is the same bounding discipline `FAILURE_TEXT_MAX` applies to the body.
});

// ---------------------------------------------------------------------------
// T07 — `onSessionStart` (§5 `session.start_ms`). `pipeline/browser-metrics.test.mjs`
// covers `apps/authoring/src/telemetry/metrics.ts`'s own emission logic against a
// fake hook; this covers whether `container.ts`'s classification and the
// create-clock reuse are correct against the REAL `mount()`.

/**
 * Drive `mount()` through a fake `POST /api/session` and return what
 * `onSessionStart` saw. `respond(url, init)` answers the create POST; every other
 * request (the status poll `mount()` kicks off right after returning, the cleanup
 * DELETE on a failure) gets a quiet default that ends polling without further
 * network activity. `window`/`fetch` are restored and the runtime disposed in
 * `finally`, mirroring `sessionStartError` above.
 */
async function mountAndCollectSessionStart(respond) {
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = (url, init = {}) => {
    if (url.endsWith("/api/session") && init.method === "POST") return Promise.resolve(respond(url, init));
    // 410 stops the status-poll loop outright — the simplest "nothing more
    // happens" shape for a unit test; a bare `ok:true` also serves the cleanup DELETE.
    return Promise.resolve({ ok: false, status: 410, headers: new Headers(), text: () => Promise.resolve("") });
  };

  const runtime = new ContainerRuntime(ENTRY, { iframe: {}, apiBase: "https://api.test" });
  const events = [];
  runtime.onSessionStart((e) => events.push(e));
  try {
    await runtime.mount({ ...FILES }).catch(() => {});
    return events;
  } finally {
    runtime.dispose();
    globalThis.fetch = fetchBefore;
    globalThis.window = windowBefore;
  }
}

test("onSessionStart: a successful create reports outcome ready, once, with the create-clock's own elapsed time", async () => {
  const events = await mountAndCollectSessionStart(() => ({
    ok: true,
    status: 200,
    type: "basic",
    headers: new Headers(),
    json: () => Promise.resolve({ previewUrl: "https://1234-sess-tok.demos.handsontable.com", port: 3000 }),
  }));

  assert.equal(events.length, 1, "guard: exactly one session.start_ms per mount(), not one per internal step");
  assert.equal(events[0].outcome, "ready");
  assert.ok(events[0].elapsedMs >= 0, "reuses the same create-POST clock as SessionStartDiagnostics.elapsedMs");
});

test("onSessionStart: each refusal code maps to its own outcome, and fires before dispose() clears the listener", async () => {
  const cases = [
    { code: "at_capacity", status: 503, outcome: "at_capacity" },
    { code: "container_starting", status: 503, outcome: "container_starting" },
    { code: "budget_exhausted", status: 410, outcome: "budget_denied" },
    { code: "budget_login_required", status: 401, outcome: "budget_denied" },
  ];
  for (const { code, status, outcome } of cases) {
    const events = await mountAndCollectSessionStart(() => ({
      ok: false,
      status,
      type: "basic",
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ error: code, message: "refused" })),
    }));
    // If `dispose()` (called inside `mount()`'s own catch) cleared `sessionStartCbs`
    // before this emission, `events` would be empty — the guard this asserts.
    assert.equal(events.length, 1, `${code}: guard: emission must land before dispose() clears the listener`);
    assert.equal(events[0].outcome, outcome, `${code} should map to ${outcome}`);
  }
});

test("onSessionStart: an envelope-less timeout maps to boot_timeout", async () => {
  const events = await mountAndCollectSessionStart(() => ({
    ok: false,
    status: 522,
    type: "basic",
    headers: new Headers({ "cf-ray": RAY }),
    text: () => Promise.resolve(""),
  }));

  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "boot_timeout");
});

test("onSessionStart: the DEMOS-9 interception 504 (envelope-less, ray-less, headers readable) maps to error, not boot_timeout", async () => {
  // Mirrors `classifySessionStartOutcome`'s own precedence, checked before the
  // generic timeout tier since 504 is a member of both sets: "the response
  // carries no sign of having come from our servers" is not a boot timeout.
  const events = await mountAndCollectSessionStart(() => ({
    ok: false,
    status: 504,
    type: "basic",
    headers: new Headers(),
    text: () => Promise.resolve(""),
  }));

  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "error", "guard: DEMOS-9 interception must not read as our own boot timing out");
});

test("onSessionStart: an enveloped 504 (our own words) still reads as a generic error, not boot_timeout", async () => {
  // An envelope means the response came from our own Worker, not from the
  // platform above it — `classifySessionStartOutcome`'s timeout/interception
  // tiers are both gated on `!envelope`.
  const events = await mountAndCollectSessionStart(() => ({
    ok: false,
    status: 504,
    type: "basic",
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify({ error: "boom", message: "the pool is full" })),
  }));

  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "error");
});

test("onSessionStart: fetch() itself throwing (no response at all) still reports outcome error with a real elapsed time", async () => {
  const events = await mountAndCollectSessionStart(() => {
    throw new TypeError("Failed to fetch");
  });

  assert.equal(events.length, 1, "guard: a network error with no SessionStartError must still emit exactly once");
  assert.equal(events[0].outcome, "error");
  assert.ok(events[0].elapsedMs >= 0);
});

// ---------------------------------------------------------------------------
// T07 — `onHmr` (§5 `hmr.roundtrip_ms`). Drives the private `onFrameLoad` handler
// directly (the same style `sandpack-reload.test.mjs` drives `onMessage`) rather
// than through a full `poll()`/iframe simulation — see `HmrRoundtripEvent`'s own
// doc comment for what this hook does and does not observe (only a dev server
// that does a full page reload on an edit; genuine in-place HMR never fires an
// iframe `load` at all and stays invisible either way).

/** `dispose()` unconditionally reaches for `window.removeEventListener` — needed
 *  even though these tests never call `mount()` (which is what normally stubs it).
 *  Restores `window` only after `fn()`'s promise settles, not synchronously after
 *  it returns one — the last of these tests disposes inside a `.finally()`. */
async function withFakeWindow(fn) {
  const windowBefore = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    return await fn();
  } finally {
    globalThis.window = windowBefore;
  }
}

test("onHmr: a post-ready frame load following an edit flush reports the flush-to-load duration", () =>
  withFakeWindow(() => {
    const runtime = new ContainerRuntime(ENTRY, { iframe: {} });
    const events = [];
    runtime.onHmr((e) => events.push(e));
    runtime.didReady = true;
    runtime.lastEditFlushDispatchedAt = performance.now() - 25;

    runtime.onFrameLoad();

    assert.equal(events.length, 1);
    assert.ok(events[0].durationMs >= 0);
    runtime.dispose();
  }));

test("onHmr: the very first (pre-ready) navigation never reports — that is the boot page, not an edit", () =>
  withFakeWindow(() => {
    const runtime = new ContainerRuntime(ENTRY, { iframe: {} });
    const events = [];
    runtime.onHmr((e) => events.push(e));
    // didReady is still false: this is the initial pointing navigation.
    runtime.lastEditFlushDispatchedAt = performance.now() - 25;

    runtime.onFrameLoad();

    assert.equal(events.length, 0, "guard: the pre-ready navigation must not be mistaken for an HMR round trip");
    runtime.dispose();
  }));

test("onHmr: our own reload() navigation does not report", () =>
  withFakeWindow(() => {
    const runtime = new ContainerRuntime(ENTRY, { iframe: {} });
    const events = [];
    runtime.onHmr((e) => events.push(e));
    runtime.didReady = true;
    runtime.reloadInFlight = true;
    runtime.lastEditFlushDispatchedAt = performance.now() - 25;

    runtime.onFrameLoad();

    assert.equal(events.length, 0, "guard: an explicit refresh must not read as a dev-server HMR reload");
    runtime.dispose();
  }));

test("onHmr: a post-ready load with no preceding edit flush does not report (nothing to time)", () =>
  withFakeWindow(() => {
    const runtime = new ContainerRuntime(ENTRY, { iframe: {} });
    const events = [];
    runtime.onHmr((e) => events.push(e));
    runtime.didReady = true;
    // lastEditFlushDispatchedAt stays null — no edit was made.

    runtime.onFrameLoad();

    assert.equal(events.length, 0);
    runtime.dispose();
  }));

test("flush() only starts the HMR dispatch clock once the preview is already ready", () =>
  withFakeWindow(() => {
    const runtime = new ContainerRuntime(ENTRY, { iframe: {} });
    // Simulate the pre-ready buffered flush mount() triggers for edits made mid-create.
    runtime.mounted = true;
    runtime.sessionId = "sess-test";
    runtime.pending.set("/src/main.ts", "x");
    const before = runtime.lastEditFlushDispatchedAt;

    const fetchBefore = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    return runtime
      .flush()
      .then(() => {
        assert.equal(
          runtime.lastEditFlushDispatchedAt,
          before,
          "guard: a pre-ready flush must not start the HMR clock — didReady is still false",
        );
      })
      .finally(() => {
        globalThis.fetch = fetchBefore;
        runtime.dispose();
      });
  }));
