import test from "node:test";
import assert from "node:assert/strict";
import {
  createDemoEventCollapse,
  DEMO_EDIT_SETTLE_MS,
  DEMO_COLLAPSE_CEILING,
} from "../apps/authoring/src/demoEventCollapse.ts";
import { demoEventReport } from "../apps/authoring/src/demoEventReport.ts";
import { fingerprint, fingerprintShape } from "../packages/runtime/dist/telemetry/index.js";

// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build` (for
// the real §7 `fingerprint`/`fingerprintShape`, so the ladder below is keyed
// exactly as `sentry.ts` keys it).
//
// Typing one throwing line into a Tier-1 editor must not relay ~20
// `preview.runtime_error` points (one per half-typed prefix) — the collapse
// turns that into one point per edit burst, while a non-edit error still
// counts immediately.

/** A hand-driven timer: `advance(ms)` fires whatever came due. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

function harness(extra = {}) {
  const clock = fakeTimers();
  const emitted = [];
  const collapse = createDemoEventCollapse({
    emit: (item) => emitted.push(item),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...extra,
  });
  /** Relay a message the way `sentry.ts` does: keyed by its real fingerprint. */
  const relay = (message) => collapse.report(fingerprint("demo-runtime", message), message);
  return { clock, emitted, collapse, relay };
}

// The real ladder shape for `setTimeout(() => { throw new Error('R5RUNTIME'); }, 100);`
// typed one key at a time: several DIFFERENT fingerprints (a ReferenceError
// ladder, syntax errors, the final throw), which is why fingerprint dedupe
// alone cannot collapse it.
const LADDER = [
  "s is not defined",
  "se is not defined",
  "set is not defined",
  "setT is not defined",
  "setTi is not defined",
  "setTim is not defined",
  "setTime is not defined",
  "setTimeo is not defined",
  "setTimeou is not defined",
  "Unexpected end of input",
  "Unexpected token ')'",
  "Unexpected end of input",
  "Unterminated string constant",
  "missing ) after argument list",
  "Unexpected end of input",
];
const FINAL = "R5RUNTIME boom";

test("a keystroke prefix ladder emits exactly one point: the error the finished line throws", () => {
  const { clock, emitted, collapse, relay } = harness();
  for (const message of LADDER) {
    collapse.noteEdit();
    clock.advance(120); // typing speed, well inside the settle window
    relay(message);
  }
  collapse.noteEdit(); // the last keystroke
  clock.advance(150);
  relay(FINAL);
  assert.equal(emitted.length, 0, "nothing is emitted while the user is still typing");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, [FINAL]);
  // The distinct fingerprints above prove it is the burst rule, not fingerprint
  // dedupe, that removed the rungs.
  assert.ok(new Set(LADDER.map((m) => fingerprint("demo-runtime", m))).size > 3);
});

test("a ladder whose finished line is clean emits nothing", () => {
  const { clock, emitted, collapse, relay } = harness();
  for (const message of LADDER) {
    collapse.noteEdit();
    clock.advance(100);
    relay(message);
  }
  collapse.noteEdit(); // the keystroke that completes a valid line: no error follows
  clock.advance(DEMO_EDIT_SETTLE_MS * 3);
  assert.deepEqual(emitted, []);
});

test("a first-load error (no edit) emits one point immediately, and repeats of it do not add more", () => {
  const { clock, emitted, relay } = harness();
  relay("Cannot read properties of undefined (reading 'getData')");
  assert.equal(emitted.length, 1, "no settle wait outside an edit burst");
  relay("Cannot read properties of undefined (reading 'getData')");
  clock.advance(DEMO_EDIT_SETTLE_MS * 2);
  relay("Cannot read properties of undefined (reading 'getData')");
  assert.equal(emitted.length, 1);
});

test("two distinct persistent errors emit two points — one burst each", () => {
  const { clock, emitted, collapse, relay } = harness();
  collapse.noteEdit();
  relay("first broken thing");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  collapse.noteEdit();
  relay("second broken thing");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, ["first broken thing", "second broken thing"]);
});

test("two distinct persistent errors from the same final run emit two points", () => {
  const { clock, emitted, collapse, relay } = harness();
  collapse.noteEdit();
  relay("first broken thing");
  relay("second broken thing");
  relay("first broken thing"); // a re-render of the same fault
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, ["first broken thing", "second broken thing"]);
});

test("a persistent error is counted once per edit burst, again after the next burst", () => {
  const { clock, emitted, collapse, relay } = harness();
  relay("still broken"); // first load
  collapse.noteEdit(); // an edit elsewhere in the file, the fault survives it
  relay("still broken");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  relay("still broken"); // a click re-throwing it, same burst window
  assert.equal(emitted.length, 2);
});

test("an error landing after the burst closed (a slow Tier-2 rebuild) is emitted immediately, once", () => {
  const { clock, emitted, collapse, relay } = harness();
  collapse.noteEdit();
  clock.advance(DEMO_EDIT_SETTLE_MS + 5000);
  relay("vite build failed");
  relay("vite build failed");
  assert.deepEqual(emitted, ["vite build failed"]);
});

test("reset counts the outgoing preview's last run and re-arms first-load counting", () => {
  const { clock, emitted, collapse, relay } = harness();
  relay("same shape"); // first load of example A
  collapse.noteEdit();
  relay("pending at switch");
  collapse.reset(); // switch to example B before the burst closed
  assert.deepEqual(emitted, ["same shape", "pending at switch"]);
  assert.equal(clock.pending(), 0, "the settle timer is cancelled, not left to double-fire");
  relay("same shape"); // example B's first load, same fingerprint as A's
  assert.equal(emitted.length, 3);
});

test("reset alone (no edit in between) re-arms first-load counting for the next preview", () => {
  const { emitted, collapse, relay } = harness();
  relay("theme not found"); // example A's first load
  relay("theme not found"); // A re-renders: same burst window, not counted again
  collapse.reset(); // switch to example B
  relay("theme not found"); // B's first load hits the same fault
  assert.deepEqual(emitted, ["theme not found", "theme not found"]);
});

test("the ceiling bounds a demo posting ever-different payloads with no edit", () => {
  const { emitted, relay } = harness();
  for (let i = 0; i < DEMO_COLLAPSE_CEILING + 30; i++) relay(`crafted ${"x".repeat(i)}`);
  assert.equal(emitted.length, DEMO_COLLAPSE_CEILING);
});

test("fingerprintShape is what fingerprint() hashes, so the Faro record and the metric agree", () => {
  for (const message of [
    ...LADDER,
    FINAL,
    "Cannot read properties of undefined (reading 'getData') at https://x.test/a.js?t=1",
    "Invalid language tag: zh-c",
    "hot.getData is not a function",
    "Unexpected token (2:11)\n  1 | function f() {\n> 2 |   return x +;\n    |            ^\n  3 | }",
  ]) {
    const shape = fingerprintShape(message);
    assert.equal(fingerprint("demo-runtime", shape), fingerprint("demo-runtime", message), message);
  }
  // The shape is not the raw message: quoted text, numbers, URLs and code
  // frames (authored code, contract §3) are gone.
  const shape = fingerprintShape(
    "Unexpected token (2:11)\n> 2 |   return secretVar +;\n    |            ^ at 'literal' https://x.test/?k=1",
  );
  assert.ok(!shape.includes("secretVar"), shape);
  assert.ok(!shape.includes("literal"), shape);
  assert.ok(!shape.includes("x.test"), shape);
});

test("demoEventReport names the Faro record by kind, and gives a console warning none", () => {
  const base = { message: "m", tier: 1, framework: "react", htMajor: "18" };
  assert.equal(demoEventReport({ ...base, kind: "error" }).recordName, "DemoError");
  assert.equal(demoEventReport({ ...base, kind: "rejection" }).recordName, "DemoUnhandledRejection");
  assert.equal(demoEventReport({ ...base, kind: "console-error" }).recordName, "DemoConsoleError");
  assert.equal(demoEventReport({ ...base, kind: "console-warn" }).recordName, null);
  assert.equal(demoEventReport({ ...base, kind: "network" }).recordName, "DemoNetworkError");
  assert.equal(demoEventReport({ ...base, kind: "stderr" }).recordName, "DemoStderr");
});

// ---- a compile failure replaces the burst's run ----------------------------
//
// The key `sentry.ts#collapseCompileError` uses: by kind, not by message.
const COMPILE_KEY = "compile:sandpack.compile_error";

function compileHarness() {
  const h = harness();
  /** A compile failure of the newest edit, the way `collapseCompileError` reports it. */
  const compileError = (diagnostic) => h.collapse.report(COMPILE_KEY, `compile: ${diagnostic}`, { replacesRun: true });
  return { ...h, compileError };
}

test("a typed syntax-error ladder is one compile error and no runtime error, stale relays included", () => {
  const { clock, emitted, collapse, relay, compileError } = compileHarness();
  // `const X = ;` typed key by key. `c`..`cons` parse and run (and throw);
  // from `const` on, every prefix fails the pre-transpile.
  for (const prefix of ["c", "co", "con", "cons"]) {
    collapse.noteEdit();
    relay(`${prefix} is not defined`);
  }
  collapse.noteEdit(); // `const`
  // The `cons` run's relay was still in flight at this keystroke (compile
  // slower than the typist) — a known imprecision.
  relay("cons is not defined");
  compileError("Unexpected token (1:5)");
  for (const diagnostic of ["Unexpected token (1:6)", "Missing initializer in const declaration", "Unexpected token (1:12)"]) {
    collapse.noteEdit();
    compileError(diagnostic);
    // A re-render warning / late rung that lands after the compile failure.
    relay('Theme "main" is already registered.');
  }
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, ["compile: Unexpected token (1:12)"], "the final state's compile error, alone");
});

test("a compile error replaces an earlier one of the same burst, so the final state's diagnostic is the one counted", () => {
  const { clock, emitted, collapse, compileError } = compileHarness();
  collapse.noteEdit();
  compileError("stale diagnostic from the previous push");
  compileError("the newest push's diagnostic");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, ["compile: the newest push's diagnostic"]);
});

test("a burst that ends compiling cleanly counts its run's runtime error, not the earlier compile error", () => {
  const { clock, emitted, collapse, relay, compileError } = compileHarness();
  collapse.noteEdit();
  compileError("Unexpected token");
  collapse.noteEdit(); // the line is finished and parses; it throws when it runs
  relay(FINAL);
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, [FINAL]);
});

test("a runtime SyntaxError (JSON.parse) stays a runtime error — only the compile signal replaces a run", () => {
  const { clock, emitted, collapse, relay } = compileHarness();
  const jsonParse = "SyntaxError: Unexpected token } in JSON at position 1";
  collapse.noteEdit();
  relay(jsonParse);
  // The same run's next fault: were the SyntaxError taken for a compile
  // failure (message-shape detection), it would suppress this one.
  relay(FINAL);
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, [jsonParse, FINAL]);
  // And outside a burst (a click that parses bad JSON), at once.
  relay("SyntaxError: Unexpected end of JSON input");
  assert.deepEqual(emitted, [jsonParse, FINAL, "SyntaxError: Unexpected end of JSON input"]);
});

test("a first-load compile failure counts at once, and only once until the next edit", () => {
  const { emitted, collapse, compileError } = compileHarness();
  compileError("Unexpected token");
  assert.deepEqual(emitted, ["compile: Unexpected token"], "no burst open: not held back");
  compileError("Unexpected token"); // a refresh of the same broken demo
  assert.equal(emitted.length, 1);
  collapse.reset(); // the next preview mount
  compileError("Unexpected token");
  assert.equal(emitted.length, 2, "a new mount counts its own first-load failure");
});

test("the next edit re-arms runtime reports after a compile failure", () => {
  const { clock, emitted, collapse, relay, compileError } = compileHarness();
  collapse.noteEdit();
  compileError("Unexpected token");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  // Burst closed: a click in the stale preview that throws still counts.
  relay("stale preview click");
  assert.deepEqual(emitted, ["compile: Unexpected token", "stale preview click"]);
});

test("a stale relay held before the final keystroke's compile failure is dropped by it", () => {
  const { clock, emitted, collapse, relay, compileError } = compileHarness();
  collapse.noteEdit(); // the last keystroke of the line
  relay("cons is not defined"); // the previous run, still in flight
  compileError("Unexpected token (1:12)");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, ["compile: Unexpected token (1:12)"]);
});

// An edit whose sandbox matches the running one (a closing `;`, a space, a
// trailing comma) re-runs nothing, so no later report replaces what that
// edit's `noteEdit` discarded.

test("a burst ending on an edit that re-runs nothing counts the running sandbox's error once", () => {
  const { clock, emitted, collapse, relay } = harness();
  for (const message of LADDER) {
    collapse.noteEdit();
    collapse.pushOutcome("rerun");
    relay(message);
  }
  collapse.noteEdit();
  collapse.pushOutcome("rerun");
  relay(FINAL); // the finished line's run
  collapse.noteEdit(); // the closing `;`
  collapse.pushOutcome("unchanged");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, [FINAL], "the final run's error, and none of the rungs");
});

test("a compile failure undone back to the running sandbox counts that sandbox's error, not the compile error", () => {
  const { clock, emitted, collapse, relay, compileError } = compileHarness();
  collapse.noteEdit();
  collapse.pushOutcome("rerun");
  relay(FINAL);
  collapse.noteEdit(); // a stray `(`
  compileError("Unexpected token");
  relay(FINAL); // the running sandbox, still throwing: suppressed while the newest edit is broken
  collapse.noteEdit(); // deleted again: identical to what runs
  collapse.pushOutcome("unchanged");
  relay("the running sandbox's next fault"); // no longer suppressed: the newest edit compiles
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, [FINAL, "the running sandbox's next fault"]);
});

test("an edit that re-runs nothing does not count the running sandbox's already-counted error again", () => {
  const { clock, emitted, collapse, relay } = harness();
  relay(FINAL); // first load, counted at once
  collapse.noteEdit(); // a space
  collapse.pushOutcome("unchanged");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  collapse.noteEdit();
  collapse.pushOutcome("rerun");
  relay("next run's error");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  collapse.noteEdit();
  collapse.pushOutcome("unchanged");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, [FINAL, "next run's error"]);
});

test("a rerun forgets the previous sandbox's reports, so 'unchanged' brings back only the new run's", () => {
  const { clock, emitted, collapse, relay } = harness();
  collapse.noteEdit();
  collapse.pushOutcome("rerun");
  relay("old run's error");
  collapse.noteEdit();
  collapse.pushOutcome("rerun"); // the finished line runs clean
  collapse.noteEdit();
  collapse.pushOutcome("unchanged");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, []);
});

test("a newest edit that fails to compile still counts one compile error, and 'unchanged' is never its outcome", () => {
  const { clock, emitted, collapse, relay, compileError } = compileHarness();
  collapse.noteEdit();
  collapse.pushOutcome("rerun");
  relay("cons is not defined");
  collapse.noteEdit();
  compileError("Unexpected token (1:12)");
  relay("cons is not defined"); // the running sandbox's late relay
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, ["compile: Unexpected token (1:12)"]);
});

test("reset forgets the outgoing preview's running sandbox", () => {
  const { clock, emitted, collapse, relay } = harness();
  collapse.noteEdit();
  collapse.pushOutcome("rerun");
  relay("outgoing preview's error");
  collapse.noteEdit(); // typed past, then the preview is switched away mid-burst
  collapse.reset();
  collapse.noteEdit(); // the new preview's first edit matches its mounted sandbox
  collapse.pushOutcome("unchanged");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, []);
});

test("a report already counted before a rerun is not brought back by a later unchanged edit", () => {
  const { clock, emitted, collapse, relay } = harness();
  collapse.noteEdit();
  collapse.pushOutcome("rerun");
  collapse.noteEdit();
  relay(FINAL); // the previous run's late relay, before this edit's push dispatches
  collapse.pushOutcome("rerun");
  clock.advance(DEMO_EDIT_SETTLE_MS); // counted
  relay(FINAL); // the new run's own copy, after the burst: already counted
  collapse.noteEdit(); // a space
  collapse.pushOutcome("unchanged");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, [FINAL]);
});

test("a bundler compile error of the running sandbox survives an unchanged edit and still replaces its run", () => {
  const { clock, emitted, collapse, relay } = harness();
  const bundlerError = (d) => collapse.report(COMPILE_KEY, `compile: ${d}`, { replacesRun: true, fromBundler: true });
  collapse.noteEdit();
  collapse.pushOutcome("rerun");
  relay("imp is not defined"); // a stale rung that lands after the dispatch
  bundlerError("Could not find module './missing.css'");
  relay("im is not defined"); // an older rung, later still
  collapse.noteEdit(); // the closing `;`
  collapse.pushOutcome("unchanged");
  relay("imp is not defined"); // still stale: the rejected sandbox never evaluated
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, ["compile: Could not find module './missing.css'"]);
});

test("a rerun forgets the previous sandbox's bundler compile error, and records the new run's reports", () => {
  const { clock, emitted, collapse, relay } = harness();
  collapse.noteEdit();
  collapse.pushOutcome("rerun");
  collapse.report(COMPILE_KEY, "compile: bundler", { replacesRun: true, fromBundler: true });
  collapse.noteEdit();
  collapse.pushOutcome("rerun"); // the fixed import builds, runs and throws
  relay(FINAL);
  collapse.noteEdit();
  collapse.pushOutcome("unchanged");
  clock.advance(DEMO_EDIT_SETTLE_MS);
  assert.deepEqual(emitted, [FINAL]);
});
