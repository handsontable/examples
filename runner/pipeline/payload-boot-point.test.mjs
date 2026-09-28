// `GET /api/payload/:id` — what a `?payload=` playground link boots from — records a
// link that cannot boot as `payload.boot outcome=error framework=other` (contract §5):
// a miss (expired or never minted), a malformed id, and a KV failure. A link that
// boots records nothing here; its `ok` point was written when it was minted.
// Driven through the real router with the shared fakes.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/payload-boot-point.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { makeEnv } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");

function setup() {
  const { env } = makeEnv();
  const points = [];
  env.RUNNER_EVENTS = { writeDataPoint: (p) => points.push(p) };
  env.PREVIEW_HOST = "demos.handsontable.com";
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p)), passThroughOnException() {} };
  const bootPoints = async () => {
    for (let seen = -1; seen !== pending.length;) {
      seen = pending.length;
      await Promise.allSettled(pending);
    }
    return points.filter((p) => p.indexes[0] === "payload.boot");
  };
  return { env, ctx, bootPoints };
}

const get = (id) => new Request(`https://demos.handsontable.com/api/payload/${id}`);

async function assertOneErrorPoint(bootPoints) {
  const points = await bootPoints();
  assert.equal(points.length, 1, `expected one payload.boot point, got ${points.length}`);
  assert.ok(points[0].blobs.includes("error"), "outcome=error");
  assert.ok(points[0].blobs.includes("other"), "framework=other");
}

test("an expired or unknown payload link is a 404 and one payload.boot error point", async () => {
  const { env, ctx, bootPoints } = setup();
  const res = await worker.fetch(get("zzzzzzzzzz"), env, ctx);
  assert.equal(res.status, 404);
  await assertOneErrorPoint(bootPoints);
});

test("a malformed payload id is a 404 and one payload.boot error point", async () => {
  const { env, ctx, bootPoints } = setup();
  const res = await worker.fetch(get("not-an-id!"), env, ctx);
  assert.equal(res.status, 404);
  await assertOneErrorPoint(bootPoints);
});

test("a KV failure reading the payload is a 500 and one payload.boot error point", async () => {
  const { env, ctx, bootPoints } = setup();
  env.CACHE.get = async () => {
    throw new Error("KV unavailable");
  };
  const res = await worker.fetch(get("abc123"), env, ctx);
  assert.equal(res.status, 500);
  await assertOneErrorPoint(bootPoints);
});

test("a payload link that boots records no payload.boot point", async () => {
  const { env, ctx, bootPoints } = setup();
  await env.CACHE.put("payload:abc123", JSON.stringify({ framework: "javascript", files: { "/index.js": "1" }, title: "T" }));
  const res = await worker.fetch(get("abc123"), env, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(await bootPoints(), []);
});
