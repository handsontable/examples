import test from "node:test";
import assert from "node:assert/strict";
import { tier1Report } from "../apps/authoring/src/tier1Report.ts";

// DEV-2569 / Sentry DEMOS-15. One issue held two populations — our own compiler chunk
// failing to load, and bundler diagnostics over the visitor's half-typed source — and the
// issue title named whichever event arrived most recently. These are the grouping rules
// that separate them and keep both titles constant.

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
  message: "the in-browser compiler could not be loaded",
  compilerUnavailable: true,
  assetUrl: "https://demos.handsontable.com/assets/babel-CRE6e0VF.js",
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
  // The flag is DEV-2527 instrumentation with a documented teardown. Our own asset failing
  // to load is not demo monitoring and must outlive it.
  const r = tier1Report(compilerAsset({ monitorDemos: false }));
  assert.ok(r, "removing the DEV-2527 flag must not silence this");
  assert.deepEqual(r.fingerprint, ["tier1-compiler-asset"]);
});

test("the two populations do not share a fingerprint", () => {
  const infra = tier1Report(compilerAsset());
  const visitor = tier1Report(compile());
  assert.deepEqual(visitor.fingerprint, ["demo-runtime", "sandpack-compile"], "unchanged, so DEMOS-15 does not regroup");
  assert.notDeepEqual(infra.fingerprint, visitor.fingerprint);
});

test("the compiler-asset branch stays out of the demo-runtime environment", () => {
  // `beforeSend` in sentry.ts re-homes any event tagged `surface: "demo-runtime"` into the
  // demo-runtime environment — the bucket visitor noise lives in. A fault that is ours
  // belongs beside the container ones, which tag `context:`.
  const r = tier1Report(compilerAsset());
  assert.equal(r.tags.surface, undefined);
  assert.equal(r.tags.context, "tier1-compiler-asset");
  assert.equal(r.level, "error", "ours to fix, not product output");
  assert.equal(tier1Report(compile()).level, "warning");
});

test("two different code frames produce the same title", () => {
  const a = tier1Report(compile({ message: "/src/main.ts: Unexpected token (3:1)" }));
  const b = tier1Report(compile({ message: "/src/app.tsx: alignHeadersTypo is not defined" }));
  assert.deepEqual(a.synthesizeAs, b.synthesizeAs, "the issue title must name the class, not one typo");
  assert.notEqual(a.extra.compileDiagnostic, b.extra.compileDiagnostic, "while the diagnostic stays per event");
});

test("the diagnostic reaches extra, and nothing else", () => {
  const r = tier1Report(compile());
  assert.equal(r.extra.compileDiagnostic, CODE_FRAME);
  assert.ok(!r.synthesizeAs.message.includes("Unexpected token"));
  assert.ok(!r.fingerprint.join("|").includes("Unexpected token"));
});

test("the chunk URL rides in extra, never in the title or the fingerprint", () => {
  const r = tier1Report(compilerAsset());
  assert.equal(r.extra.assetUrl, "https://demos.handsontable.com/assets/babel-CRE6e0VF.js");
  assert.doesNotMatch(r.synthesizeAs.message, /https?:/, "a hashed URL in the title names one deploy's sample");
  assert.doesNotMatch(r.fingerprint.join("|"), /https?:/, "and in the fingerprint it would open a new issue per deploy");
});

test("a compiler failure whose cause named no URL still reports", () => {
  // Safari says "Load failed" and names nothing.
  const r = tier1Report(compilerAsset({ assetUrl: null }));
  assert.ok(r);
  assert.equal(r.extra.assetUrl, undefined, "an absent URL must not become the string \"null\"");
  assert.deepEqual(r.fingerprint, ["tier1-compiler-asset"]);
});

test("every tag value is a non-empty string", () => {
  for (const facts of [compile(), compilerAsset()]) {
    const r = tier1Report(facts);
    for (const [k, v] of Object.entries(r.tags)) {
      assert.equal(typeof v, "string", `${k} must be a string`);
      assert.ok(v.length > 0, `${k} must not be empty`);
    }
    for (const [k, v] of Object.entries(r.extra)) {
      assert.equal(typeof v, "string", `extra.${k} must be a string`);
    }
  }
});
