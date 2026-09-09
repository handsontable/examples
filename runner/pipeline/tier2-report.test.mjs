import test from "node:test";
import assert from "node:assert/strict";
import { tier2StderrReport } from "../apps/authoring/src/tier2Report.ts";

// DEV-2854 / Sentry DEMOS-3K, DEMOS-3M, DEMOS-4F, DEMOS-3H and friends. Tier-2 compiler
// diagnostics were fingerprinted per (already-collapsed-per-code) message, so a bad
// Angular-editing session opened one issue per TS diagnostic code and each issue's title
// named whichever sample arrived last. These are the grouping rules that flatten the
// bucket across codes and keep the title constant.

const TS1005 = `✘ [ERROR] TS1005: ',' expected. [plugin angular-compiler]`;
const TS1005B = `✘ [ERROR] TS1005: ')' expected. [plugin angular-compiler]`;
const TS2304 = `✘ [ERROR] TS2304: Cannot find name '$B$4'. [plugin angular-compiler]`;
const TS7006 = `✘ [ERROR] TS7006: Parameter 'amount' implicitly has an 'any' type. [plugin angular-compiler]`;
const TS1109 = `✘ [ERROR] TS1109: Expression expected. [plugin angular-compiler]`;
const NOCODE = `✘ [ERROR] Unexpected "}"`;
const NG8001 = `✘ [ERROR] NG8001: 'hot-table' is not a known element:`;
const NG8002 = `✘ [ERROR] NG8002: Can't bind to 'settings' since it isn't a known property of 'hot-table'.`;
const FAILURE = `Failure reason:`;
const RESOLVE = `✘ [ERROR] Could not resolve "./app/App"`;
// A truncated, repeated diagnostic block — the DEMOS-52 shape. Two occurrences of the
// *same* code, so this is not the "more than one distinct code" case, but the raw text
// carries the code twice, which the multi-code-detection logic must not mistake for two
// distinct codes.
const TS2345_REPEATED =
  `✘ [ERROR] TS2345: Argument of type 'string' is not assignable to parameter of type 'number'. […] ` +
  `✘ [ERROR] TS2345: Argument of type 'string' is not assignable to parameter of type 'number'. […]`;
// A line naming two genuinely distinct codes.
const TS_MULTI_CODE = `${TS1005} ${TS2304}`;

// --- Load-bearing: demonstrably false on master, true after ---------------------------

test("TS1005 and TS2304 share one fingerprint (cross-code-spread defect)", () => {
  const a = tier2StderrReport("stderr", TS1005);
  const b = tier2StderrReport("stderr", TS2304);
  assert.deepEqual(a.fingerprint, b.fingerprint);
  assert.deepEqual(a.fingerprint, ["demo-runtime", "stderr", "tier2-compile"]);
});

test("the display string is the same constant across TS1005 / TS2304 / TS7006 / TS1109 (title-flap defect)", () => {
  const displays = [TS1005, TS2304, TS7006, TS1109].map(
    (message) => tier2StderrReport("stderr", message).display,
  );
  assert.deepEqual(new Set(displays), new Set(["Tier-2 compile failed"]));
  // On master this equals the raw message, so it is not constant across samples.
  assert.notEqual(tier2StderrReport("stderr", TS1005).display, TS1005);
});

// --- Behavioural contract ---------------------------------------------------------------

test("the raw line reaches extra.compileDiagnostic verbatim, and nowhere else", () => {
  const r = tier2StderrReport("stderr", TS1005);
  assert.equal(r.extra.compileDiagnostic, TS1005);
  assert.equal(r.display, "Tier-2 compile failed");
  assert.ok(!r.display.includes(TS1005));
  assert.ok(!r.fingerprint.join("|").includes(TS1005));
  assert.ok(!r.fingerprint.join("|").includes("TS1005"));
});

test("ts_code is set from the diagnostic and is absent from the fingerprint", () => {
  const a = tier2StderrReport("stderr", TS1005);
  const b = tier2StderrReport("stderr", TS7006);
  assert.equal(a.tags.ts_code, "TS1005");
  assert.equal(b.tags.ts_code, "TS7006");
  assert.ok(!a.fingerprint.includes("TS1005"));
  assert.ok(!b.fingerprint.includes("TS7006"));
});

test("a line with more than one distinct code gets the flat fingerprint but no ts_code tag", () => {
  const r = tier2StderrReport("stderr", TS_MULTI_CODE);
  assert.deepEqual(r.fingerprint, ["demo-runtime", "stderr", "tier2-compile"]);
  assert.equal(r.tags.ts_code, undefined, "first-match-wins is rejected in favour of omitting");
});

test("a repeated occurrence of the same code is still a single distinct code", () => {
  const r = tier2StderrReport("stderr", TS2345_REPEATED);
  assert.equal(r.tags.ts_code, "TS2345");
});

test("TS1005 and TS1005B (different messages, same code) already share a fingerprint via the existing quoted-string rule", () => {
  // This was already true on master through normalizeMonitorMessage; asserting it here
  // pins that the new flat fingerprint does not accidentally split same-code samples.
  const a = tier2StderrReport("stderr", TS1005);
  const b = tier2StderrReport("stderr", TS1005B);
  assert.deepEqual(a.fingerprint, b.fingerprint);
  assert.equal(a.tags.ts_code, b.tags.ts_code);
});

// --- Contract / over-widening guards ----------------------------------------------------
// These pass either way today (the allowlist already excludes them) — they are not
// fix-provers. Their job is to fail if this module is ever rewritten from an allowlist to
// a denylist and one of these populations is accidentally swept in.

test("guard: a line with no TS code returns null", () => {
  assert.equal(tier2StderrReport("stderr", NOCODE), null);
});

test("guard: NG8001 / NG8002 (Angular template diagnostics, plausibly ours) return null", () => {
  assert.equal(tier2StderrReport("stderr", NG8001), null);
  assert.equal(tier2StderrReport("stderr", NG8002), null);
});

test("guard: 'Failure reason:' and 'Could not resolve' return null", () => {
  assert.equal(tier2StderrReport("stderr", FAILURE), null);
  assert.equal(tier2StderrReport("stderr", RESOLVE), null);
});

test("guard: a bare TS code not in diagnostic position does not match", () => {
  assert.equal(tier2StderrReport("stderr", "See TS1005 in the manual for details"), null);
});

test("guard: kind !== 'stderr' returns null even with a recognised code", () => {
  assert.equal(tier2StderrReport("console-error", TS1005), null);
  assert.equal(tier2StderrReport("error", TS1005), null);
});
