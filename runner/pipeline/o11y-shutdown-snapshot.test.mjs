// F2 fix (final review, B-I2 "shutdown.sh fails open when the pre-SIGTERM
// listing fails"): deterministic, fast proof of the fix, driven at the
// shell-function level — `containers/o11y/supervisor/{lib,shutdown}.sh`'s
// `r2_list_prefix`/`snapshot_index_keys`/`confirm_new_upload`, sourced for
// real into a plain `bash` subprocess with a stubbed `curl`
// (`fixtures/stub-bin/curl`) on `PATH`.
//
// Why a shell-level test rather than a full `stop-roundtrip.mjs` docker
// scenario: the actual bug needs an ASYMMETRIC failure — the pre-SIGTERM
// listing fails while the post-exit one succeeds — which is a live R2/MinIO
// policy-toggle timed against the exact moment `shutdown.sh`'s trap runs
// inside the container. That is not reproducible deterministically over
// docker; this test controls the exact sequence of curl responses instead,
// which is what actually exercises the fixed control flow (see
// `F2-report.md` for the fuller reasoning). `stop-roundtrip.mjs`'s own C1
// case still proves the real end-to-end index-upload/marker path against a
// real Loki + MinIO; this test proves the specific listing-failure branch
// that path cannot reach on demand.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs
// (this file needs no `--experimental-strip-types` itself — no TS import —
// but is picked up by the same glob.)

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_DIR = path.join(HERE, "..", "containers", "o11y", "supervisor");
const STUB_BIN_DIR = path.join(HERE, "fixtures", "stub-bin");

/** Sources lib.sh + shutdown.sh into a fresh bash process (stubbed `curl`
 *  first on PATH) and runs `script` (bash source) in that same context.
 *  `script` should end by printing whatever the test wants to assert on. */
function runBash(script, { modes = "empty" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "o11y-shutdown-test-"));
  const counterFile = path.join(dir, "curl-calls");
  writeFileSync(counterFile, "");
  try {
    const full = `
set -u
export STUB_CURL_MODES=${JSON.stringify(modes)}
export STUB_CURL_COUNTER_FILE=${JSON.stringify(counterFile)}
export LOKI_S3_ENDPOINT="minio.example:9000"
export LOKI_S3_BUCKET="loki"
export LOKI_S3_REGION="auto"
export LOKI_S3_ACCESS_KEY_ID="test"
export LOKI_S3_SECRET_ACCESS_KEY="test"
export LOKI_S3_INSECURE="true"
export STORAGE="s3"
source ${JSON.stringify(path.join(SUPERVISOR_DIR, "lib.sh"))}
source ${JSON.stringify(path.join(SUPERVISOR_DIR, "shutdown.sh"))}
${script}
`;
    const result = spawnSync("bash", ["-c", full], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${STUB_BIN_DIR}:${process.env.PATH}` },
    });
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- r2_list_prefix: the root-cause fix ------------------------------------

test("r2_list_prefix: a curl failure is a hard function failure, not a silently-empty result", () => {
  const res = runBash('r2_list_prefix "index/index/19999/"; echo "EXIT:$?"', { modes: "fail" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:1$/m, "a curl failure must make r2_list_prefix itself fail");
});

test("r2_list_prefix: a genuinely empty, successful listing still succeeds with empty output (no pipefail false-failure)", () => {
  const res = runBash('out="$(r2_list_prefix "index/index/19999/")"; echo "EXIT:$?"; echo "OUT:[$out]"', {
    modes: "empty",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:0$/m, "a valid empty listing must not be treated as a failure");
  assert.match(res.stdout, /OUT:\[\]/);
});

test("r2_list_prefix: a successful listing with a key returns it", () => {
  const res = runBash('r2_list_prefix "index/index/19999/"', { modes: "haskey" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /uploaderA/);
});

test("r2_list_prefix: a truncated listing is refused, not silently returned partial", () => {
  const res = runBash('r2_list_prefix "index/index/19999/"; echo "EXIT:$?"', { modes: "truncated" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:1$/m);
});

test("r2_list_prefix: a 200 that is not real S3 XML (a proxy error page) is refused, not parsed as empty", () => {
  const res = runBash('r2_list_prefix "index/index/19999/"; echo "EXIT:$?"', { modes: "malformed" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:1$/m);
});

// ---- snapshot_index_keys: propagates a failed listing as a failure --------

test("snapshot_index_keys: fails (prints nothing usable) when either day's listing fails", () => {
  const res = runBash('snapshot_index_keys 19999 19998 > /dev/null; echo "EXIT:$?"', { modes: "fail" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:1$/m);
});

test("snapshot_index_keys: succeeds (possibly empty) when both listings succeed", () => {
  const res = runBash('snapshot_index_keys 19999 19998 > /dev/null; echo "EXIT:$?"', { modes: "empty" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:0$/m);
});

// ---- The actual B-I2 bug shape: before fails, after succeeds --------------

test("B-I2: the marker decision refuses when the PRE-SIGTERM snapshot failed, even though a real new upload would otherwise be confirmed", () => {
  // Reproduces the exact scenario the finding describes: a pre-existing
  // uploader-named object already exists (a mid-wake periodic upload), the
  // BEFORE listing fails (network blip), and the AFTER listing succeeds
  // and finds that same pre-existing key. The OLD code (silently-empty
  // `before_keys`) would read this key as "new" and write a marker for a
  // stop whose final upload was never actually confirmed. The fix must
  // refuse — `snapshot_ok=0` — regardless of what the after-listing shows.
  const script = `
day_now=19999
day_prev=19998
snapshot_ok=0
if before_keys="$(snapshot_index_keys "$day_now" "$day_prev")"; then
  snapshot_ok=1
fi
echo "SNAPSHOT_OK:$snapshot_ok"
marker_ok=1
if [ "$snapshot_ok" -eq 1 ]; then
  if after_keys="$(snapshot_index_keys "$day_now" "$day_prev")"; then
    if confirm_new_upload "uploaderA" "$before_keys" "$after_keys"; then
      marker_ok=0
    fi
  fi
fi
echo "MARKER_OK:$marker_ok"
`;
  // Calls 1-2 (the BEFORE snapshot's two day-prefix listings) fail; calls
  // 3-4 (the AFTER snapshot) succeed and find the pre-existing key.
  const res = runBash(script, { modes: "fail,fail,haskey,haskey" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /SNAPSHOT_OK:0/);
  assert.match(res.stdout, /MARKER_OK:1/, "the marker must be refused — the pre-existing key must never be read as new");
});

test("B-I2 (revert check / positive control): with BOTH snapshots succeeding, a genuinely new key IS confirmed and the marker is written", () => {
  const script = `
day_now=19999
day_prev=19998
before_keys="$(snapshot_index_keys "$day_now" "$day_prev")"
after_keys="$(snapshot_index_keys "$day_now" "$day_prev")"
if confirm_new_upload "uploaderA" "$before_keys" "$after_keys"; then
  echo "MARKER_OK:0"
else
  echo "MARKER_OK:1"
fi
`;
  // BEFORE both empty, AFTER both find the key — a genuine new upload.
  const res = runBash(script, { modes: "empty,empty,haskey,haskey" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /MARKER_OK:0/, "a real new upload, cleanly confirmed both sides, must still write the marker");
});
