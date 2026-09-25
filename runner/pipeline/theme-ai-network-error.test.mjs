// A network-level throw from the LiteLLM fetch in `/api/theme` used to vanish
// entirely: `requestTheme` (theme-ai.ts) never wraps its own `fetch()` call, so
// a connection failure (DNS, refused, reset — a real `TypeError`, not a
// `ChatUnavailableError`) propagated straight past `index.ts`'s
// `if (err instanceof ChatUnavailableError)` guard to `throw err`, reaching the
// generic fetch catch-all with **no `theme.ai` point at all** — contract §5
// promises one on every outcome, `error` included, and `chat.answer`'s twin
// catch had the same gap closed already (this fix mirrors it: emit before the
// instanceof branch decides the response).
//
// Driven through the REAL router (`workers/api/src/index.ts`'s default
// export), the same way token-routes.test.mjs proves route-level properties —
// a re-declared copy of the catch would not catch this regressing.
//
// Run: node --experimental-strip-types --test pipeline/theme-ai-network-error.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { ctx, makeEnv } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");

const HOST = "https://demos.handsontable.com";

// blob/double slot positions, §4 (AE_COLUMNS, packages/runtime/src/telemetry/metrics.ts):
// model=blob13 (index 12), outcome=blob8 (index 7), count=double1 (index 0).
const MODEL_SLOT = 12;
const OUTCOME_SLOT = 7;
const COUNT_SLOT = 0;

function envWithPointCapture() {
  const points = [];
  const { env, ...rest } = makeEnv();
  env.RUNNER_EVENTS = { writeDataPoint: (p) => points.push(p) };
  // Routes AE writes through the in-memory sink instead of the local-ClickHouse
  // HTTP fallback `serviceEnvironment` selects for a non-production host — see
  // the identical comment on `snapshot-build-point.test.mjs`'s own helper.
  env.PREVIEW_HOST = "demos.handsontable.com";
  env.LITELLM_API_KEY = "test-key";
  return { env, points, ...rest };
}

function themeAiPoints(points) {
  return points.filter((p) => p.indexes[0] === "theme.ai");
}

test("a network-level throw from the LiteLLM fetch still emits theme.ai outcome=error", async () => {
  const { env, points } = envWithPointCapture();

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("litellm")) {
      // The exact failure mode this test exists for: `fetch()` itself
      // rejects (connection refused / DNS / reset), never resolving to a
      // Response — so `requestTheme`'s `if (!res.ok)` branch (the one that
      // throws `ChatUnavailableError`) is never reached at all.
      throw new TypeError("fetch failed: network connection lost");
    }
    throw new Error(`unexpected network fetch in theme-ai-network-error.test.mjs: ${url}`);
  };

  try {
    const res = await worker.fetch(
      new Request(`${HOST}/api/theme`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "make it purple", current: {} }),
      }),
      env,
      ctx,
    );
    // The raw throw is not a ChatUnavailableError, so it still falls through
    // to the generic fetch catch-all (a 500) — that part of the behaviour is
    // pre-existing and out of scope here. The point is what to fix.
    assert.equal(res.status, 500);

    const points_ = themeAiPoints(points);
    assert.equal(points_.length, 1, `expected exactly 1 theme.ai point, got ${points_.length}`);
    assert.equal(points_[0].blobs[OUTCOME_SLOT], "error");
    assert.equal(points_[0].blobs[MODEL_SLOT], "unknown");
    assert.equal(points_[0].doubles[COUNT_SLOT], 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
