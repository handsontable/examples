// Structural pins for `.github/workflows/master.yml` (repo root, not
// `runner/` — that file is shared by the whole examples repo, not owned by
// the runner package). Same style as `pipeline/mcp-create.test.mjs`'s "the
// update route calls isMcpCreated()" test: the fact is structural (workflow
// YAML, not something `actionlint` checks the semantics of), so the file
// is read as text and the exact shape is asserted.
// Run: node --experimental-strip-types --test pipeline/master-workflow.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflowPath = join(import.meta.dirname, "..", "..", ".github", "workflows", "master.yml");
const source = readFileSync(workflowPath, "utf8");

// A modern AWS CLI defaults to a CRC32 trailing checksum on every request
// and validates one on every response; R2's S3 API doesn't implement that
// trailer, so the source-maps upload could be rejected outright unless
// both env vars are `when_required` on the exact `aws s3 cp` step.
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

// `always() && needs.changes.outputs.api == 'true' && ... != 'failure'`
// still runs the job when `deploy-o11y` was cancelled (a distinct GitHub
// Actions result from `failure`), so a manually cancelled `deploy-o11y`
// run would still let `deploy-api` proceed. `!cancelled()` in place of
// `always()` refuses that case while still running normally after an
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

// Each deploy step's `Current Version ID:` grep runs under
// `set -o pipefail`. If wrangler's own output wording ever changes, the
// grep finds nothing and exits 1; without `|| true` that failure
// propagates through the pipe and the `$(...)` assignment, failing the
// step — and the job — even though the deploy already shipped, skipping
// the deploy-event report and the smoke test that follow.
test("master.yml: every 'Current Version ID:' grep is guarded with || true", () => {
  const lines = [...source.matchAll(/^.*version_id=\$\(grep -oE 'Current Version ID:.*$/gm)].map((m) => m[0]);
  assert.ok(lines.length >= 3, "expected at least 3 deploy steps (authoring, api, o11y) to extract a version id");
  for (const line of lines) {
    assert.match(
      line.trimEnd(),
      /\)\s*\|\|\s*true$/,
      `version_id assignment must end in '|| true': ${line}`,
    );
  }
});

// The API-worker path gate must not match all of `containers/`, or a
// Grafana-box image edit under `containers/o11y/` also redeploys the API
// worker and rebuilds/pushes the unrelated Tier-2 image. Narrowed to
// `containers/(live|builder)/`; `deploy-o11y` must still gate on
// `containers/o11y/` specifically, checked here too so a future edit can't
// narrow that line by accident while fixing this one.
test("master.yml: the API path gate is narrowed to containers/(live|builder)/, and the o11y gate still covers containers/o11y/", () => {
  const changesJobStart = source.indexOf("\n  changes:");
  const changesJobEnd = source.indexOf("\n  build:", changesJobStart);
  const changesJob = source.slice(changesJobStart, changesJobEnd);

  const apiLine = changesJob.split("\n").find((l) => l.includes("&& api=true"));
  assert.ok(apiLine, "the api=true gate line must exist");
  assert.match(apiLine, /containers\/\(live\|builder\)\//, "api gate must be narrowed to containers/(live|builder)/");
  assert.doesNotMatch(
    apiLine,
    /containers\/\|/,
    "api gate must not still match the whole containers/ tree unnarrowed",
  );

  const o11yLine = changesJob.split("\n").find((l) => l.includes("&& o11y=true"));
  assert.ok(o11yLine, "the o11y=true gate line must exist");
  assert.match(o11yLine, /containers\/o11y\//, "o11y gate must still cover containers/o11y/");
});

// The `|| true` on each `version_id=$(grep ...)` (above) deliberately lets
// a wrangler wording change through as an empty version_id rather than
// failing the job after the deploy already shipped — but nothing
// downstream then checks whether it actually came out non-empty, so a
// deploy-event step could ship a `cf_version_id: ""` row with no signal
// pointing at the root cause. Every `version_id=$(...)` assignment must be
// immediately followed by a check that warns when it's empty.
test("master.yml: every version_id assignment is followed by an ::warning:: for an empty parse (B-I1)", () => {
  const assignments = [...source.matchAll(/^.*version_id=\$\(grep -oE 'Current Version ID:.*$/gm)];
  assert.ok(assignments.length >= 3, "expected at least 3 deploy steps to extract a version id");

  const warnings = [...source.matchAll(/\[ -n "\$version_id" \] \|\| echo "::warning::[^"]*empty cf_version_id[^"]*"/g)];
  assert.equal(
    warnings.length,
    assignments.length,
    "every version_id assignment must be paired with its own empty-value ::warning::",
  );

  for (const assignment of assignments) {
    const afterAssignment = source.slice(assignment.index, assignment.index + 800);
    assert.match(
      afterAssignment,
      /\[ -n "\$version_id" \] \|\| echo "::warning::/,
      `no empty-value ::warning:: found shortly after: ${assignment[0].trim()}`,
    );
  }
});
