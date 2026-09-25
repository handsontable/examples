// ADR §B.2 step 1–3 (normalise) tests: Faro item processing, OTLP JSON +
// protobuf decode, hashing determinism (exit criterion 4's precondition),
// timestamp rules (exit criterion 3), and the scrub assertions the
// acceptance criteria require "over all fixtures" (no query string, user
// agent, Babel code frame, preview hostname, `url.full`, geo or ASN in any
// stored record).
//
// Run: node --experimental-strip-types --test pipeline/o11y-normalise.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { processFaroBody, countFaroItems, MAX_FARO_ITEMS_PER_BODY } = await import(
  "../workers/o11y/src/normalise/faro.ts"
);
const { redactIpInText, scrubBodyText } = await import("../workers/o11y/src/normalise/text-scrub.ts");
const { decodeOtlpJson, processOtlpBody } = await import("../workers/o11y/src/normalise/otlp.ts");
const { decodeOtlpProtobuf } = await import("../workers/o11y/src/normalise/otlp-protobuf.ts");
const { hashRecord } = await import("../workers/o11y/src/normalise/hash.ts");
const { processDeployPayload } = await import("../workers/o11y/src/normalise/deploy.ts");
const { processSentryPayload } = await import("../workers/o11y/src/normalise/sentry.ts");
const { fingerprint } = await import("../packages/runtime/dist/telemetry/index.js");

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const faroFixture = (name) => JSON.parse(readFileSync(`${FIXTURES}faro/${name}`, "utf8"));
const otlpJsonFixture = (name) => readFileSync(`${FIXTURES}otlp/json/${name}`, "utf8");
const otlpProtobufFixture = (name) => new Uint8Array(readFileSync(`${FIXTURES}otlp/protobuf/${name}`));

const ENV = { O11Y_ENV: "production" };
const SERVICE = { name: "demos-authoring", version: "deadbeef1234", environment: "production" };

/** Every string leaf of a value, concatenated — the acceptance criteria say
 *  "assert over all fixtures," so these helpers grep the *whole* serialised
 *  record rather than checking a few named fields, matching the review
 *  advice given before implementation ("grep the whole serialised stored
 *  line"). */
function allText(value) {
  return JSON.stringify(value);
}

// ---- Faro --------------------------------------------------------------------

test("Faro exception with a code frame: scrubbed, fingerprinted, hot.kind=exception", async () => {
  const body = faroFixture("exception-code-frame.json");
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.equal(item.invalid, undefined);
  assert.ok(item.ingestItem, "an exception must always be stored");

  const text = allText(item.ingestItem.record);
  assert.doesNotMatch(text, /\?t=1700000000/, "no query string survives");
  assert.doesNotMatch(text, /8787-abc123-tok3n/, "no preview hostname survives");
  assert.doesNotMatch(text, /> 2 \|/, "no Babel code-frame gutter line survives");
  assert.doesNotMatch(text, /\^\s*"/, "no code-frame caret line survives");

  assert.equal(item.ingestItem.record.attributes["hot.kind"], "exception");
  assert.equal(item.aePoints.length, 1);
  assert.equal(item.aePoints[0].indexes[0], "error.uncaught"); // handled: "false" in the fixture
  assert.ok(item.ingestItem.fingerprint, "authoring surface must feed the new-fingerprint alert");
});

// ---- R3 F17c: IP redaction (contract §3 "never sent": an IP) -------------------
//
// The exact R3-triage verification canary message (F17c): the privacy
// canary `192.0.2.55` only "passed" before this fix because its whole
// record was lost to a different, separately-fixed bug (F17a: a Faro
// gecko-regex fallback that turned the message line into a fake stack
// frame, dropped by the noise gate before ingest ever saw it — that gate
// lives in `apps/authoring`, outside this Worker/package, so is untouched
// here). Sent as an ordinary Faro log (not an exception with a stack) so
// this test exercises `redactIpInText` on its own merits, independent of
// F17a/F17b.
const IP_CANARY_MESSAGE = "HAIKU1 pii jane.doe@example.com 192.0.2.55 https://x.test/p?token=SECRET123";

test("Faro log: the exact R3 F17c canary message — IP, email and token all redacted, over the full ingest pipeline", async () => {
  const body = faroFixture("log.json");
  body.logs[0].message = IP_CANARY_MESSAGE;
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem, "a log must always be stored");

  const text = allText(item.ingestItem.record);
  assert.doesNotMatch(text, /192\.0\.2\.55/, "the IPv4 address must not survive");
  assert.doesNotMatch(text, /jane\.doe@example\.com/, "the email must not survive");
  assert.doesNotMatch(text, /token=/, "the query string (token) must not survive");
  assert.doesNotMatch(text, /SECRET123/, "the token value must not survive");
  assert.match(text, /<ip>/, "the IP must be replaced with the <ip> token");
  assert.match(text, /<email>/, "the email must be replaced with the <email> token");
});

test("redactIpInText / scrubBodyText: version strings are untouched (no false positive)", () => {
  assert.equal(redactIpInText("Handsontable 18.1.1 release notes"), "Handsontable 18.1.1 release notes");
  assert.equal(redactIpInText("build 1.2.3.4-beta shipped"), "build 1.2.3.4-beta shipped");
  assert.equal(scrubBodyText("Handsontable 18.1.1 release notes"), "Handsontable 18.1.1 release notes");
  assert.equal(scrubBodyText("build 1.2.3.4-beta shipped"), "build 1.2.3.4-beta shipped");
});

test("redactIpInText: IPv6 is redacted (compressed and full forms)", () => {
  assert.equal(redactIpInText("client at ::1 connected"), "client at <ip> connected");
  assert.equal(redactIpInText("seen from fe80::1 today"), "seen from <ip> today");
  assert.equal(
    redactIpInText("full address 2001:0db8:0000:0000:0000:8a2e:0370:7334 logged"),
    "full address <ip> logged",
  );
  assert.equal(
    redactIpInText("compressed 2001:db8::8a2e:370:7334 logged"),
    "compressed <ip> logged",
  );
});

test("Faro log: an IPv6 address in the message is redacted over the full ingest pipeline", async () => {
  const body = faroFixture("log.json");
  body.logs[0].message = "connection from 2001:db8::8a2e:370:7334 failed";
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  const text = allText(item.ingestItem.record);
  assert.doesNotMatch(text, /2001:db8::8a2e:370:7334/, "the IPv6 address must not survive");
  assert.match(text, /<ip>/, "the IPv6 address must be replaced with the <ip> token");
});

test("Faro: T06's diagnostic tags (handled, sentry_event_id, ...) survive scrub+hoist into the stored record (merge fix, T02+T06)", async () => {
  const body = faroFixture("log.json");
  body.logs[0].context = {
    ...body.logs[0].context,
    handled: "true",
    context: "tier1-compiler-asset",
    sentry_event_id: "abc123def456",
    versions_fetch_outcome: "ok",
    versions_fetch_elapsed_bucket: "<1s",
  };
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem);
  const attrs = item.ingestItem.record.attributes ?? {};
  assert.equal(attrs.handled, "true");
  assert.equal(attrs.context, "tier1-compiler-asset");
  assert.equal(attrs.sentry_event_id, "abc123def456");
  assert.equal(attrs.versions_fetch_outcome, "ok");
  assert.equal(attrs.versions_fetch_elapsed_bucket, "<1s");
  // None of the diagnostic tags belong in resourceAttributes.
  for (const key of ["handled", "context", "sentry_event_id", "versions_fetch_outcome"]) {
    assert.ok(!(key in item.ingestItem.record.resourceAttributes), `${key} must not become a resource attribute`);
  }
});

// R3 F18: measurements are AE-only (contract §6 / ADR §F.1 ruling) — flipped
// from "one browser metric point, stored record" now that `faro.ts` sets
// `storeRecord = false` for every Faro `measurement` item. Still goes
// through the exact hash-only `ingestItem` path `example.*` events already
// use (A-I4 remainder), so dedupe on a redelivered batch still works — see
// the dedicated dedupe test below.
test("Faro measurement: one Analytics Engine point, no STORED record (F18: AE-only)", async () => {
  const body = faroFixture("measurement.json");
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem, "a measurement must still get a hash to dedupe on");
  assert.equal(item.ingestItem.record, undefined, "but must never carry a record — F18: AE points only, never stored");
  assert.equal(typeof item.ingestItem.hash, "string");
  assert.ok(item.ingestItem.hash.length > 0);
  assert.equal(item.aePoints.length, 1);
  assert.equal(item.aePoints[0].indexes[0], "preview.ready_ms");
});

// R3 F18: same flip for web-vitals — Faro's own `type: "web-vitals"` is
// still a `measurement` item at the wire level (`processMeasurement`'s
// other branch, faro.ts), so it takes the same `storeRecord = false` path.
test("Faro web-vitals: LCP/INP/CLS become points, FCP is not a contract reason, no stored record (F18: AE-only)", async () => {
  const body = faroFixture("web-vitals.json");
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem, "a web-vitals measurement must still get a hash to dedupe on");
  assert.equal(item.ingestItem.record, undefined, "a web-vitals measurement must never be stored (F18)");
  const reasons = item.aePoints.map((p) => p.indexes[0]);
  assert.deepEqual(reasons, ["web_vital", "web_vital", "web_vital"]);
});

// R3 F18 dedupe: the same hash-only path `example.open`'s own test above
// proves must survive a redelivered batch without double-counting.
test("Faro measurement: a redelivered identical batch hashes identically (dedupe-eligible)", async () => {
  const body = faroFixture("measurement.json");
  const receivedAtMs = Date.now();
  const [first] = await processFaroBody(body, ENV, SERVICE, receivedAtMs);
  const [second] = await processFaroBody(body, ENV, SERVICE, receivedAtMs + 5000);
  assert.equal(
    first.ingestItem.hash,
    second.ingestItem.hash,
    "the same measurement, redelivered at a different arrival time, must hash identically so InboxWriter.ingest's dedupe actually catches it",
  );
});

// R3 F18 acceptance criterion: "A Faro batch with measurement + log +
// exception: only the log and exception records reach the inbox, and all AE
// points are written." The AE-points-are-written half is proven by the two
// tests above (both still return a populated `aePoints` array); this proves
// the inbox-storage half across one real mixed batch, the shape the
// acceptance criterion actually names.
test("Faro mixed batch (measurement + log + exception): only the log and exception carry a stored record", async () => {
  const measurementBody = faroFixture("measurement.json");
  const logBody = faroFixture("log.json");
  const exceptionBody = faroFixture("exception-code-frame.json");
  const body = {
    meta: measurementBody.meta,
    measurements: measurementBody.measurements,
    logs: logBody.logs,
    exceptions: exceptionBody.exceptions,
  };
  const items = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.equal(items.length, 3, "all three items must be processed");

  const measurementItem = items.find((item) => item.aePoints[0]?.indexes[0] === "preview.ready_ms");
  const logItem = items.find((item) => item.ingestItem?.record?.attributes?.["hot.kind"] === "log");
  const exceptionItem = items.find((item) => item.ingestItem?.record?.attributes?.["hot.kind"] === "exception");

  assert.ok(measurementItem, "the measurement item must be found");
  assert.ok(logItem, "the log item must be found");
  assert.ok(exceptionItem, "the exception item must be found");

  assert.equal(measurementItem.ingestItem.record, undefined, "the measurement must not carry a record (F18)");
  assert.ok(logItem.ingestItem.record, "the log must carry a record");
  assert.ok(exceptionItem.ingestItem.record, "the exception must carry a record");

  // All three still produce their AE point(s) — F18 only drops the stored
  // record, never the point.
  assert.equal(measurementItem.aePoints.length, 1);
  assert.equal(exceptionItem.aePoints.length, 1);
});

test("Faro example.open: one Analytics Engine point, no STORED record — but a hash-only ingestItem (A-I4 remainder, closed second wave)", async () => {
  const body = faroFixture("example-open.json");
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  // A-I4's original fix bypassed dedupe entirely for example.* events (no
  // `ingestItem` at all) — that let a retried/redelivered batch inflate
  // ADR-0042's analytics counts on every replay. Fixed: a hash-only
  // ingestItem (no `record`) still goes through InboxWriter.ingest's own
  // dedupe transaction, so `index.ts#handleCollect`'s existing
  // outcome-gated point-write logic covers it — but `record` stays absent,
  // so `appendRows`/`pack.ts` still never store anything for it (§6
  // unchanged).
  assert.ok(item.ingestItem, "an example.* event must still get a hash to dedupe on");
  assert.equal(item.ingestItem.record, undefined, "but must never carry a record — §6: AE points only, never stored");
  assert.equal(typeof item.ingestItem.hash, "string");
  assert.ok(item.ingestItem.hash.length > 0);
  assert.equal(item.aePoints.length, 1);
  assert.equal(item.aePoints[0].indexes[0], "example.open");
});

test("Faro example.open: a redelivered identical batch hashes identically (dedupe-eligible) — a distinct client timestamp does not", async () => {
  const body = faroFixture("example-open.json");
  const receivedAtMs = Date.now();
  const [first] = await processFaroBody(body, ENV, SERVICE, receivedAtMs);
  const [second] = await processFaroBody(body, ENV, SERVICE, receivedAtMs + 5000);
  assert.equal(
    first.ingestItem.hash,
    second.ingestItem.hash,
    "the same example.* event body, redelivered at a different arrival time, must hash identically so InboxWriter.ingest's dedupe actually catches it",
  );

  // A different CLIENT timestamp (a genuinely distinct click) must NOT
  // collapse into the same hash (advisor review, this fix round: "hash the
  // item as sent, including its client timestamp").
  const distinctBody = faroFixture("example-open.json");
  for (const e of distinctBody.events ?? []) e.timestamp = new Date(Date.now() + 60_000).toISOString();
  const [distinct] = await processFaroBody(distinctBody, ENV, SERVICE, receivedAtMs);
  assert.notEqual(first.ingestItem.hash, distinct.ingestItem.hash, "a genuinely distinct client timestamp must not collapse two real clicks into one hash");
});

test("Faro log: stored record, no Analytics Engine point", async () => {
  const body = faroFixture("log.json");
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem);
  assert.equal(item.aePoints.length, 0);
});

// ---- fix round (finding A-I4): a per-request item cap -------------------------

test("countFaroItems sums every kind, including traces (always-invalid) — the cap check runs before any real work", () => {
  const body = {
    exceptions: [{}, {}],
    logs: [{}],
    measurements: [{}],
    events: [{}, {}],
    traces: [{}],
  };
  assert.equal(countFaroItems(body), 7);
  assert.equal(countFaroItems({}), 0);
  assert.equal(countFaroItems(null), 0);
  assert.equal(countFaroItems("not an object"), 0);
});

test("MAX_FARO_ITEMS_PER_BODY is a real, generous-but-finite bound (finding A-I4: ~16.7k items measured from one 1 MB body)", () => {
  assert.ok(MAX_FARO_ITEMS_PER_BODY > 0 && MAX_FARO_ITEMS_PER_BODY < 1000, "must be a real bound, not effectively unbounded");
});

// ---- fix round (finding A-M1): a malformed item must never crash the batch ----

test("processFaroBody: a null entry inside logs never throws (the exact 500 probe from finding A-M1) and still processes the real item next to it", async () => {
  const body = faroFixture("log.json");
  body.logs = [null, ...body.logs];
  const items = await Promise.resolve(processFaroBody(body, ENV, SERVICE, Date.now()));
  assert.equal(items.length, 2);
  assert.equal(items[0].invalid, "item is not an object");
  assert.ok(items[1].ingestItem, "the well-formed item next to the malformed one must still be stored");
});

// ---- controller handoff: server-side noise gates (D-I2 defence in depth) ------

test("Faro exception: an unhandled ResizeObserver-loop message is dropped entirely (never stored, no point, no fingerprint) — the server-side D-I2 backstop", async () => {
  const body = faroFixture("exception-code-frame.json");
  body.exceptions[0].value = "ResizeObserver loop completed with undelivered notifications.";
  body.exceptions[0].type = "Error";
  body.exceptions[0].context.handled = "false";
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.equal(item.ingestItem, undefined, "a browser-noise shape must never be stored");
  assert.equal(item.aePoints.length, 0, "no error.uncaught point either");
  assert.equal(item.invalid, undefined, "a dropped-as-noise item is not an error");
});

test("Faro exception: the Office-scanner rejection text is dropped the same way", async () => {
  const body = faroFixture("exception-code-frame.json");
  body.exceptions[0].value = "Object Not Found Matching Id:5, MethodName:update, ParamCount:4";
  body.exceptions[0].type = "Error";
  body.exceptions[0].context.handled = "false";
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.equal(item.ingestItem, undefined);
  assert.equal(item.aePoints.length, 0);
});

test("Faro exception: an explicitly HANDLED report that merely quotes noise text is NOT dropped (mirrors eventGate.ts's own handled discriminator)", async () => {
  const body = faroFixture("exception-code-frame.json");
  body.exceptions[0].value = "Failed to fetch";
  body.exceptions[0].type = "TypeError";
  body.exceptions[0].context.handled = "true"; // an explicit reportError call, not a global onerror
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem, "a handled report must never be silently dropped as noise");
  assert.equal(item.aePoints[0].indexes[0], "error.handled");
});

test("Faro exception: an unrelated unhandled error is NOT dropped", async () => {
  const body = faroFixture("exception-code-frame.json");
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem, "a real, unrelated exception must still be stored");
});

// ---- fix round (finding D-I3, A-C2): the client's own fingerprint --------------

test("Faro exception: a well-formed payload.fingerprint (Faro's own wire field, D-I3) is used verbatim, not recomputed from the stack", async () => {
  const body = faroFixture("exception-code-frame.json");
  body.exceptions[0].fingerprint = "versions-fetch:0123456789abcdef";
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem);
  assert.equal(item.ingestItem.fingerprint, "versions-fetch:0123456789abcdef");
});

test("Faro exception: an invalid payload.fingerprint (fix round A-C2 probe — Slack mrkdwn injection shape) is discarded, never trusted verbatim", async () => {
  const body = faroFixture("exception-code-frame.json");
  body.exceptions[0].fingerprint = "<!channel> N <https://evil.example|open Grafana>";
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem);
  assert.ok(item.ingestItem.fingerprint, "the surface still feeds the new-fingerprint alert with a SERVER-computed value");
  assert.ok(
    !item.ingestItem.fingerprint.includes("<!channel>"),
    "the attacker's raw string must never reach the exact first-seen registry",
  );
  assert.match(item.ingestItem.fingerprint, /^authoring:[0-9a-f]{16}$/, "falls back to the contract's own §7 shape");
});

test("Faro exception: an invalid context['hot.fingerprint'] is discarded the same way as an invalid wire fingerprint", async () => {
  const body = faroFixture("exception-code-frame.json");
  body.exceptions[0].context["hot.fingerprint"] = "<!channel> pwned";
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem);
  assert.match(item.ingestItem.fingerprint, /^authoring:[0-9a-f]{16}$/);
});

// ---- fix round (finding D-I3 remainder, second wave): the FALLBACK
// fingerprint (no wire/AE-only fingerprint present — the raw
// window.onerror/unhandledrejection/render-crash path) must hash the
// contract-normalised `type: value` message, never `record.body`'s
// rendered stack — a minified bundle's chunk hash and line:col shift on
// every deploy, so hashing the stack churned a genuinely recurring defect
// into a fresh `fp:` entry on every release. --------------------------------

test("Faro exception (uncaught, no client fingerprint): two different stacks for the SAME type/value fingerprint identically", async () => {
  // The two stacks differ in exactly the ways a redeploy of the SAME source
  // actually varies: the minifier's own single-letter identifier assignment
  // for an unrelated local function shifts ("t" vs "n" — a bundler-wide
  // renumbering, not a chunk-hash or line:col change), AND one extra
  // inlined frame appears in one build but not the other. Neither is a URL
  // or a bare number, so `normalizeMonitorMessage`'s own generic `<url>`/
  // `<n>` collapsing (packages/runtime/src/monitor.ts) does NOT already
  // neutralise this difference on its own — this test would pass by
  // accident (proving nothing) if it varied only the filename/line/col,
  // since those already collapse to `<url>`/`<n>` before hashing either way.
  const bodyA = faroFixture("exception-code-frame.json");
  bodyA.exceptions[0].value = "Cannot read properties of undefined (reading 'x')";
  bodyA.exceptions[0].stacktrace = {
    frames: [{ filename: "https://demos.handsontable.com/assets/chunk-aaa111.js", function: "t", lineno: 10, colno: 5 }],
  };
  delete bodyA.exceptions[0].fingerprint;
  delete bodyA.exceptions[0].context["hot.fingerprint"];

  const bodyB = faroFixture("exception-code-frame.json");
  bodyB.exceptions[0].value = "Cannot read properties of undefined (reading 'x')";
  bodyB.exceptions[0].stacktrace = {
    frames: [
      { filename: "https://demos.handsontable.com/assets/chunk-bbb222.js", function: "n", lineno: 42, colno: 9 },
      { filename: "https://demos.handsontable.com/assets/chunk-bbb222.js", function: "dispatchHmrUpdate", lineno: 7, colno: 1 },
    ],
  };
  delete bodyB.exceptions[0].fingerprint;
  delete bodyB.exceptions[0].context["hot.fingerprint"];

  const [itemA] = await processFaroBody(bodyA, ENV, SERVICE, Date.now());
  const [itemB] = await processFaroBody(bodyB, ENV, SERVICE, Date.now());
  assert.ok(itemA.ingestItem && itemB.ingestItem);
  assert.equal(
    itemA.ingestItem.fingerprint,
    itemB.ingestItem.fingerprint,
    "same type:value message, two different stacks — must fingerprint the same after the fix",
  );
  // The stored record body must still carry the real stack frames — this
  // fix changes what is HASHED, never what is STORED (§C.3 symbolication
  // parses frames back out of the stored body).
  assert.match(itemA.ingestItem.record.body, /chunk-aaa111\.js/);
  assert.match(itemB.ingestItem.record.body, /chunk-bbb222\.js/);
  assert.match(itemB.ingestItem.record.body, /dispatchHmrUpdate/);
});

test("Faro exception (uncaught, no client fingerprint): a genuinely different message still fingerprints differently, same stack", async () => {
  const shared = faroFixture("exception-code-frame.json").exceptions[0].stacktrace;

  const bodyA = faroFixture("exception-code-frame.json");
  bodyA.exceptions[0].value = "Cannot read properties of undefined (reading 'x')";
  bodyA.exceptions[0].stacktrace = shared;
  delete bodyA.exceptions[0].fingerprint;
  delete bodyA.exceptions[0].context["hot.fingerprint"];

  const bodyB = faroFixture("exception-code-frame.json");
  bodyB.exceptions[0].value = "Maximum call stack size exceeded";
  bodyB.exceptions[0].stacktrace = shared;
  delete bodyB.exceptions[0].fingerprint;
  delete bodyB.exceptions[0].context["hot.fingerprint"];

  const [itemA] = await processFaroBody(bodyA, ENV, SERVICE, Date.now());
  const [itemB] = await processFaroBody(bodyB, ENV, SERVICE, Date.now());
  assert.notEqual(itemA.ingestItem.fingerprint, itemB.ingestItem.fingerprint);
});

// ---- fix round (finding A-M3): the assembled record gets a second scrub pass --

test("Faro: a query string embedded in an allowlisted attribute value (context, a diagnostic tag) is stripped, not just redactPreviewHosts'd", async () => {
  const body = faroFixture("log.json");
  body.logs[0].context = {
    ...body.logs[0].context,
    context: "versions-fetch?token=SECRET123",
  };
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem);
  const text = JSON.stringify(item.ingestItem.record);
  assert.doesNotMatch(text, /SECRET123/, "a query string inside an attribute value must be stripped, not stored verbatim");
});

test("hash: identical Faro item redelivered seconds apart hashes identically", async () => {
  const body = faroFixture("log.json");
  const [a] = await processFaroBody(body, ENV, SERVICE, Date.now());
  const [b] = await processFaroBody(body, ENV, SERVICE, Date.now() + 4000);
  assert.equal(a.ingestItem.hash, b.ingestItem.hash);
});

test("hash: a Faro item with no timestamp at all still hashes identically across redelivery", async () => {
  const body = faroFixture("log.json");
  delete body.logs[0].timestamp;
  const [a] = await processFaroBody(body, ENV, SERVICE, Date.now());
  const [b] = await processFaroBody(body, ENV, SERVICE, Date.now() + 9000);
  assert.equal(a.ingestItem.hash, b.ingestItem.hash, "a zero-timestamp record's clamp fallback must not leak into the hash");
});

// ---- OTLP: JSON vs protobuf agree -----------------------------------------------

test("OTLP JSON and protobuf decoders agree on the same fixture content", () => {
  const fromJson = decodeOtlpJson(otlpJsonFixture("basic.json"));
  const fromProtobuf = decodeOtlpProtobuf(otlpProtobufFixture("basic.bin"));
  assert.equal(fromJson[0].resourceAttributes["service.name"], fromProtobuf[0].resourceAttributes["service.name"]);
  assert.equal(fromJson[0].logRecords[0].body.startsWith("api.request"), true);
  assert.equal(fromProtobuf[0].logRecords[0].body.startsWith("api.request"), true);
  assert.equal(fromJson[0].logRecords[0].timeUnixNano, fromProtobuf[0].logRecords[0].timeUnixNano);
});

test("OTLP: a zero time_unix_nano gets the received_at fallback (exit criterion 3)", async () => {
  const receivedAtMs = Date.now();
  const result = await processOtlpBody(
    new TextEncoder().encode(otlpJsonFixture("zero-timestamp.json")),
    "application/json",
    ENV,
    receivedAtMs,
  );
  assert.equal(result.items.length, 1);
  const nano = BigInt(result.items[0].record.timeUnixNano);
  const expected = BigInt(receivedAtMs) * 1_000_000n;
  assert.equal(nano, expected);
});

test("OTLP: a real time_unix_nano is never clamped, even far from receivedAtMs", async () => {
  const receivedAtMs = Date.now();
  const result = await processOtlpBody(
    new TextEncoder().encode(otlpJsonFixture("basic.json")),
    "application/json",
    ENV,
    receivedAtMs,
  );
  // basic.json's time_unix_nano is a fixed 2025-01-01 timestamp, far outside
  // any 5-minute clamp window around "now" — it must survive unchanged.
  assert.equal(result.items[0].record.timeUnixNano, "1735689600000000000");
});

test("hash: the same OTLP export body delivered twice, seconds apart, hashes identically", async () => {
  const bytes = new TextEncoder().encode(otlpJsonFixture("zero-timestamp.json"));
  const first = await processOtlpBody(bytes, "application/json", ENV, Date.now());
  const second = await processOtlpBody(bytes, "application/json", ENV, Date.now() + 5000);
  assert.equal(first.items[0].hash, second.items[0].hash);
});

test("OTLP: forbidden attributes and body text are scrubbed over the whole record", async () => {
  const result = await processOtlpBody(
    new TextEncoder().encode(otlpJsonFixture("forbidden-attrs.json")),
    "application/json",
    ENV,
    Date.now(),
  );
  assert.equal(result.items.length, 1);
  const text = allText(result.items[0].record);
  assert.doesNotMatch(text, /url\.full/i);
  assert.doesNotMatch(text, /geo\./i);
  assert.doesNotMatch(text, /asn\./i);
  assert.doesNotMatch(text, /token=secret123/, "no query string survives, including inside body text");
  assert.doesNotMatch(text, /Mozilla\//, "no user-agent string survives");
  assert.doesNotMatch(text, /8787-abc123-tok3n/, "no preview hostname survives");
});

test("OTLP: a real Cloudflare invocation-log export — cf.ray survives the cloudflare.ray_id remap, service.version defaults to unknown, forbidden fields are dropped", async () => {
  // pipeline/fixtures/otlp/json/cloudflare-invocation-log.json is captured
  // real output (scrubbed) from this task's sandbox-probe re-run against a
  // throwaway Worker with `observability.logs.invocation_logs: true` — see
  // the task Outcome. Two real findings this fixture pins:
  //   - the ray id arrives as `cloudflare.ray_id`, not the contract's
  //     `cf.ray` (otlp.ts#CLOUDFLARE_KEY_REMAP);
  //   - Cloudflare's own automatic export never sends `service.version` at
  //     all (points.ts#withResourceAttrDefaults now defaults it).
  const result = await processOtlpBody(
    new TextEncoder().encode(otlpJsonFixture("cloudflare-invocation-log.json")),
    "application/json",
    ENV,
    Date.now(),
  );
  assert.equal(result.items.length, 1);
  const record = result.items[0].record;

  assert.equal(record.attributes?.["cf.ray"], "0000000000000000", "cloudflare.ray_id must remap to cf.ray");
  assert.equal(record.resourceAttributes["service.version"], "unknown");

  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /url\.full/i);
  assert.doesNotMatch(text, /user_agent/i);
  assert.doesNotMatch(text, /Mozilla\//, "no user-agent string survives");
  assert.doesNotMatch(text, /geo\./i);
  assert.doesNotMatch(text, /cloudflare\.asn/i);
  assert.doesNotMatch(text, /cloudflare\.ray_id/, "the raw Cloudflare key name must not survive alongside its remap");
});

// ---- T03B (d): a structured console.log(JSON.stringify(...)) line ---------

test("OTLP: a Worker's own console.log(JSON.stringify(lines.ts shape)) line arrives as BODY TEXT, not attributes — the normaliser parses it and gives Loki cf.ray/session.id/hot.demo_id as structured metadata", async () => {
  // pipeline/fixtures/otlp/json/console-log-line.json is shaped from a
  // REAL captured Cloudflare OTLP export of workers/api/src/telemetry/
  // lines.ts#logRequestLine's own console.log call (this task's sandbox
  // probe, see the Outcome for the raw capture) — scrubbed of real ray/
  // session/demo ids the same way cloudflare-invocation-log.json is. The
  // ground truth it pins: `body.stringValue` IS the raw JSON string;
  // `attributes` on that record carries only Cloudflare's own generic
  // wrapper fields (`name: "log"`, `cloudflare.invocation.sequence.number`)
  // — none of the app's own fields. Without otlp.ts#tryParseJsonBodyAttrs,
  // cf.ray/session.id/hot.demo_id would never reach Loki as structured
  // metadata at all, violating ADR §E.4's operational-log rule.
  const result = await processOtlpBody(
    new TextEncoder().encode(otlpJsonFixture("console-log-line.json")),
    "application/json",
    ENV,
    Date.now(),
  );
  assert.equal(result.items.length, 1);
  const record = result.items[0].record;

  assert.equal(record.attributes?.["cf.ray"], "8a1b2c3d4e5f6789");
  assert.equal(record.attributes?.["session.id"], "page-load-id-123");
  assert.equal(record.attributes?.["hot.demo_id"], "r-react-18-0-0");
  // Not one of the contract's own key names (§3/§6) — must not survive
  // anywhere, the same "no second allowlist" rule a real OTLP attribute
  // already follows.
  assert.equal(record.attributes?.["route_class"], undefined);
  assert.equal(record.attributes?.["log.kind"], undefined);
  assert.equal(record.resourceAttributes["log.kind"], undefined);
  // The body itself is untouched (still the raw JSON text) — this is an
  // ADDITIVE parse, never a body rewrite.
  assert.match(record.body, /"log\.kind":"api\.request"/);
});

test("OTLP: a plain (non-JSON) console.log body is left exactly as before — no attempted parse, no change in behaviour", async () => {
  const result = await processOtlpBody(
    new TextEncoder().encode(otlpJsonFixture("cloudflare-invocation-log.json")),
    "application/json",
    ENV,
    Date.now(),
  );
  // This fixture's body is a plain URL string, not JSON — must decode
  // exactly as the existing test above already asserts (cf.ray only via
  // the cloudflare.ray_id REMAP, not via any body-JSON parse).
  assert.equal(result.items.length, 1);
  assert.doesNotMatch(result.items[0].record.body, /^\{/, "body must stay untouched plain text, not JSON");
});

test("B cross-note fix: authored console output that happens to be JSON (e.g. Tier-2 SSR container stdout) is NOT parsed into attributes — only this Worker's own trusted log.kind lines are", async () => {
  // ADR-0041's own platform facts say Tier-2 container stdout lands in the
  // API worker's logs, the same Cloudflare export `otlp.ts` parses here.
  // Authored SSR code that happens to `console.log(JSON.stringify({...}))`
  // must not have its own keys hoisted into attributes/resourceAttributes
  // the way a real `lines.ts` line does — contract §3 forbids "authored
  // code … console output" outright.
  const body = JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "handsontable-demos-api" } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1735689600000000000",
                body: {
                  stringValue: JSON.stringify({
                    // No "log.kind" at all — an authored line, not this
                    // Worker's own trusted shape. Tries to inject a
                    // resource-attribute-looking key AND a structured
                    // metadata key, neither of which must survive.
                    "hot.demo_id": "attacker-demo",
                    "session.id": "attacker-session",
                    "service.name": "demos-api",
                    userEmail: "person@example.com",
                  }),
                },
                attributes: [],
              },
            ],
          },
        ],
      },
    ],
  });
  const result = await processOtlpBody(new TextEncoder().encode(body), "application/json", ENV, Date.now());
  assert.equal(result.items.length, 1);
  const record = result.items[0].record;
  assert.equal(record.attributes?.["hot.demo_id"], undefined, "an authored JSON key must not become structured metadata");
  assert.equal(record.attributes?.["session.id"], undefined);
  assert.equal(record.attributes?.userEmail, undefined);
  // The body text itself is left untouched (still the raw authored JSON) —
  // this fix only stops the KEY-hoisting, never rewrites the body.
  assert.match(record.body, /attacker-demo/);
});

// ---- controller handoff (finding C-I2, read half): the API-side fingerprint feed --
//
// Spec (ADR §M, "controller handoff / not fixed by the final review"): read
// bodyJsonAttrs["hot.fingerprint"] and feed it into the fp: registry ONLY
// when the real resource service.name === "demos-api", log.kind === "error",
// the value matches ^[a-z0-9-]+:[0-9a-f]{16}$, and the record is not Tier-2
// container stdout. NOTE: real Cloudflare exports carry service.name =
// "handsontable-demos-api" (finding M2, unowned/unfixed) — these tests set
// service.name to the contract's own "demos-api" directly to exercise the
// gate logic itself; until M2 lands, this feed is correctly gated but does
// not fire against real production traffic. Recorded in the report.

function apiErrorLineOtlpBody(overrides = {}) {
  const bodyObj = {
    "log.kind": "error",
    context: "chat-answer",
    name: "Error",
    message: "boom",
    "service.version": "abc123",
    "hot.fingerprint": "chat-answer:0123456789abcdef",
    ...overrides.bodyExtra,
  };
  return JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: overrides.serviceName ?? "demos-api" } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1735689600000000000",
                body: { stringValue: JSON.stringify(bodyObj) },
                attributes: [],
              },
            ],
          },
        ],
      },
    ],
  });
}

test("C-I2 read half: all four conditions met — the API's own hot.fingerprint feeds the exact first-seen registry", async () => {
  const result = await processOtlpBody(
    new TextEncoder().encode(apiErrorLineOtlpBody()),
    "application/json",
    ENV,
    Date.now(),
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].fingerprint, "chat-answer:0123456789abcdef");
});

test("C-I2 condition 1: a body-JSON service.name claiming demos-api does NOT feed the registry — only the REAL resource attribute counts", async () => {
  const result = await processOtlpBody(
    new TextEncoder().encode(apiErrorLineOtlpBody({ serviceName: "some-other-service", bodyExtra: { "service.name": "demos-api" } })),
    "application/json",
    ENV,
    Date.now(),
  );
  assert.equal(result.items[0].fingerprint, undefined, "a body-claimed service.name must never satisfy this gate");
});

test("C-I2 condition 2: log.kind other than 'error' (e.g. api.request) does not feed the registry", async () => {
  const result = await processOtlpBody(
    new TextEncoder().encode(apiErrorLineOtlpBody({ bodyExtra: { "log.kind": "api.request" } })),
    "application/json",
    ENV,
    Date.now(),
  );
  assert.equal(result.items[0].fingerprint, undefined);
});

test("C-I2 condition 3: a hot.fingerprint value outside the contract's <context>:<16 hex> shape does not feed the registry", async () => {
  const result = await processOtlpBody(
    new TextEncoder().encode(apiErrorLineOtlpBody({ bodyExtra: { "hot.fingerprint": "<!channel> pwned" } })),
    "application/json",
    ENV,
    Date.now(),
  );
  assert.equal(result.items[0].fingerprint, undefined, "an injection-shaped value must never reach the registry");
});

// ---- fix round (finding A-M2, second wave): C-I2 against a REAL production
// export -----------------------------------------------------------------
//
// Every C-I2 test above sets `service.name: "demos-api"` directly (see this
// file's own note above `apiErrorLineOtlpBody`) — that exercises the gate
// LOGIC but never the actual value a real Cloudflare export sends
// (`handsontable-demos-api`, confirmed by the captured fixtures this file
// already uses elsewhere). This test is the one that proves the wiring
// fires against what production actually sends: the real script name, AND
// a real multi-segment `reportDiagnostic` context (`npm-registry:*`, the
// exact call sites N1's own test pins) — so it fails if EITHER A-M2's
// remap OR N1's validator fix is reverted.
test("A-M2 + N1 together: a REAL production export (service.name=handsontable-demos-api) with a real reportDiagnostic context feeds the exact first-seen registry", async () => {
  const fp = fingerprint("npm-registry:version-exists", "upstream npm registry request failed");
  const result = await processOtlpBody(
    new TextEncoder().encode(
      apiErrorLineOtlpBody({
        serviceName: "handsontable-demos-api",
        bodyExtra: { "hot.fingerprint": fp, context: "npm-registry:version-exists" },
      }),
    ),
    "application/json",
    ENV,
    Date.now(),
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].fingerprint, fp, "the real script name must be normalised (A-M2) and the multi-segment context accepted (N1)");
  assert.equal(result.items[0].record.resourceAttributes["service.name"], "demos-api", "the stored record's own label must also be the normalised contract name");
});

test("C-I2 condition 4: authored/Tier-2-shaped JSON (no trusted log.kind at all) never even surfaces a hot.fingerprint to check — the B cross-note gate already empties bodyJsonAttrs", async () => {
  const body = JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "demos-api" } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1735689600000000000",
                body: {
                  stringValue: JSON.stringify({
                    // No "log.kind" — an authored/container-stdout shape,
                    // trying to forge a fingerprint anyway.
                    "hot.fingerprint": "chat-answer:0123456789abcdef",
                  }),
                },
                attributes: [],
              },
            ],
          },
        ],
      },
    ],
  });
  const result = await processOtlpBody(new TextEncoder().encode(body), "application/json", ENV, Date.now());
  assert.equal(result.items[0].fingerprint, undefined);
});

test("fix round I2: a body-JSON key cannot spoof a real resource attribute (service.name, environment, hot.outcome) — the real resource value always wins", async () => {
  // pipeline/fixtures/otlp/json/console-log-line-spoof-attempt.json: a
  // real resource carries service.name=handsontable-demos-api,
  // deployment.environment.name=production; the body's OWN JSON tries to
  // set service.name=spoof, deployment.environment.name=spoof-env, and
  // hot.outcome=spoof-outcome (a metric-scoped attr, included to prove
  // the guard isn't limited to just the two most obvious keys). None of
  // these must survive — tryParseJsonBodyAttrs strips every
  // RESOURCE_ATTRS key from its own output, AND the merge at the call
  // site gives body-JSON attrs the lowest priority, so even if a future
  // RESOURCE_ATTRS addition were missed by the strip, a real resource/
  // OTLP attribute still could not be overridden by body content.
  //
  // Fix round (finding A-M2, second wave): the REAL resource's
  // `service.name` is now normalised from Cloudflare's real script name
  // (`handsontable-demos-api`) to the contract's own `demos-api` — see
  // `remapCloudflareServiceName` — so this test's own "the real value
  // wins" assertion checks the POST-normalisation value, not the raw
  // export's, which is what a real Loki label/AE blob1 now stores.
  const result = await processOtlpBody(
    new TextEncoder().encode(otlpJsonFixture("console-log-line-spoof-attempt.json")),
    "application/json",
    ENV,
    Date.now(),
  );
  assert.equal(result.items.length, 1);
  const record = result.items[0].record;

  assert.equal(record.resourceAttributes["service.name"], "demos-api", "the REAL service.name must survive (normalised, A-M2), never the body's spoofed value");
  assert.equal(record.resourceAttributes["deployment.environment.name"], "production", "the REAL environment must survive, never the body's spoofed value");
  assert.notEqual(record.resourceAttributes["hot.outcome"], "spoof-outcome", "hot.outcome must never be set from body content at all");
  // cf.ray (NOT a RESOURCE_ATTRS key — structured metadata) is legitimate
  // body-JSON content and must still come through, proving the fix is a
  // targeted strip, not a wholesale disabling of F(d)'s own feature.
  assert.equal(record.attributes?.["cf.ray"], "8a1b2c3d4e5f6789");
});

test("every stored record carries the contract's eight resource attributes", async () => {
  const result = await processOtlpBody(
    new TextEncoder().encode(otlpJsonFixture("basic.json")),
    "application/json",
    ENV,
    Date.now(),
  );
  const attrs = result.items[0].record.resourceAttributes;
  for (const key of [
    "service.name",
    "service.version",
    "deployment.environment.name",
    "hot.surface",
    "hot.tier",
    "hot.framework",
    "hot.ht_major",
    "hot.outcome",
  ]) {
    assert.ok(key in attrs, `missing resource attribute ${key}`);
  }
});

test("records over 256 KB are dropped, not stored", async () => {
  const huge = "x".repeat(300_000);
  const body = JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "demos-api" } }] },
        scopeLogs: [{ logRecords: [{ timeUnixNano: "1735689600000000000", body: { stringValue: huge } }] }],
      },
    ],
  });
  const result = await processOtlpBody(new TextEncoder().encode(body), "application/json", ENV, Date.now());
  assert.equal(result.items.length, 0);
  assert.equal(result.droppedOversize, 1);
});

test("Faro: a record over 256 KB is dropped, not stored (I2 — the Faro path lacked this check)", async () => {
  const body = faroFixture("log.json");
  body.logs[0].message = "x".repeat(300_000);
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.equal(item.ingestItem, undefined, "an oversize Faro record must not be stored");
  assert.equal(item.oversize, true);
  assert.equal(item.invalid, undefined, "oversize is distinct from invalid (I3: different o11y.ingest reason)");
});

// ---- A-M7: deploy/Sentry hashes must not collapse genuinely different events ------
//
// Both processors used to hash with a fixed `rawEventTime: ""`. Two
// genuinely different events whose derived body text happens to be
// byte-identical (a redeploy of the exact same `{service,sha,cf_version_id}`;
// a Sentry issue going regression -> resolved -> regression in one day, so
// the second "regression" body matches the first) then hashed identically
// and deduped inside the 24h dedupe window even though they are real,
// distinct events. Fails without the fix: reverting `rawEventTime` to `""`
// in either processor makes the two hashes below equal.

test("A-M7: two deploy events with identical service/sha/cf_version_id at receive times in different minute buckets hash differently", async () => {
  const payload = { service: "demos-authoring", sha: "abc123", cf_version_id: "v1" };
  const first = await processDeployPayload(payload, ENV, 0);
  const second = await processDeployPayload(payload, ENV, 5 * 60_000);
  assert.notEqual(first.hash, second.hash, "two distinct-minute deploys of the same payload must not dedupe");
});

test("A-M7: a redelivered deploy event within the same minute still hashes identically (idempotent retry)", async () => {
  const payload = { service: "demos-authoring", sha: "abc123", cf_version_id: "v1" };
  const first = await processDeployPayload(payload, ENV, 1_000);
  const second = await processDeployPayload(payload, ENV, 1_500);
  assert.equal(first.hash, second.hash, "a retry inside the same minute bucket must still dedupe");
});

// B-I1: an empty cf_version_id (master.yml's `version_id=$(grep ...) || true`
// can produce one on a wrangler wording change) must never be rejected by
// this ingest path — the deploy already shipped — but must be visibly
// marked, both for a Workers-Logs/Loki search and for a queryable Grafana
// attribute. Fails without the fix: reverting the `versionIdMissing` branch
// in processDeployPayload makes `attributes` come back `{}` regardless of
// cf_version_id.
test("B-I1: an empty cf_version_id is accepted (never dropped) and marked in the body for a Loki/Grafana query", async () => {
  const payload = { service: "demos-authoring", sha: "abc123", cf_version_id: "" };
  const item = await processDeployPayload(payload, ENV, 0);
  const body = JSON.parse(item.record.body);
  assert.equal(body.cf_version_id, "", "the empty value is still recorded verbatim in the body, not silently dropped");
  assert.equal(body.cf_version_id_missing, true, "must mark the record so it is findable without grepping for an empty string");
});

test("B-I1: a normal, non-empty cf_version_id is NOT marked", async () => {
  const payload = { service: "demos-authoring", sha: "abc123", cf_version_id: "01998a3e-1234-abcd" };
  const item = await processDeployPayload(payload, ENV, 0);
  const body = JSON.parse(item.record.body);
  assert.equal(body.cf_version_id_missing, undefined);
});

test("A-M7: a Sentry issue regressing twice in one day (identical action/title/release) hashes differently per Sentry-Hook-Timestamp", async () => {
  const payload = {
    action: "regression",
    data: { issue: { id: "1", title: "TypeError: boom", lastRelease: { version: "rel-1" } } },
  };
  const morning = await processSentryPayload(payload, ENV, Date.now(), "1700000000");
  const afternoon = await processSentryPayload(payload, ENV, Date.now(), "1700020000");
  assert.notEqual(
    morning.hash,
    afternoon.hash,
    "two regressions of the same issue on the same day must not dedupe away the second one",
  );
});

test("A-M7: a redelivered Sentry hook with the same Sentry-Hook-Timestamp still hashes identically", async () => {
  const payload = {
    action: "regression",
    data: { issue: { id: "1", title: "TypeError: boom", lastRelease: { version: "rel-1" } } },
  };
  const first = await processSentryPayload(payload, ENV, Date.now(), "1700000000");
  const second = await processSentryPayload(payload, ENV, Date.now() + 500, "1700000000");
  assert.equal(first.hash, second.hash, "a retry with the same delivery timestamp must still dedupe");
});
