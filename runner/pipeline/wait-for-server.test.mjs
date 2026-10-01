// The e2e boot-wait helper must honour its timeout and fail fast when the
// serving process has already exited.
// Run: node --experimental-strip-types --test pipeline/wait-for-server.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { waitForServer } from "../e2e/wait-for-server.ts";

const closedPort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

test("waitForServer: resolves once the server answers", async () => {
  const s = createServer((_, res) => res.end("ok"));
  await new Promise((r) => s.listen(0, r));
  try {
    await waitForServer(`http://127.0.0.1:${s.address().port}`, 2000);
  } finally {
    s.close();
  }
});

test("waitForServer: rejects at the timeout when nothing answers", async () => {
  const port = await closedPort();
  const t0 = Date.now();
  await assert.rejects(waitForServer(`http://127.0.0.1:${port}`, 600, () => false, 50));
  const took = Date.now() - t0;
  assert.ok(took >= 500 && took < 3000, `rejected after ${took}ms`);
});

test("waitForServer: fails fast when the serving process has exited", async () => {
  const port = await closedPort();
  const t0 = Date.now();
  await assert.rejects(waitForServer(`http://127.0.0.1:${port}`, 30_000, () => true), /exited before it answered/);
  assert.ok(Date.now() - t0 < 1000, "must not wait out the timeout");
});
