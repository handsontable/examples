// POST /api/session route test for DEV-2857 (Sentry DEMOS-1Z / DEMOS-20).
//
// The premise the original ticket got wrong: `@cloudflare/sandbox@0.12.3`
// ALREADY retries a 503 "Container is starting" — `sandbox.mkdir`/
// `.writeFile` route through `BaseTransport.fetch` -> `fetchWithResponseRetry`
// with `shouldRetry: r => r.status === 503`, budget ~150s, ~7 attempts. The
// `SandboxError` reaching `writeFiles` in workers/api/src/index.ts is the
// EXHAUSTED END of that loop, not a first attempt — so this fix adds zero
// retries anywhere.
//
// The real bug was `catch { /* dir may exist */ }` after `mkdir` swallowing
// that transient AFTER a full ~140s SDK budget had already burned, so the
// first `writeFile` below opened a FRESH one — Sentry DEMOS-20 measured the
// sum: `sessionElapsedMs: 283943`, 4m44s for one `POST /api/session`. T2 below
// is the double-budget proof: with the fix, `mkdir` is called once and
// `writeFile`/`startProcess` are never reached, because the create handler's
// catch degrades to a 503 instead of the loop reopening a second attempt.
//
// This is the first route test for `POST /api/session`. It reaches the sandbox
// with no new plumbing: `makeEnv()` already supplies `Sandbox: {}` and fake
// KV/D1/R2, the budget gate allows on a throwing ledger read, and
// `FRAMEWORK_DEV`/`BUILD_CONFIG` carry the Tier-2 "react-js" framework (NOT
// bare "react", which is Tier-1 only and absent from FRAMEWORK_DEV — verified
// against workers/api/src/frameworks.generated.ts during planning).
//
// Run: node --experimental-strip-types --test pipeline/session-create-container-starting.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { ctx, makeEnv } from "./fixtures/worker-harness.mjs";
import { setSandboxFactory } from "./fixtures/cloudflare-sandbox-stub.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");
const { captures } = await import("./fixtures/sentry-cloudflare-stub.mjs");
const {
  CONTAINER_STARTING_CODE,
  containerStartingMessage,
} = await import("../workers/api/src/session-lifecycle.ts");

/** The SDK's own 503 body, verbatim — see session-lifecycle.ts. */
const CONTAINER_STARTING = "Container is starting. Please retry in a moment.";

// A file map with one nested directory, so `writeFiles` actually calls
// `sandbox.mkdir` at least once (a flat file map never does: its "dir" is
// CONTAINER_ROOT itself, which writeFiles skips).
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

/**
 * A fake sandbox recording call counts, with `mkdir` scripted to throw.
 *
 * `dirReallyExists` models the physical consequence of the two failure
 * families the narrowed catch has to tell apart: an EEXIST means the
 * directory genuinely is there already (a prior run, a shared parent dir), so
 * a write into it still succeeds — `writeFile` below only fails when the
 * directory it targets was never actually created AND the sandbox was
 * scripted with an error. This is what makes T4 (EACCES) end in a raw 500
 * without this file's fake claiming any first-hand knowledge of the SDK's own
 * retry mechanics: a permission error really does leave the directory
 * missing, and the subsequent `writeFile` genuinely fails against it, exactly
 * as it would against the real sandbox.
 */
function fakeSandbox({ mkdirError, dirReallyExists = false } = {}) {
  const calls = { mkdir: 0, writeFile: 0, startProcess: 0, exposePort: 0 };
  const createdDirs = new Set();
  return {
    calls,
    async mkdir(dir) {
      calls.mkdir += 1;
      if (mkdirError) {
        if (dirReallyExists) createdDirs.add(dir);
        throw mkdirError;
      }
      createdDirs.add(dir);
    },
    async writeFile(path) {
      calls.writeFile += 1;
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (mkdirError && dir && dir !== "/app" && !createdDirs.has(dir)) throw mkdirError;
    },
    deleteFile: async () => {},
    exec: async () => ({ success: true, stdout: "", stderr: "" }),
    async startProcess() {
      calls.startProcess += 1;
    },
    async exposePort() {
      calls.exposePort += 1;
      return { url: "https://preview.test/session" };
    },
    destroy: async () => {},
  };
}

test("T1: a container that never finished starting degrades to a pinned 503, not a raw 500", async () => {
  const { env } = makeEnv();
  const sandbox = fakeSandbox({ mkdirError: new Error(CONTAINER_STARTING) });
  setSandboxFactory(() => sandbox);

  const res = await worker.fetch(sessionRequest({ framework: "react-js", files: FILES }), env, ctx);
  const body = await res.json();

  assert.equal(res.status, 503, "reverting EDIT 3 falls back to a raw 500 with the platform's own words");
  assert.equal(body.error, CONTAINER_STARTING_CODE);
  assert.equal(body.message, containerStartingMessage);
});

test("T2: the mkdir catch does not reopen a second SDK retry budget", async () => {
  const { env } = makeEnv();
  const sandbox = fakeSandbox({ mkdirError: new Error(CONTAINER_STARTING) });
  setSandboxFactory(() => sandbox);

  await worker.fetch(sessionRequest({ framework: "react-js", files: FILES }), env, ctx);

  // THE double-budget proof, and the substitute for a "retry count" assertion
  // — the retry itself is the SDK's, not ours (see the file header). Reverting
  // EDIT 2 alone (the mkdir catch's rethrow) makes writeFiles swallow the
  // transient and call writeFile below, which is a second SDK RPC and a second
  // ~140s budget — this assertion catches that regression even though EDIT 3
  // alone would still turn the eventual throw into a 503.
  assert.equal(sandbox.calls.mkdir, 1, "mkdir must not be retried by us");
  assert.equal(sandbox.calls.writeFile, 0, "writeFile must never run after mkdir's transient");
  assert.equal(sandbox.calls.startProcess, 0, "startProcess must never run after mkdir's transient");
});

test("T3 (regression guard, passes before and after): EEXIST is still swallowed by the narrowed catch", async () => {
  const { env } = makeEnv();
  const sandbox = fakeSandbox({
    mkdirError: new Error("EEXIST: file already exists, mkdir '/app/src'"),
    dirReallyExists: true,
  });
  setSandboxFactory(() => sandbox);

  const res = await worker.fetch(sessionRequest({ framework: "react-js", files: FILES }), env, ctx);
  const body = await res.json();

  assert.equal(res.status, 200, "the original swallow's own case must still work");
  assert.ok(body.sessionId, "expected a sessionId in a successful create");
  assert.ok(body.previewUrl, "expected a previewUrl in a successful create");
  assert.equal(sandbox.calls.writeFile, Object.keys(FILES).length, "the create must have proceeded");
});

test("T4 (negative guard, passes before and after): a genuine EACCES is not degraded", async () => {
  const { env } = makeEnv();
  const sandbox = fakeSandbox({ mkdirError: new Error("EACCES: permission denied, mkdir '/app/src'") });
  setSandboxFactory(() => sandbox);

  const before = captures.length;
  const res = await worker.fetch(sessionRequest({ framework: "react-js", files: FILES }), env, ctx);
  const body = await res.json();

  assert.equal(res.status, 500, "a genuine failure must not be degraded to a 503");
  assert.match(body.error, /EACCES/);

  const captured = captures.slice(before);
  assert.equal(captured.length, 1, "the outer catch-all still reports it");
  assert.equal(captured[0].kind, "exception");
  assert.equal(
    captured[0].context?.level,
    undefined,
    "no level override — this must file at Sentry's default (error), unlike the container-starting degrade",
  );
});

test("T5: the container-starting capture is a warning under its own fingerprint", async () => {
  const { env } = makeEnv();
  const sandbox = fakeSandbox({ mkdirError: new Error(CONTAINER_STARTING) });
  setSandboxFactory(() => sandbox);

  const before = captures.length;
  await worker.fetch(sessionRequest({ framework: "react-js", files: FILES }), env, ctx);
  const captured = captures.slice(before);

  assert.equal(captured.length, 1, "exactly one Sentry event for the degrade");
  assert.equal(captured[0].kind, "exception");
  assert.equal(captured[0].context?.level, "warning");
  assert.deepEqual(captured[0].context?.fingerprint, ["tier2-session-container-starting"]);
  assert.deepEqual(captured[0].context?.tags, { context: "tier2-session-start" });
});
