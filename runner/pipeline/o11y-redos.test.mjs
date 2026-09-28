// The ingest scrub/normalise/fingerprint path must not carry a quadratic
// ("ReDoS") regex reachable from an anonymous `POST /telemetry/collect`
// request: an unclosed-delimiter string makes a backtracking engine cost
// O(n²). Measured on an unfixed pattern: `redactEmailInText` alone cost
// 4.3s at 80k characters, projected ~36s at the 256 KB record cap, well
// past the Worker's 120s `cpu_ms` budget. These tests assert a wall-clock
// budget on adversarial input for each pattern, plus the full
// `processFaroBody` pipeline and a real `worker.fetch` gzip-body call.
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { redactEmailInText, redactUserAgentInText, redactIpInText, scrubBodyText } = await import(
  "../workers/o11y/src/normalise/text-scrub.ts"
);
const { processFaroBody } = await import("../workers/o11y/src/normalise/faro.ts");
const { redactPreviewHosts, normalizeMonitorMessage } = await import("../packages/runtime/dist/monitor.js");
const { fingerprint, stripCodeFrame, deviceOf } = await import("../packages/runtime/dist/telemetry/index.js");
const { default: worker } = await import("../workers/o11y/src/index.ts");
const { InboxWriter } = await import("../workers/o11y/src/inbox/writer.ts");
const { makeEnv, ctx } = await import("./fixtures/o11y-harness.mjs");
const { symbolicateResourceLogs } = await import("../workers/o11y/src/drain/symbolicate.ts");

const ENV = { O11Y_ENV: "production" };
const SERVICE = { name: "demos-authoring", version: "deadbeef1234", environment: "production" };

/** Runs `fn`, asserting it completes in under `budgetMs` wall-clock —
 *  the ONLY meaningful assertion for a ReDoS regression: a correctness
 *  assertion alone would still pass on the unfixed code (eventually), which
 *  is exactly the bug. */
async function assertUnderBudget(label, budgetMs, fn) {
  const startedAt = performance.now();
  const result = await fn();
  const elapsedMs = performance.now() - startedAt;
  assert.ok(
    elapsedMs < budgetMs,
    `${label}: expected under ${budgetMs}ms, took ${elapsedMs.toFixed(1)}ms — a quadratic regex regression`,
  );
  return result;
}

// ---- individual pattern budgets (a shared budget, comfortably under both bars)

// Not a tight 100ms: under real load, fixed (linear) code alone measured
// up to 502ms with no regression. 3000ms stays well above that and still
// well under a quadratic pattern's adversarial-input time.
const INDIVIDUAL_PATTERN_BUDGET_MS = 3000;

// Sized at 150k, not 100k: at 100k the pre-fix EMAIL_PATTERN only cost
// ~6-10s on this machine — too close to 3x the shared budget once other
// `pnpm test` workers are also loading the CPU. At 150k it measured a
// steady ~14.2-14.9s pre-fix (still <30ms fixed), comfortably ~5x the
// budget.
test(`redactEmailInText: 150k 'a' characters with no '@' completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
  const input = "a".repeat(150_000);
  await assertUnderBudget("redactEmailInText", INDIVIDUAL_PATTERN_BUDGET_MS, () => redactEmailInText(input));
});

// 65k reps (130k chars): pre-fix measured ~13.9-14.5s, fixed <30ms.
test(`redactEmailInText: 65k 'a.'-repeats (no '@') completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
  const input = "a.".repeat(65_000);
  await assertUnderBudget("redactEmailInText (a.-repeats)", INDIVIDUAL_PATTERN_BUDGET_MS, () => redactEmailInText(input));
});

// 50k reps: pre-fix measured a steady ~12.5-12.6s (20k reps, the previous
// size, only cost ~1.9-4.8s pre-fix — too close to, and on one trial under,
// 3x the shared budget); fixed code measured <60ms.
test(`redactUserAgentInText: 'Mozilla/1 (' repeated with no closing paren completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
  const input = "Mozilla/1 (".repeat(50_000);
  await assertUnderBudget("redactUserAgentInText", INDIVIDUAL_PATTERN_BUDGET_MS, () => redactUserAgentInText(input));
});

// 65k reps (130k chars): pre-fix measured ~13.7-14.0s, fixed <30ms.
test(`redactPreviewHosts: 65k 'a-'-repeats with no '.demos.handsontable.com' suffix completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
  const input = "a-".repeat(65_000);
  await assertUnderBudget("redactPreviewHosts", INDIVIDUAL_PATTERN_BUDGET_MS, () => redactPreviewHosts(input));
});

// `redactIpInText` (IPv4 + IPv6) must be bounded: every quantifier is a
// small fixed alternation or a `{1,4}`/`{1,7}` cap, so there is no
// unbounded run to backtrack over. These adversarial inputs are shaped to
// stress an IP-pattern implementation with an unbounded quantifier (a run
// of digits/dots, or hex/colons, with no valid IP ever completing) —
// measured directly against the fixed code at 150k/260k chars: 1-3ms,
// nowhere near this budget. This is a regression guard: reverting
// `IPV4_PATTERN`/`IPV6_PATTERN` to an unbounded shape (e.g. `[\d.]+` for
// the octet run) is what this test would catch.
test(`redactIpInText: 150k '1' characters (no valid IPv4/IPv6 ever completes) completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
  const input = "1".repeat(150_000);
  await assertUnderBudget("redactIpInText (digits)", INDIVIDUAL_PATTERN_BUDGET_MS, () => redactIpInText(input));
});

test(`redactIpInText: 65k '1.'-repeats (no valid IPv4 ever completes) completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
  const input = "1.".repeat(65_000);
  await assertUnderBudget("redactIpInText (IPv4-shaped)", INDIVIDUAL_PATTERN_BUDGET_MS, () => redactIpInText(input));
});

test(`redactIpInText: 65k 'a:'-repeats (no valid IPv6 ever completes) completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
  const input = "a:".repeat(65_000);
  await assertUnderBudget("redactIpInText (IPv6-shaped)", INDIVIDUAL_PATTERN_BUDGET_MS, () => redactIpInText(input));
});

// Unchanged at 200k: `normalizeMonitorMessage` bounds its own input to 4096
// chars before any regex pass runs (NORMALIZE_MESSAGE_INPUT_MAX), so the
// fixed code's cost here is a few ms regardless of the shared budget. The
// pre-fix function (no such bound) measured ~52s on this exact 200k input —
// nowhere near 3x the budget being a concern.
test(`normalizeMonitorMessage: 200k identifier-shaped characters with no ' is not defined' suffix completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
  const input = "a".repeat(200_000);
  await assertUnderBudget("normalizeMonitorMessage", INDIVIDUAL_PATTERN_BUDGET_MS, () => normalizeMonitorMessage(input));
});

// Unchanged at 200k, same reasoning as above (fingerprint calls
// normalizeMonitorMessage): pre-fix measured ~50.5s on this input.
test(`fingerprint (the real monitor.ts shape, via normalizeMonitorMessage + stripCodeFrame): 200k chars completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
  const input = "a".repeat(200_000);
  await assertUnderBudget("fingerprint", INDIVIDUAL_PATTERN_BUDGET_MS, () => fingerprint("demo-runtime", input));
});

// A run of spaces or tabs is the shape that stresses `stripCodeFrame`'s gutter
// pattern: `a`-runs fail at the first character, so the test above never
// reaches it. 250k is about one field's worth under `SCRUB_TEXT_MAX_CHARS`.
for (const [name, ch] of [["spaces", " "], ["tabs", "\t"]]) {
  const run = ch.repeat(250_000) + "x";

  test(`stripCodeFrame: a line of 250k ${name} completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
    const out = await assertUnderBudget(`stripCodeFrame (${name})`, INDIVIDUAL_PATTERN_BUDGET_MS, () => stripCodeFrame(run));
    assert.equal(out, "x");
  });

  test(`fingerprint: a message of 250k ${name} completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
    await assertUnderBudget(`fingerprint (${name})`, INDIVIDUAL_PATTERN_BUDGET_MS, () => fingerprint("demo-runtime", run));
  });
}

test("stripCodeFrame: a real Babel code frame is still stripped", () => {
  const message = [
    "SyntaxError: /src/index.js: Unexpected token (12:10)",
    "  10 | const a = 1;",
    "  11 | const b = 2;",
    "> 12 | const x = ;",
    "     |           ^",
    "  13 | export default x;",
  ].join("\n");
  assert.equal(stripCodeFrame(message), "SyntaxError: /src/index.js: Unexpected token (12:10)");
});

// `deviceOf` classifies the client-sent Faro `meta.browser.userAgent`.
test(`deviceOf: 280k characters of repeated 'android' completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
  const ua = "android".repeat(40_000);
  const device = await assertUnderBudget("deviceOf", INDIVIDUAL_PATTERN_BUDGET_MS, () => deviceOf(ua));
  assert.equal(device, "desktop");
  assert.equal(deviceOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36"), "mobile");
});

// ---- the combined server-side pass (text-scrub.ts's own extra scrub) -------

// Sized at 150k to match redactEmailInText's own bump above: scrubBodyText's
// dominant cost on this all-'a' input is its chained email pass, which
// measured ~12.8s at 150k on a quadratic implementation, well over 3x the
// shared budget; the linear chain (truncate + URL-strip + UA + email + IP
// passes) measures comfortably under budget.
test(`scrubBodyText: 150k 'a' characters (email + UA + URL + IP passes chained) completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
  const input = "a".repeat(150_000);
  await assertUnderBudget("scrubBodyText", INDIVIDUAL_PATTERN_BUDGET_MS, () => scrubBodyText(input));
});

// ---- the full normalise pipeline --------------------------------------------

test("processFaroBody: a Faro log item with an 80k-character adversarial message completes well under budget", async () => {
  const body = {
    meta: { app: { name: "demos-authoring", version: "deadbeef1234" } },
    logs: [
      {
        message: "a".repeat(80_000),
        timestamp: new Date().toISOString(),
        context: { "hot.surface": "authoring" },
      },
    ],
  };
  const [item] = await assertUnderBudget("processFaroBody", 500, () => processFaroBody(body, ENV, SERVICE, Date.now()));
  // Sanity: the item still gets processed (dropped only for being oversize
  // if it ever were, which 80k chars is not) — a budget test that silently
  // measured a thrown/short-circuited call would prove nothing.
  assert.equal(item.invalid, undefined);
});

test(`processFaroBody: a Faro meta userAgent of 280k repeated 'android' completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
  const body = {
    meta: { app: { name: "demos-authoring", version: "deadbeef1234" }, browser: { userAgent: "android".repeat(40_000) } },
    logs: [{ message: "hello", timestamp: new Date().toISOString(), context: {} }],
  };
  const [item] = await assertUnderBudget("processFaroBody (userAgent)", INDIVIDUAL_PATTERN_BUDGET_MS, () =>
    processFaroBody(body, ENV, SERVICE, Date.now()),
  );
  assert.equal(item.invalid, undefined);
});

// ---- end to end: the real route, a real gzip body, the exact reproduction --
// Reproduced over the real `worker.fetch` with a ~1KB gzip upload that
// expands to a ~1MB adversarial JSON body.

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test("POST /telemetry/collect: a gzip body carrying an adversarial 160k-character message completes well under budget, not the 120s cpu_ms cap", async () => {
  const { env } = makeEnv(InboxWriter);
  const wireBody = JSON.stringify({
    meta: { app: { name: "demos-authoring", version: "deadbeef1234", environment: "production" } },
    logs: [
      {
        message: "a".repeat(160_000),
        timestamp: new Date().toISOString(),
        context: {},
      },
    ],
  });
  const gz = await gzip(wireBody);

  const req = new Request("https://demos.handsontable.com/telemetry/collect", {
    method: "POST",
    headers: {
      Origin: "https://demos.handsontable.com",
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: gz,
  });

  const res = await assertUnderBudget("worker.fetch /telemetry/collect (gzip adversarial body)", 2000, () =>
    worker.fetch(req, env, ctx),
  );
  await ctx.drain();
  assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);
});

// About 1 KB gzipped; each untyped exception value is scrubbed twice and
// fingerprinted once, so every pass over the whitespace run must be linear.
// A tab is two bytes of JSON, so the tab body carries two shorter values to
// stay under `COLLECT_MAX_BYTES`.
for (const [name, ch, count, length] of [["spaces", " ", 3, 250_000], ["tabs", "\t", 2, 240_000]]) {
  test(`POST /telemetry/collect: a gzip exceptions body of ${count} x ${length / 1000}k-${name} values completes well under ${INDIVIDUAL_PATTERN_BUDGET_MS}ms`, async () => {
    const { env } = makeEnv(InboxWriter);
    const exception = {
      value: ch.repeat(length) + "x",
      stacktrace: { frames: [] },
      timestamp: new Date().toISOString(),
      context: {},
    };
    const wireBody = JSON.stringify({
      meta: { app: { name: "demos-authoring", version: "deadbeef1234", environment: "production" } },
      exceptions: Array.from({ length: count }, () => exception),
    });
    const gz = await gzip(wireBody);
    assert.ok(gz.byteLength < 4096, `the attack body is tiny on the wire (${gz.byteLength} bytes gzipped)`);

    const req = new Request("https://demos.handsontable.com/telemetry/collect", {
      method: "POST",
      headers: {
        Origin: "https://demos.handsontable.com",
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: gz,
    });

    const res = await assertUnderBudget(`worker.fetch /telemetry/collect (gzip ${name} exceptions)`, INDIVIDUAL_PATTERN_BUDGET_MS, () =>
      worker.fetch(req, env, ctx),
    );
    await ctx.drain();
    assert.equal(res.status, 204);
  });
}

// ---- STACK_LINE_RE (symbolicate.ts), the same class -------------------------
//
// `workers/o11y/src/drain/symbolicate.ts#STACK_LINE_RE` has two lazy
// groups (`(.+?)`) separated by a required ` (` literal, with a required
// `)` at the very end — catastrophic on a line shaped like
// `"    at a (a (a (…"` with no closing paren, even though the regex has
// no `/g` (it is anchored `^…$` and tried once per line, but that one
// attempt still backtracks quadratically across every ambiguous split
// point). Measured directly against the bare regex: 5k chars 5ms, 10k
// 20ms, 20k 74ms, 40k 305ms — roughly quadratic. An exception's `value`
// field is free text that becomes the first line of the stored body
// (`convert.ts#faroBody`) and is bounded only by `SCRUB_TEXT_MAX_CHARS`
// (256 KB) before it ever reaches drain — nothing stops it from starting
// with `"    at "` and containing many `" ("` sequences. A length guard in
// `parseLine` (`MAX_STACK_LINE_LENGTH` = 4096) skips the regex entirely for
// any line longer than a real rendered frame could ever be.
test("symbolicateResourceLogs: a pathological '    at a (a (a (…' line with no closing paren completes well under budget, not quadratic on STACK_LINE_RE", async () => {
  const poisonLine = "    at " + "a (".repeat(30_000); // ~90k chars, well past MAX_STACK_LINE_LENGTH
  const record = {
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: "demos-authoring" } },
        { key: "service.version", value: { stringValue: "deadbeef1234" } },
      ],
    },
    scopeLogs: [
      {
        logRecords: [
          {
            timeUnixNano: "1000000000",
            body: { stringValue: `TypeError: boom\n${poisonLine}` },
            attributes: [{ key: "hot.kind", value: { stringValue: "exception" } }],
          },
        ],
      },
    ],
  };

  const [resolved] = await assertUnderBudget("symbolicateResourceLogs (pathological STACK_LINE_RE input)", 200, () =>
    symbolicateResourceLogs([record], { getMap: async () => null }),
  );
  // The pathological line must never resolve (no map lookup could even
  // apply to it) — correctness alongside the budget, so a short-circuit
  // that also broke resolution would not silently pass.
  assert.equal(resolved.scopeLogs[0].logRecords[0].body.stringValue, record.scopeLogs[0].logRecords[0].body.stringValue);
});
