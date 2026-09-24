// Finding Z-A-C1: the ingest scrub/normalise/fingerprint path had several
// quadratic ("ReDoS") regexes reachable from an anonymous
// `POST /telemetry/collect` request — an attacker-controlled string with no
// closing delimiter made the engine backtrack character-by-character at
// every start position, O(n) work at each of O(n) positions, O(n²) total.
// Measured on the unfixed code: `redactEmailInText` alone cost 4.3s at 80k
// characters and projected ~36s at the 256 KB record cap, well past the
// Worker's 120s `cpu_ms` budget for a handful of concurrent requests.
//
// These tests assert a wall-clock budget on adversarial input for each
// fixed pattern, plus the full `processFaroBody` pipeline and a real
// `worker.fetch` route call with a gzip body — the exact shape the finding
// used to reproduce the CPU-exhaustion route. Every test here was seen
// FAILING (timing out its budget, not merely slow) against the pre-fix
// regexes — see the task report for the revert evidence — and passes now
// that every pattern is linear-time plus the pre-scrub truncation
// (`SCRUB_TEXT_MAX_CHARS`) is in place.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build` (this
// file imports the runtime's dist, same as `telemetry-fingerprint.test.mjs`).
// Run: node --experimental-strip-types --test pipeline/o11y-redos.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { redactEmailInText, redactUserAgentInText, scrubBodyText } = await import(
  "../workers/o11y/src/normalise/text-scrub.ts"
);
const { processFaroBody } = await import("../workers/o11y/src/normalise/faro.ts");
const { redactPreviewHosts, normalizeMonitorMessage } = await import("../packages/runtime/dist/monitor.js");
const { fingerprint } = await import("../packages/runtime/dist/telemetry/index.js");
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

// ---- Individual pattern budgets (well under 100ms, per the task's own bar) -----

// Sized at 100k, not 200k: on the pre-fix quadratic pattern this still
// costs several seconds (measured on the unfixed code: ~5.9s / ~10s
// respectively, both far over budget), while giving the fixed, linear
// pattern more headroom under the 100ms budget in a loaded CI run (a
// parallel `pnpm test` worker pool, slower hardware).
test("redactEmailInText: 100k 'a' characters with no '@' completes well under 100ms", async () => {
  const input = "a".repeat(100_000);
  await assertUnderBudget("redactEmailInText", 100, () => redactEmailInText(input));
});

test("redactEmailInText: 100k 'a.'-repeats (no '@') completes well under 100ms", async () => {
  const input = "a.".repeat(50_000);
  await assertUnderBudget("redactEmailInText (a.-repeats)", 100, () => redactEmailInText(input));
});

test("redactUserAgentInText: 'Mozilla/1 (' repeated with no closing paren completes well under 100ms", async () => {
  const input = "Mozilla/1 (".repeat(20_000);
  await assertUnderBudget("redactUserAgentInText", 100, () => redactUserAgentInText(input));
});

test("redactPreviewHosts: 100k 'a-'-repeats with no '.demos.handsontable.com' suffix completes well under 100ms", async () => {
  const input = "a-".repeat(50_000);
  await assertUnderBudget("redactPreviewHosts", 100, () => redactPreviewHosts(input));
});

test("normalizeMonitorMessage: 200k identifier-shaped characters with no ' is not defined' suffix completes well under 100ms", async () => {
  const input = "a".repeat(200_000);
  await assertUnderBudget("normalizeMonitorMessage", 100, () => normalizeMonitorMessage(input));
});

test("fingerprint (the real monitor.ts shape, via normalizeMonitorMessage + stripCodeFrame): 200k chars completes well under 100ms", async () => {
  const input = "a".repeat(200_000);
  await assertUnderBudget("fingerprint", 100, () => fingerprint("demo-runtime", input));
});

// ---- The combined server-side pass (text-scrub.ts's own extra scrub) -----------

test("scrubBodyText: 100k 'a' characters (email + UA + URL passes chained) completes well under 100ms", async () => {
  const input = "a".repeat(100_000);
  await assertUnderBudget("scrubBodyText", 100, () => scrubBodyText(input));
});

// ---- The full normalise pipeline, the shape Z-A-C1 actually measured -----------

test("processFaroBody: a Faro log item with an 80k-character adversarial message completes well under budget (Z-A-C1's own measured shape)", async () => {
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

// ---- End to end: the real route, a real gzip body, the exact reproduction ------
// Z-A-C1 used to reproduce this over the real `worker.fetch` with a ~1KB
// gzip upload that expanded to a ~1MB adversarial JSON body.

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test("POST /telemetry/collect: a gzip body carrying an adversarial 160k-character message completes well under budget, not the 120s cpu_ms cap (Z-A-C1's real repro)", async () => {
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

// ---- Advisor sweep finding: STACK_LINE_RE (symbolicate.ts), the same class --
//
// `workers/o11y/src/drain/symbolicate.ts#STACK_LINE_RE` has two lazy
// groups (`(.+?)`) separated by a required ` (` literal, with a required
// `)` at the very end — catastrophic on a line shaped like
// `"    at a (a (a (…"` with no closing paren, even though the regex has
// no `/g` (it is anchored `^…$` and tried once per line, but that ONE
// attempt still backtracks quadratically across every ambiguous split
// point). Measured directly against the bare regex (not through this
// test): 5k chars 5ms, 10k 20ms, 20k 74ms, 40k 305ms — roughly quadratic.
// An exception's `value` field is free text that becomes the FIRST line of
// the stored body (`convert.ts#faroBody`) and is bounded only by
// `SCRUB_TEXT_MAX_CHARS` (256 KB, Z-A-C1) before it ever reaches drain —
// nothing stops it from starting with `"    at "` and containing many
// `" ("` sequences. Fixed with a length guard in `parseLine` (`MAX_STACK_LINE_LENGTH`
// = 4096) that skips the regex entirely for any line longer than a real
// rendered frame could ever be.
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
