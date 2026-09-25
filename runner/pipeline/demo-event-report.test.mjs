import test from "node:test";
import assert from "node:assert/strict";
import { demoEventReport } from "../apps/authoring/src/demoEventReport.ts";
import { fingerprint } from "../packages/runtime/dist/telemetry/index.js";

// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build` (for the
// `fingerprint` import used to prove the ladder-collapsing claim below).
//
// ADR §E.1 "Moves to the new stack only": demo-runtime preview events now
// leave Sentry entirely and become one `preview.runtime_error` count through
// the facade. `demoEventReport.ts` is the pure decision `sentry.ts#reportDemoEvent`
// delegates to — see its own header for why it is import-free.

test("error and rejection both map to reason 'uncaught'", () => {
  const facts = { kind: "error", message: "boom", tier: 1, framework: "react", htMajor: "18" };
  assert.equal(demoEventReport(facts).reason, "uncaught");
  assert.equal(demoEventReport({ ...facts, kind: "rejection" }).reason, "uncaught");
});

test("console-error and console-warn both map to reason 'console'", () => {
  const facts = { kind: "console-error", message: "warn", tier: 1, framework: "react", htMajor: "18" };
  assert.equal(demoEventReport(facts).reason, "console");
  assert.equal(demoEventReport({ ...facts, kind: "console-warn" }).reason, "console");
});

test("network maps to 'network', stderr maps to 'stderr'", () => {
  assert.equal(
    demoEventReport({ kind: "network", message: "m", tier: 1, framework: "react", htMajor: "18" }).reason,
    "network",
  );
  assert.equal(
    demoEventReport({ kind: "stderr", message: "m", tier: 2, framework: "angular", htMajor: "17" }).reason,
    "stderr",
  );
});

test("only console-warn is budgeted against the looser breadcrumb cap", () => {
  const kinds = ["error", "rejection", "console-error", "network", "stderr"];
  for (const kind of kinds) {
    assert.equal(
      demoEventReport({ kind, message: "m", tier: 1, framework: "react", htMajor: "18" }).budget,
      "relay",
      `kind=${kind}`,
    );
  }
  assert.equal(
    demoEventReport({ kind: "console-warn", message: "m", tier: 1, framework: "react", htMajor: "18" }).budget,
    "breadcrumb",
  );
});

test("attrs carry surface=demo-runtime, the stringified tier, framework, and ht_major", () => {
  const report = demoEventReport({ kind: "error", message: "m", tier: 2, framework: "vue", htMajor: "17" });
  assert.deepEqual(report.attrs, { surface: "demo-runtime", tier: "2", framework: "vue", ht_major: "17" });
});

// F10a (W-triage): the `tier1-playground` dashboard's "preview.runtime_error
// rate by reason" panel filters `blob7 IN (${ht_major:sqlstring})`. Without
// `ht_major` on the attrs, every row lands with blob7 = '' and the panel is
// permanently empty. This proves the value survives, not just the key.
test("ht_major carries the caller's actual value through to attrs (contract §5 / F10a)", () => {
  for (const htMajor of ["15", "16", "17", "18", "19", "next", "none"]) {
    const report = demoEventReport({ kind: "error", message: "m", tier: 1, framework: "react", htMajor });
    assert.equal(report.attrs.ht_major, htMajor, `htMajor=${htMajor}`);
  }
});

test("demoId, when present, becomes attrs.demo_id — and is omitted when absent/null", () => {
  const withId = demoEventReport({
    kind: "error",
    message: "m",
    tier: 1,
    framework: "react",
    htMajor: "18",
    demoId: "abc123",
  });
  assert.equal(withId.attrs.demo_id, "abc123");

  const withoutId = demoEventReport({ kind: "error", message: "m", tier: 1, framework: "react", htMajor: "18" });
  assert.equal("demo_id" in withoutId.attrs, false);

  const nullId = demoEventReport({
    kind: "error",
    message: "m",
    tier: 1,
    framework: "react",
    htMajor: "18",
    demoId: null,
  });
  assert.equal("demo_id" in nullId.attrs, false);
});

test("fingerprintContext is always 'demo-runtime' — the surface, never the kind", () => {
  for (const kind of ["error", "rejection", "console-error", "console-warn", "network", "stderr"]) {
    assert.equal(
      demoEventReport({ kind, message: "m", tier: 1, framework: "react", htMajor: "18" }).fingerprintContext,
      "demo-runtime",
    );
  }
});

test("fingerprintMessage is the raw message, unnormalised — the caller runs fingerprint()", () => {
  const report = demoEventReport({
    kind: "error",
    message: "licenseKey is not defined",
    tier: 1,
    framework: "react",
    htMajor: "18",
  });
  assert.equal(report.fingerprintMessage, "licenseKey is not defined");
});

// The decisive claim (task acceptance criteria): "a demo-runtime keystroke
// ladder becomes one deduplicated count in Faro" — proven here as "the same
// fingerprint," via the real contract `fingerprint()` (T00), not a re-implementation.
test("a keystroke ladder collapses to one fingerprint (the actual contract dedupe)", () => {
  const ladder = ["l is not defined", "li is not defined", "lic is not defined", "licenseKey is not defined"];
  const fingerprints = ladder.map((message) => {
    const report = demoEventReport({ kind: "error", message, tier: 1, framework: "react", htMajor: "18" });
    return fingerprint(report.fingerprintContext, report.fingerprintMessage);
  });
  assert.equal(new Set(fingerprints).size, 1, "every ladder rung must fingerprint identically");

  // A genuinely different failure must NOT collapse into the same bucket —
  // guards against a fingerprint function that has gone trivial (e.g. a
  // constant), which would make the assertion above pass for the wrong reason.
  const different = demoEventReport({
    kind: "error",
    message: "Cannot read properties of undefined (reading 'foo')",
    tier: 1,
    framework: "react",
    htMajor: "18",
  });
  assert.notEqual(
    fingerprint(different.fingerprintContext, different.fingerprintMessage),
    fingerprints[0],
  );
});
