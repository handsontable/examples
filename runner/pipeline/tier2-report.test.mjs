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

// DEV-2876 / Sentry DEMOS-5Q, DEMOS-53, DEMOS-4Y, DEMOS-4W, DEMOS-4V. The build-failure
// envelope's fingerprint was already flattened by `normalizeMonitorMessage`'s ISO rule
// (commit `2464f3325`), but the raw line — duration and timestamp included — was still the
// title, so each bucket was permanently named after whichever sample arrived last. DEMOS-5Q
// is frozen at the exact `BUNDLE_5Q` string below.

const BUNDLE_5Q = `Application bundle generation failed. [0.505 seconds] - 2026-09-02T07:40:26.664Z`;
const BUNDLE_4V = `Application bundle generation failed. [1.595 seconds] - 2026-08-27T14:20:04.952Z`;
// No timing suffix at all — a toolchain version that drops it must still collapse.
const BUNDLE_NO_TIMING = `Application bundle generation failed.`;
// The success sibling: differs from the failure sentence in one word, so the anchor's
// literal `\.` (not `.`) is what keeps this from matching.
const BUNDLE_COMPLETE = `Application bundle generation complete. [0.412 seconds] - 2026-09-02T07:41:01.112Z`;
// A mid-line mention, not a line that opens with the sentence — the `^` anchor is what
// excludes this, and `container.ts`'s `line = raw.trim()` is what makes anchoring safe.
const BUNDLE_IN_PROSE = `esbuild said Application bundle generation failed. earlier`;
// Real boot-script narration from `container.ts` (`::frozen install failed for custom
// metadata; retrying non-frozen::`) — one of the `::…::` install-failure markers the
// existing allowlist already excludes by construction; re-asserted here against both
// recognisers, not just the compile one.
const FROZEN_RETRY = `::frozen install failed for custom metadata; retrying non-frozen::`;
// Real vite dev-server output (see `pipeline/monitor-stderr-relay.test.mjs`) — internal to
// vite, not a TS diagnostic and not a build envelope.
const VITE_INTERNAL = `[vite] Internal server error: hot is not defined`;
// A single stderr line carrying both recognised shapes — reachable via a forged
// `postMessage`, not merely theoretical (`kind: "stderr"` is one of the fixed
// `MONITOR_KINDS`). Tie-break goes to the compile branch: it is checked first.
const ENVELOPE_PLUS_TS = `${BUNDLE_5Q} ${TS1005}`;

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

// --- DEV-2876: build-failure envelope ----------------------------------------------------
// --- Load-bearing: demonstrably false on master, true after ---------------------------

test("DEMOS-5Q and DEMOS-4V share one fingerprint, equal to the tier2-build fingerprint", () => {
  // The flat grouping itself already shipped in `2464f3325` via `normalizeMonitorMessage`'s
  // ISO rule — this pins that the explicit fingerprint below does not re-shard what that
  // rule already collapsed.
  const a = tier2StderrReport("stderr", BUNDLE_5Q);
  const b = tier2StderrReport("stderr", BUNDLE_4V);
  assert.deepEqual(a.fingerprint, b.fingerprint);
  assert.deepEqual(a.fingerprint, ["demo-runtime", "stderr", "tier2-build"]);
});

test("the display string is the same constant across BUNDLE_5Q / BUNDLE_4V / BUNDLE_NO_TIMING, and is not the raw message", () => {
  const displays = [BUNDLE_5Q, BUNDLE_4V, BUNDLE_NO_TIMING].map(
    (message) => tier2StderrReport("stderr", message).display,
  );
  assert.deepEqual(new Set(displays), new Set(["Tier-2 build failed"]));
  // On master this equals the raw message (in fact tier2StderrReport returns null and
  // `display` doesn't exist at all), so it is not constant across samples today.
  assert.notEqual(tier2StderrReport("stderr", BUNDLE_5Q).display, BUNDLE_5Q);
});

test("the envelope fingerprint and display differ from the compile branch's", () => {
  const build = tier2StderrReport("stderr", BUNDLE_5Q);
  const compile = tier2StderrReport("stderr", TS1005);
  assert.notDeepEqual(build.fingerprint, compile.fingerprint);
  assert.notEqual(build.display, compile.display);
});

test("the raw envelope line reaches extra.buildFailure verbatim, and nowhere else", () => {
  const r = tier2StderrReport("stderr", BUNDLE_5Q);
  assert.equal(r.extra.buildFailure, BUNDLE_5Q);
  assert.equal(r.display, "Tier-2 build failed");
  assert.ok(!r.display.includes("0.505"));
  assert.ok(!r.display.includes("2026-09-02"));
  assert.ok(!r.fingerprint.join("|").includes("0.505"));
  assert.ok(!r.fingerprint.join("|").includes("2026-09-02"));
  // Pins the no-duration-tag decision so a later "helpful" addition fails here.
  assert.equal(r.tags.build_duration, undefined);
});

test("the envelope is tagged tier2-build and carries no ts_code", () => {
  const r = tier2StderrReport("stderr", BUNDLE_5Q);
  assert.equal(r.tags.kind_class, "tier2-build");
  assert.equal(r.tags.ts_code, undefined);
});

// --- Guards: pass either way today, exist to fail on a future denylist / anchor slip ----

test("guard: 'Application bundle generation complete.' and a mid-line mention both return null", () => {
  assert.equal(tier2StderrReport("stderr", BUNDLE_COMPLETE), null);
  assert.equal(tier2StderrReport("stderr", BUNDLE_IN_PROSE), null);
});

test("guard: FROZEN_RETRY, VITE_INTERNAL, RESOLVE, NG8001, NG8002, and 'Failure reason:' all return null", () => {
  // Deliberately overlaps the existing guards above (`:98-106`-ish): those were written
  // against one recogniser, this re-asserts them against two.
  assert.equal(tier2StderrReport("stderr", FROZEN_RETRY), null);
  assert.equal(tier2StderrReport("stderr", VITE_INTERNAL), null);
  assert.equal(tier2StderrReport("stderr", RESOLVE), null);
  assert.equal(tier2StderrReport("stderr", NG8001), null);
  assert.equal(tier2StderrReport("stderr", NG8002), null);
  assert.equal(tier2StderrReport("stderr", FAILURE), null);
});

test("guard: kind other than 'stderr' returns null even with a recognised envelope", () => {
  assert.equal(tier2StderrReport("console-error", BUNDLE_5Q), null);
  assert.equal(tier2StderrReport("error", BUNDLE_5Q), null);
});

// --- Order guard: TS-first is load-bearing, not a specificity claim ---------------------

test("order guard: a line carrying both shapes resolves as the compile branch, not the build branch", () => {
  // Passes on revert too (still matches the TS regex on its own) — it exists to fail if
  // someone reorders the branches so the build check runs first.
  const r = tier2StderrReport("stderr", ENVELOPE_PLUS_TS);
  assert.deepEqual(r.fingerprint, ["demo-runtime", "stderr", "tier2-compile"]);
  assert.equal(r.tags.ts_code, "TS1005");
});
