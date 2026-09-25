// F14 (W-triage): `container.boot_ms` was only ever emitted for
// `outcome: "window_exceeded"`, from a DO fetch override reachable only on a
// LATER proxied preview request — never from `POST /api/session`'s own
// create path. So a successful or failed create never produced a
// `container.boot_ms ready`/`error` point at all, and the `tier2-sessions`
// dashboard panel ("container.boot_ms p95 by outcome") stayed permanently
// empty even on a healthy deploy: `blob6 IN (${framework:sqlstring})`, with
// `framework` a `SELECT DISTINCT ... WHERE blob6 != ''` variable, has nothing
// to match when every point ever written carries `blob6 = ''`.
//
// This file pins the create path's two NEW outcomes — `ready` (the
// `withSpan("container.boot", …)` block resolves) and `error` (it throws,
// past the `at_capacity`/`container_starting` refusals, which already have
// their own `session.start` outcome and must not be double-counted here) —
// and that a refusal or an early throw emits neither.
//
// Route-tested with the same harness `session-create-container-starting
// .test.mjs` established for `POST /api/session`. `container.boot_ms`
// requires flipping `getSink()` to its `bindingSink` branch (see
// `pipeline/lite-inject.test.mjs#makeCountingEnv`'s own doc comment):
// `worker-harness.mjs#makeEnv` otherwise routes Analytics Engine points at a
// local ClickHouse HTTP fetch that has nothing listening in this sandbox and
// which `emitPoint` — by design — swallows on failure.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { ctx, makeEnv } from "./fixtures/worker-harness.mjs";
import { setSandboxFactory } from "./fixtures/cloudflare-sandbox-stub.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");

const FILES = {
  "package.json": JSON.stringify({ name: "demo" }),
  "src/App.jsx": "export default function App() { return null; }",
};

const sessionRequest = (body) =>
  new Request("https://demos.handsontable.com/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** See `pipeline/lite-inject.test.mjs#makeCountingEnv`: flips `getSink()` to
 *  its `bindingSink` branch (a real `RUNNER_EVENTS` fake) instead of the
 *  local-mode ClickHouse HTTP fetch, which has nothing to talk to here. */
function countingEnv() {
  const { env } = makeEnv();
  const points = [];
  env.RUNNER_EVENTS = { writeDataPoint: (p) => points.push(p) };
  env.PREVIEW_HOST = "demos.handsontable.com";
  return { env, points };
}

const bootPoints = (points) => points.filter((p) => p.indexes[0] === "container.boot_ms");

function fakeSandbox({ startProcessError, mkdirError, writeFileError } = {}) {
  const calls = { mkdir: 0, writeFile: 0, startProcess: 0, exposePort: 0, setFramework: 0 };
  const frameworks = [];
  return {
    calls,
    frameworks,
    async mkdir() {
      calls.mkdir += 1;
      if (mkdirError) throw mkdirError;
    },
    async writeFile() {
      calls.writeFile += 1;
      if (writeFileError) throw writeFileError;
    },
    deleteFile: async () => {},
    exec: async () => ({ success: true, stdout: "", stderr: "" }),
    async startProcess() {
      calls.startProcess += 1;
      if (startProcessError) throw startProcessError;
    },
    async exposePort() {
      calls.exposePort += 1;
      return { url: "https://preview.test/session" };
    },
    async setFramework(framework) {
      calls.setFramework += 1;
      frameworks.push(framework);
    },
    destroy: async () => {},
  };
}

test("the happy path emits exactly one container.boot_ms ready, with the framework", async () => {
  const { env, points } = countingEnv();
  const sandbox = fakeSandbox();
  setSandboxFactory(() => sandbox);

  const res = await worker.fetch(sessionRequest({ framework: "react-js", files: FILES }), env, ctx);
  assert.equal(res.status, 200);

  const boot = bootPoints(points);
  assert.equal(boot.length, 1, "expected exactly one container.boot_ms point");
  assert.equal(boot[0].blobs[7], "ready", "blob8 outcome");
  assert.equal(boot[0].blobs[5], "react-js", "blob6 framework — what the tier2-sessions panel filters on");
  assert.ok(boot[0].doubles[1] >= 0, "double2 duration_ms");
});

test("a startProcess throw emits exactly one container.boot_ms error, with the framework", async () => {
  const { env, points } = countingEnv();
  const sandbox = fakeSandbox({ startProcessError: new Error("boom: disk full") });
  setSandboxFactory(() => sandbox);

  const res = await worker.fetch(sessionRequest({ framework: "react-js", files: FILES }), env, ctx);
  assert.equal(res.status, 500, "an unrecognised throw is not degraded");

  const boot = bootPoints(points);
  assert.equal(boot.length, 1, "expected exactly one container.boot_ms point");
  assert.equal(boot[0].blobs[7], "error", "blob8 outcome");
  assert.equal(boot[0].blobs[5], "react-js", "blob6 framework");
});

test("a throw before the boot span even starts (writeFiles) emits no container.boot_ms point", async () => {
  const { env, points } = countingEnv();
  // `writeFile` itself throws — still upstream of
  // `bootStartedAt = Date.now()` / `withSpan("container.boot", …)`, which
  // only run once every file write has succeeded.
  const sandbox = fakeSandbox({ writeFileError: new Error("disk quota exceeded") });
  setSandboxFactory(() => sandbox);

  const res = await worker.fetch(sessionRequest({ framework: "react-js", files: FILES }), env, ctx);
  assert.equal(res.status, 500);
  assert.equal(sandbox.calls.startProcess, 0, "the boot span must never have started");

  assert.equal(bootPoints(points).length, 0, "a pre-boot failure is not a container.boot_ms outcome");
});

test("a container-starting refusal emits session.start's own outcome, not a second container.boot_ms error", async () => {
  const { env, points } = countingEnv();
  // The SDK's own retry-exhausted 503, surfaced through mkdir (same fixture
  // shape as session-create-container-starting.test.mjs).
  const sandbox = fakeSandbox({
    mkdirError: new Error("Container is starting. Please retry in a moment."),
  });
  setSandboxFactory(() => sandbox);

  const res = await worker.fetch(sessionRequest({ framework: "react-js", files: FILES }), env, ctx);
  assert.equal(res.status, 503);

  const sessionStart = points.filter((p) => p.indexes[0] === "session.start");
  assert.equal(sessionStart.length, 1);
  assert.equal(sessionStart[0].blobs[7], "container_starting");

  // The at-capacity/container-starting refusals are classified from the
  // create's OWN try, before `withSpan("container.boot", …)` — `bootStartedAt`
  // is still null, so no `container.boot_ms` point of either outcome exists.
  // Double-counting a refusal already carried by `session.start` would corrupt
  // the panel's error rate (W-triage F14).
  assert.equal(bootPoints(points).length, 0, "container-starting must not also emit container.boot_ms");
});

// A budget denial (`budgetGate`) returns before `startSessionMeter`/
// `writeFiles` even run — earlier than the mkdir/EACCES throw above, which
// already proves the general invariant this depends on: `bootStartedAt` is
// only ever set immediately before `withSpan("container.boot", …)`, so any
// return/throw upstream of it — a denial included — emits no
// `container.boot_ms` point of either outcome. Not pinned as its own case:
// reverse-engineering `budgetGate`'s D1 ledger/settings shape into a fake
// that deterministically denies (rather than the "throws == allow" default
// `session-create-container-starting.test.mjs` documents) is its own,
// separate piece of work, out of scope for this fix.
