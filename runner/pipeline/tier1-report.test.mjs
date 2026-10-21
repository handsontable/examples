import test from "node:test";
import assert from "node:assert/strict";
import { tier1Report } from "../apps/authoring/src/tier1Report.ts";
import { isOpaqueNetworkFailure } from "../apps/authoring/src/fetchFailure.ts";

// DEV-2569 / DEMOS-15. Two populations — our own compiler chunk failing to load, and
// bundler diagnostics over the visitor's half-typed source — must stay apart, each under a
// constant title, so neither a visitor's typo nor one deploy's chunk name becomes a class.

const CODE_FRAME = `/src/main.ts: Unexpected token (3:1)
  1 | const hot = new Handsontable(el, {
> 3 | )
    | ^`;

const compile = (over = {}) => ({
  name: "SandpackCompileError",
  message: CODE_FRAME,
  compilerUnavailable: false,
  monitorDemos: true,
  ...over,
});

const compilerAsset = (over = {}) => ({
  name: "CompilerUnavailableError",
  message: "Failed to fetch dynamically imported module: https://demos.handsontable.com/assets/babel-CRE6e0VF.js",
  compilerUnavailable: true,
  replay: false,
  online: true,
  monitorDemos: true,
  ...over,
});

test("an evaluated throw is not reported here at all", () => {
  // DEV-2552: the in-preview reporter owns it, with a stack that points at the demo.
  assert.equal(tier1Report(compile({ name: "SandpackEvaluationError" })), null);
});

test("a visitor compile error is dropped while demo monitoring is off", () => {
  assert.equal(tier1Report(compile({ monitorDemos: false })), null);
});

test("the compiler asset is reported even with demo monitoring off", () => {
  // The flag is DEV-2527 instrumentation that can be turned off. Our own asset failing
  // to load is not demo monitoring and must outlive it.
  const r = tier1Report(compilerAsset({ monitorDemos: false }));
  assert.ok(r, "turning the DEV-2527 flag off must not silence this");
  assert.equal(r.tags.context, "tier1-compiler-asset");
});

test("the two populations are titled apart", () => {
  const infra = tier1Report(compilerAsset());
  const visitor = tier1Report(compile());
  // Both titles feed the contract fingerprint, so neither may drift.
  assert.deepEqual(infra.synthesizeAs, {
    name: "CompilerUnavailableError",
    message: "Tier-1 preview compiler asset failed to load",
  });
  assert.deepEqual(visitor.synthesizeAs, { name: "Tier1CompileError", message: "Tier-1 compile failed" });
  assert.notDeepEqual(infra.synthesizeAs, visitor.synthesizeAs);
});

test("the compiler-asset branch stays off the demo-runtime surface", () => {
  // `surface: "demo-runtime"` is where visitor noise lives. A fault that is ours belongs
  // beside the container ones, which tag `context:`.
  const r = tier1Report(compilerAsset());
  assert.equal(r.tags.surface, undefined);
  assert.equal(r.tags.context, "tier1-compiler-asset");
  assert.equal(tier1Report(compile()).tags.surface, "demo-runtime");
});

test("two different code frames produce the same title", () => {
  const a = tier1Report(compile({ message: "/src/main.ts: Unexpected token (3:1)" }));
  const b = tier1Report(compile({ message: "/src/app.tsx: alignHeadersTypo is not defined" }));
  assert.deepEqual(a.synthesizeAs, b.synthesizeAs, "the title must name the class, not one typo");
});

test("the code frame never reaches the title", () => {
  const r = tier1Report(compile());
  assert.ok(!r.synthesizeAs.message.includes("Unexpected token"));
});

test("the chunk URL never reaches the title", () => {
  const r = tier1Report(compilerAsset());
  assert.doesNotMatch(r.synthesizeAs.message, /https?:/, "a hashed URL in the title names one deploy's sample");
});

test("a latched replay is not a second event", () => {
  // The loader re-throws its terminal error on every later compile. The shell has already
  // reported and carded the discovery; one fault must not become one event per keystroke.
  assert.equal(tier1Report(compilerAsset({ replay: true })), null);
});

test("an offline visitor is not filed as our fault", () => {
  // This branch has no flag gate, so the one signal that separates "our asset is gone" from
  // "this visitor has no network" is spent before the record is sent.
  assert.equal(tier1Report(compilerAsset({ online: false })), null);
  assert.ok(tier1Report(compilerAsset({ online: true })), "and `true` proves nothing, so it reports");
});

test("a compiler failure whose cause named no URL still reports", () => {
  // Safari says "Load failed" and names nothing.
  const r = tier1Report(compilerAsset({ message: "Load failed" }));
  assert.ok(r);
  assert.equal(r.tags.context, "tier1-compiler-asset");
});

// A transport failure is not a diagnostic about the visitor's code, and `sandpack.bundler_unreachable` already counts it.
test("the mount's opaque transport failure is not a compile error report", () => {
  assert.equal(
    tier1Report(compile({ name: "TypeError", message: "Failed to fetch", opaqueNetworkFailure: true })),
    null,
  );
});

// Mirrors the App.tsx call site: `opaqueNetworkFailure: isOpaqueNetworkFailure(e)`.
const factsFor = (e) => compile({
  name: e.name,
  message: e.message,
  opaqueNetworkFailure: isOpaqueNetworkFailure(e),
});

test("a real `TypeError: Failed to fetch` runs through the classifier and is not reported", () => {
  assert.equal(tier1Report(factsFor(new TypeError("Failed to fetch"))), null);
});

test("a real compile error runs through the classifier and is still reported", () => {
  const err = new Error(CODE_FRAME);
  err.name = "SandpackCompileError";
  assert.ok(tier1Report(factsFor(err)));
});

test("a visitor compile error is still reported when the transport flag is false or absent", () => {
  assert.ok(tier1Report(compile({ opaqueNetworkFailure: false })));
  assert.ok(tier1Report(compile()));
});

test("the transport stand-down does not cover the compiler-asset branch", () => {
  assert.ok(tier1Report(compilerAsset({ opaqueNetworkFailure: true })));
});

test("every tag value is a non-empty string", () => {
  for (const facts of [compile(), compilerAsset()]) {
    const r = tier1Report(facts);
    for (const [k, v] of Object.entries(r.tags)) {
      assert.equal(typeof v, "string", `${k} must be a string`);
      assert.ok(v.length > 0, `${k} must not be empty`);
    }
  }
});
