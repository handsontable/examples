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
// F26: typing one throwing line into a Tier-1 editor relayed ~20
// `preview.runtime_error` points (one per half-typed prefix). The collapse
// must turn that into one point per edit burst, while a non-edit error still
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
