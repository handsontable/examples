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

test("redactEmailInText: 200k 'a' characters with no '@' completes well under 100ms", async () => {
  const input = "a".repeat(200_000);
  await assertUnderBudget("redactEmailInText", 100, () => redactEmailInText(input));
});

test("redactEmailInText: 200k 'a.'-repeats (no '@') completes well under 100ms", async () => {
  const input = "a.".repeat(100_000);
  await assertUnderBudget("redactEmailInText (a.-repeats)", 100, () => redactEmailInText(input));
});

test("redactUserAgentInText: 'Mozilla/1 (' repeated with no closing paren completes well under 100ms", async () => {
  const input = "Mozilla/1 (".repeat(20_000);
  await assertUnderBudget("redactUserAgentInText", 100, () => redactUserAgentInText(input));
});

test("redactPreviewHosts: 200k 'a-'-repeats with no '.demos.handsontable.com' suffix completes well under 100ms", async () => {
  const input = "a-".repeat(100_000);
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

test("scrubBodyText: 200k 'a' characters (email + UA + URL passes chained) completes well under 100ms", async () => {
  const input = "a".repeat(200_000);
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
