// Guard for `.github/workflows/e2e-o11y-local.yml`: reads a Playwright JSON
// reporter output and fails loudly when the gated run did not actually
// exercise any tests, or silently skipped every one of them — the exact
// failure shape a mistyped/missing env gate (E2E_LIVE, E2E_TELEMETRY,
// E2E_O11Y_LOCAL) produces: `playwright test` still exits 0 (every test
// `test.skip()`s itself cleanly), so the step above this one reads as a
// pass with zero real coverage. docs/TESTING.md's "every gate must have a
// workflow home" rule is only true in practice if the workflow provably RAN
// the gated tests — this is that proof, not just a green exit code.
//
// Usage: node scripts/ci/assert-e2e-ran.mjs <report.json>
// Run from `runner/` (the working directory Playwright's
// PLAYWRIGHT_JSON_OUTPUT_NAME wrote the file into).

import { readFileSync } from "node:fs";

const [, , reportPath] = process.argv;
if (!reportPath) {
  console.error("usage: node scripts/ci/assert-e2e-ran.mjs <report.json>");
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const stats = report.stats ?? {};
const expected = stats.expected ?? 0;
const skipped = stats.skipped ?? 0;
const unexpected = stats.unexpected ?? 0;

console.log(`e2e report: expected=${expected} skipped=${skipped} unexpected=${unexpected} (${reportPath})`);

if (expected === 0) {
  console.error(
    "::error::0 tests were expected to run — the gate env var is almost certainly missing or misspelled " +
      "(every test.skip()'d itself, and `playwright test` still exits 0 for that).",
  );
  process.exit(1);
}
if (skipped > 0) {
  console.error(
    `::error::${skipped} test(s) were skipped — a gate condition inside the spec file itself did not ` +
      "evaluate the way this workflow's env vars intend. Check the spec's test.skip(...) condition.",
  );
  process.exit(1);
}
if (unexpected > 0) {
  // Belt and suspenders: the e2e step's own non-zero exit already fails the
  // job on a real test failure, so reaching here with unexpected > 0 should
  // never happen — but never let a report-parsing quirk mask a real failure.
  console.error(`::error::${unexpected} unexpected result(s) in the report — treating as a failure.`);
  process.exit(1);
}

console.log("ok — the gate ran real tests, none skipped.");
