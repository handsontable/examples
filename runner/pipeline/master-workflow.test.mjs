// Structural pins for two minor-triage fixes in `.github/workflows/master.yml`
// (repo root, not `runner/` — that file is shared by the whole examples repo,
// not owned by the runner package). Nothing else in `pipeline/` reads this
// file directly, so these are new coverage, not an extension of an existing
// suite. Same style as `pipeline/mcp-create.test.mjs`'s "the update route
// calls isMcpCreated()" test: the fact is structural (workflow YAML, not
// something `actionlint` checks the SEMANTICS of), so the file is read as
// text and the exact shape is asserted.
//
// Run: node --experimental-strip-types --test pipeline/master-workflow.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflowPath = join(import.meta.dirname, "..", "..", ".github", "workflows", "master.yml");
const source = readFileSync(workflowPath, "utf8");

// Minor triage item 1: a modern AWS CLI defaults to a CRC32 trailing
// checksum on every request and validates one on every response; R2's S3
// API doesn't implement that trailer, so the source-maps upload could be
// rejected outright. Both env vars must be `when_required` on the exact
// `aws s3 cp` step. Reverting either line (dropping the var, or its value)
// makes the matching assertion fail.
test("master.yml: the R2 maps-upload step sets both AWS checksum env vars to when_required", () => {
  const stepStart = source.indexOf('name: Upload source maps to R2, then remove them from dist');
  assert.ok(stepStart > -1, "the R2 maps-upload step exists in master.yml");
  const stepEnd = source.indexOf("\n      - name:", stepStart);
  const step = source.slice(stepStart, stepEnd > -1 ? stepEnd : undefined);

  assert.match(
    step,
    /AWS_REQUEST_CHECKSUM_CALCULATION:\s*when_required/,
    "AWS_REQUEST_CHECKSUM_CALCULATION must be when_required on this step",
  );
  assert.match(
    step,
    /AWS_RESPONSE_CHECKSUM_VALIDATION:\s*when_required/,
    "AWS_RESPONSE_CHECKSUM_VALIDATION must be when_required on this step",
  );
});

// Minor triage item 6: `deploy-api`'s `if:` used to read
// `always() && needs.changes.outputs.api == 'true' && ... != 'failure'` —
// `always()` also runs the job when `deploy-o11y` was CANCELLED (a distinct
// GitHub Actions result from `failure`), so a manually cancelled
// `deploy-o11y` run still let `deploy-api` proceed. `!cancelled()` in place
// of `always()` refuses that case while still running normally after an
// ordinary success, skip, or the already-handled `failure`.
test("master.yml: deploy-api's if condition refuses to run after deploy-o11y was cancelled", () => {
  const jobStart = source.indexOf("\n  deploy-api:");
  assert.ok(jobStart > -1, "the deploy-api job exists in master.yml");
  const ifStart = source.indexOf("if:", jobStart);
  const ifEnd = source.indexOf("runs-on:", ifStart);
  const ifBlock = source.slice(ifStart, ifEnd);

  assert.match(ifBlock, /!cancelled\(\)/, "deploy-api's if: must gate on !cancelled()");
  assert.doesNotMatch(
    ifBlock,
    /\balways\(\)/,
    "always() would also run this job after deploy-o11y was cancelled — must not still be present",
  );
  assert.match(
    ifBlock,
    /needs\.deploy-o11y\.result\s*!=\s*'failure'/,
    "the existing failure guard must still be present alongside the cancellation guard",
  );
});
