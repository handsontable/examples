// T04/T03 merge: ADR-0041 §G's "crossing the cap stops backlog wakes; a
// Grafana visit still wakes the box" — the acceptance criterion T04 could
// not close on its own (T03 owns the wake decision, and had not merged).
// Drives the REAL merged `scheduled()` handler (`workers/o11y/src/index.ts`)
// and the REAL `handleGrafana` (`grafana/proxy.ts`) against a REAL
// `InboxWriter` Durable Object, so `drainsPaused` really is read from the
// same storage `alerts/index.ts#o11yCapRule` writes to via
// `InboxWriter.setDrainsPaused` — not a fake that could silently drift from
// the real RPC surface.
//
// Run: node --experimental-strip-types --test pipeline/o11y-cap-wake.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { default: worker, InboxWriter } = await import("../workers/o11y/src/index.ts");
const { handleGrafana } = await import("../workers/o11y/src/grafana/proxy.ts");
const { makeEnv, ctx } = await import("./fixtures/o11y-harness.mjs");
const { inboxKeyStorageKey } = await import("@handsontable/demo-runtime/telemetry");

/** A minimal `.list()`-capable R2 fake — `InboxWriter.backlog()` (T03,
 *  `ledger.ts#computeBacklog`) reads `{ key, size, uploaded }` per object;
 *  `o11y-harness.mjs#makeR2Bucket` doesn't implement `list()` (nothing
 *  before this test needed it), so this stays local rather than growing
 *  that shared fixture for one caller. */
function makeListableR2(objects) {
  return {
    async list({ prefix } = {}) {
      const filtered = objects.filter((o) => !prefix || o.key.startsWith(prefix));
      return { objects: filtered, truncated: false };
    },
  };
}

function makeGrafanaBoxRecorder(overrides = {}) {
  const calls = [];
  const stub = {
    async wake(reason) {
      calls.push(reason);
    },
    async isReady() {
      return overrides.ready ?? true;
    },
    async noteVisitorActivity() {},
    async containerFetch() {
      return new Response("grafana-body", { status: 200 });
    },
  };
  const namespace = { jurisdiction() { return this; }, getByName() { return stub; } };
  return { calls, namespace };
}

test("backlog wake: refused while drainsPaused; the SAME backlog wakes the box once cleared", async () => {
  // `worker.scheduled()` also runs `runAlerts` (the merged handler wires
  // all three: heartbeat stamp, backlog wake, alert evaluation — see
  // index.ts). Left at the harness's default `O11Y_ENV: "production"`,
  // `runAlerts`'s 7 AE-query rules would each attempt a REAL fetch to
  // Cloudflare's Analytics Engine SQL API — slow and non-hermetic in a
  // suite that must run offline. `O11Y_ENV: "local"` plus an
  // immediately-refusing loopback URL (matches `o11y-alerts.test.mjs`'s
  // own "runAlerts: a real query failure" test) makes every one of those
  // queries fail fast instead; `runAlerts` already swallows a per-rule
  // failure into its own `errors` map (I2, fix round 1) rather than
  // throwing, so this has no effect on the wake behaviour under test here.
  const { env, doStorage } = makeEnv(InboxWriter, {
    env: { O11Y_ENV: "local", RUNNER_EVENTS_CLICKHOUSE_URL: "http://127.0.0.1:1" },
  });

  // A backlog old enough to trigger a wake attempt on its own merits (> 1h).
  const objectKey = "inbox/worker/2026-09-01/00/000000000001.ndjson.gz";
  env.O11Y_INBOX = makeListableR2([
    { key: objectKey, size: 1024, uploaded: new Date(Date.now() - 2 * 60 * 60 * 1000) },
  ]);
  await doStorage.put({ [inboxKeyStorageKey(objectKey)]: "written" });

  const grafanaBox = makeGrafanaBoxRecorder();
  env.GRAFANA_BOX = grafanaBox.namespace;

  const writer = env.INBOX_WRITER.jurisdiction("eu").get();
  assert.equal(await writer.drainsPaused(), false, "sanity: not paused yet");

  // The o11y spend cap fires (alerts/index.ts#runAlerts, on a real spend-cap
  // crossing) and pauses drains through the exact same RPC method this test
  // now drives directly.
  await writer.setDrainsPaused(true);

  await worker.scheduled({ cron: "*/10 * * * *" }, env, ctx);
  await ctx.drain();
  assert.deepEqual(grafanaBox.calls, [], "a backlog wake must be refused while drainsPaused");

  // Resolve the cap (a raised budget, or month rollover) — the identical
  // backlog now wakes the box; nothing else about the backlog changed.
  await writer.setDrainsPaused(false);
  await worker.scheduled({ cron: "*/10 * * * *" }, env, ctx);
  await ctx.drain();
  assert.deepEqual(grafanaBox.calls, ["backlog"], "once resolved, the same backlog wakes the box");
});

test("Grafana visit wake: unaffected by drainsPaused (still wakes the box)", async () => {
  const { env } = makeEnv(InboxWriter);
  const grafanaBox = makeGrafanaBoxRecorder();
  env.GRAFANA_BOX = grafanaBox.namespace;
  env.DEV_ADMIN = "dev@handsontable.com"; // local Access bypass (O11Y_ENV is "production" in this harness by default)
  env.O11Y_ENV = "local";

  const writer = env.INBOX_WRITER.jurisdiction("eu").get();
  await writer.setDrainsPaused(true);
  assert.equal(await writer.drainsPaused(), true, "sanity: the cap is active for this request");

  const req = new Request("https://demos.handsontable.com/grafana/d/abc");
  const res = await handleGrafana(req, env, ctx);

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "grafana-body", "the box answered — the visit wake was not refused");
  assert.deepEqual(grafanaBox.calls, ["visit"], "ADR §G: 'visit wakes still work' — drainsPaused must never gate this path");
});
