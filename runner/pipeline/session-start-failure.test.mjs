// What a failed POST /api/session tells the user (DEV-2538).
//
// Sentry DEMOS-9 collected 82 events titled `Error: session start failed (504): `,
// stopping at a colon: the platform (not our Worker — its catch-all always answers
// with a JSON `{error}` envelope) timed the container start out and returned an empty
// body, which the message template interpolated as nothing.
//
// The empty sentence was only the issue title. What the *user* saw was worse: every
// message on this path reaches `describeRuntimeError` in apps/authoring/src/App.tsx,
// whose container-engine heuristic matches /…|session start failed|fetch/i and
// replaces the message with "run the local API worker (requires Docker)". A visitor
// on demos.handsontable.com whose sandbox timed out was told to install Docker.
//
// So the timeout tier has to say something true AND has to stay clear of the words
// that heuristic keys on. That second half is a contract across a package boundary,
// enforced nowhere but here.

import test from "node:test";
import assert from "node:assert/strict";
import { ContainerRuntime, SessionStartError } from "../packages/runtime/dist/container.js";

const ENTRY = {
  framework: "angular",
  displayName: "Angular",
  tier: 2,
  engine: "container",
  sandpackTemplate: null,
  sandpackEnvironment: null,
  container: "angular",
  htWrappers: [],
  entry: "/src/main.ts",
  htmlEntry: null,
  devCommand: "start",
  buildCommand: "build",
  outputDir: "dist",
  outputGlob: null,
  staticExport: false,
  spaMode: true,
  port: 4200,
  installCommand: "install",
  htCoreRange: null,
  minCoreMajor: null,
  fileCount: 2,
  assets: [],
  skipped: [],
  files: {},
};

const FILES = {
  "/package.json": JSON.stringify({ dependencies: { handsontable: "16.0.1" } }),
  "/src/main.ts": "console.log('demo');",
};

/**
 * Drive the real `mount()` against a stubbed create response and return the error it
 * rejects with. Driven through mount() rather than by calling `readFailure` directly:
 * the tiering under test lives in mount()'s throw, and the failure path there also
 * disposes and DELETEs the half-created session — so the stub has to survive that
 * follow-up request too (a throwing DELETE would mask the assertion).
 */
async function sessionStartError(status, body) {
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = (url, init = {}) => {
    if (url.endsWith("/api/session") && init.method === "POST") {
      // `readFailure` reads the body with res.text(), not res.json().
      return Promise.resolve({ ok: false, status, text: () => Promise.resolve(body) });
    }
    // The cleanup DELETE, and anything else the teardown reaches for.
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };

  const runtime = new ContainerRuntime(ENTRY, { iframe: {}, apiBase: "https://api.test" });
  try {
    await runtime.mount({ ...FILES });
    assert.fail(`mount() resolved on a ${status}`);
  } catch (err) {
    assert.ok(err instanceof SessionStartError, `expected a SessionStartError, got ${err}`);
    assert.equal(err.status, status);
    return err;
  } finally {
    runtime.dispose();
    globalThis.fetch = fetchBefore;
    globalThis.window = windowBefore;
  }
}

test("an empty-bodied 504 says the sandbox timed out, in words the app will not swallow", async () => {
  const err = await sessionStartError(504, "");

  assert.ok(err.message.trim().length > 0, "the user must be told something");
  assert.doesNotMatch(err.message, /:\s*$/, "no dangling colon where the body should have been");
  assert.match(err.message, /504/, "the status keeps Sentry titles distinguishable per status");

  // THE CONTRACT. `describeRuntimeError` at apps/authoring/src/App.tsx:115 tests
  // /failed to fetch|networkerror|load failed|session start failed|fetch/i against this
  // message and, on a match, replaces it with the local-dev "install Docker, run the API
  // worker" text. That is the right answer when a developer's worker is down and the
  // wrong one for a production visitor whose container timed out. Nothing else in the
  // repo pins this — the regex lives in another package — so a copy edit that reads
  // better but says "fetch" would silently restore the misattribution.
  assert.doesNotMatch(err.message, /session start failed/i, "would trip App.tsx:115");
  assert.doesNotMatch(err.message, /fetch/i, "would trip App.tsx:115");
  assert.doesNotMatch(err.message, /failed to fetch|networkerror|load failed/i);
});

test("a gateway HTML error page never becomes the user's message", async () => {
  // Cloudflare answers some timeouts with a whole HTML page. Interpolated verbatim it
  // becomes both the <pre> the user reads and the Sentry issue title.
  const page = `<html><head><title>Gateway time-out</title></head><body>${"x".repeat(4000)}</body></html>`;
  const err = await sessionStartError(504, page);

  assert.doesNotMatch(err.message, /<html/i);
  assert.ok(err.message.length < 300, `message should be a sentence, got ${err.message.length} chars`);
});

test("a non-timeout status still shows the body, but bounded", async () => {
  // The truncation cap only bites on this tier — a timeout discards the body outright,
  // so a 504 + HTML case proves nothing about the cap.
  const page = `<html><body>${"x".repeat(4000)}</body></html>`;
  const err = await sessionStartError(500, page);

  assert.match(err.message, /^session start failed \(500\): /);
  assert.ok(err.message.length < 300, `body must be capped, got ${err.message.length} chars`);
  assert.match(err.message, /\.\.\.$/, "truncateMessage marks what it cut");
});

test("a budget refusal still reaches the user as the server phrased it", async () => {
  // DEV-2030's guardrail sentence is written for users and must arrive unwrapped —
  // `isBudgetRefusal` and App.tsx's own budget branch both depend on it.
  const sentence = "Live editing is paused for today. Try again tomorrow.";
  const err = await sessionStartError(
    503,
    JSON.stringify({ error: "budget_exhausted", message: sentence }),
  );

  assert.equal(err.code, "budget_exhausted");
  assert.equal(err.message, sentence);
});

test("an ordinary envelope error is unchanged", async () => {
  const err = await sessionStartError(500, JSON.stringify({ error: "boom", message: "boom" }));

  assert.equal(err.code, "boom");
  assert.equal(err.message, "session start failed (500): boom");
});

test("an empty-bodied 500 drops the colon but keeps the connectivity hint", async () => {
  // Deliberately NOT a timeout tier: a local vite proxy answering 500 with nothing
  // usable is exactly the "your API worker isn't running" case App.tsx:115 exists for,
  // so this message must keep tripping it.
  const err = await sessionStartError(500, "");

  assert.equal(err.message, "session start failed (500)");
  assert.match(err.message, /session start failed/i, "must still trip App.tsx:115");
});
