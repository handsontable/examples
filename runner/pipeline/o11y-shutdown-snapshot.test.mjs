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
// which is what actually exercises the fixed control flow. `stop-roundtrip.mjs`'s own C1
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
 *  `script` should end by printing whatever the test wants to assert on.
 *  `daySpan` sets `O11Y_INDEX_DAY_SPAN_DAYS` BEFORE `shutdown.sh` is
 *  sourced (`INDEX_DAY_SPAN_DAYS` is only read at source time, not inside a
 *  function) — defaults to `1` (today + yesterday, i.e. two day-prefixes
 *  per snapshot) so every EXISTING test's call-count expectations, written
 *  before fix round B-M8 widened the real default to 7, keep meaning
 *  exactly what they said without editing each one; tests that care about
 *  the wider span pass `daySpan` explicitly. */
function runBash(script, { modes = "empty", daySpan = 1 } = {}) {
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
export O11Y_INDEX_DAY_SPAN_DAYS=${JSON.stringify(String(daySpan))}
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
  const res = runBash('snapshot_index_keys 19999 > /dev/null; echo "EXIT:$?"', { modes: "fail" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:1$/m);
});

test("snapshot_index_keys: succeeds (possibly empty) when both listings succeed", () => {
  const res = runBash('snapshot_index_keys 19999 > /dev/null; echo "EXIT:$?"', { modes: "empty" });
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
snapshot_ok=0
if before_keys="$(snapshot_index_keys "$day_now")"; then
  snapshot_ok=1
fi
echo "SNAPSHOT_OK:$snapshot_ok"
marker_ok=1
if [ "$snapshot_ok" -eq 1 ]; then
  if after_keys="$(snapshot_index_keys "$day_now")"; then
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
before_keys="$(snapshot_index_keys "$day_now")"
after_keys="$(snapshot_index_keys "$day_now")"
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

// ---- B-I2, second wave: drive the REAL run_stop_protocol(), not a copy ----
//
// Rereview finding on the two tests above: they re-implement the
// `snapshot_ok` gate INLINE in the test's own script, rather than calling
// `run_stop_protocol` itself — "the new unit test copies run_stop_protocol's
// snapshot_ok gate into its own script instead of calling it, so deleting
// shutdown.sh:168 fails no test." The two tests below call the real
// function, driven with: a real backgrounded process as LOKI_PID (traps
// SIGTERM and exits 0, so `run_stop_protocol`'s own `kill -TERM`/`wait`
// logic runs for real, not a stub), and `LOKI_UPLOADER_NAME_FILE` pointed at
// a real temp file (the F2 fix, second wave, that makes this possible at
// all — the hardcoded `/loki/...` path is not writable outside a real
// container).
//
// `code200` (the new stub-curl mode) is what a real `r2_put_and_verify`
// PUT+HEAD pair needs — the marker path this revert-evidence pair now
// actually exercises, which the two tests above never reached at all (they
// stop at the boolean decision, never call `r2_put_and_verify`).

function withFakeLoki(bodyScript, { modes }) {
  const script = `
uploader_file="$(mktemp)"
printf 'uploaderA' > "$uploader_file"
export LOKI_UPLOADER_NAME_FILE="$uploader_file"
export STORAGE=s3
export WAKE_ID=test-wake-b-i2
# A fake "loki": traps SIGTERM and exits 0, same as the real Loki 3.3.2
# graceful-shutdown behaviour this whole mechanism depends on (T01 Outcome).
bash -c 'trap "exit 0" TERM; while true; do sleep 0.05; done' &
LOKI_PID=$!
${bodyScript}
rm -f "$uploader_file"
`;
  return runBash(script, { modes });
}

test("B-I2, second wave: run_stop_protocol() itself refuses the marker when the PRE-SIGTERM listing fails, even though the after-listing would confirm a real upload", () => {
  // Only ONE curl call happens: snapshot_index_keys returns on the FIRST
  // failed day-prefix listing (its own `for day in ...; return 1` — see
  // lib.sh), so snapshot_ok is decided, and never reached again, before
  // SIGTERM is even sent. The extra modes after "fail" stand in for what a
  // REVERTED shutdown.sh:168 (the `&& [ "$snapshot_ok" -eq 1 ]` clause
  // removed) would consume instead — proving this test actually depends on
  // that clause, not just on snapshot_index_keys's own behaviour.
  const res = withFakeLoki('run_stop_protocol; echo "EXIT:$?"; echo "CALLS:$(wc -l < "$STUB_CURL_COUNTER_FILE")"', {
    modes: "fail,haskey,haskey,code200,code200",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:1$/m, "run_stop_protocol must return non-zero (no marker written)");
  assert.match(res.stdout, /CALLS:\s*1$/m, "only the one failed BEFORE listing — no after-listing, no PUT, no HEAD");
});

test("B-I2, second wave (revert check / positive control): run_stop_protocol() writes a real marker when both snapshots succeed and a genuinely new key is confirmed", () => {
  const res = withFakeLoki('run_stop_protocol; echo "EXIT:$?"; echo "CALLS:$(wc -l < "$STUB_CURL_COUNTER_FILE")"', {
    modes: "empty,empty,haskey,haskey,code200,code200",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:0$/m, "run_stop_protocol must return 0 — a clean stop, marker written");
  assert.match(res.stdout, /CALLS:\s*6$/m, "before x2, after x2, PUT, HEAD — the full real marker-write path");
});

// ---- B-M8: the snapshot must span every day a backlogged upload could land,
// not just today and yesterday ----------------------------------------------

test("snapshot_index_keys: queries one prefix per day from day_now down through day_now - INDEX_DAY_SPAN_DAYS", () => {
  // daySpan=3 -> 4 day-prefixes (offsets 0..3) -> 4 curl calls for one snapshot.
  const res = runBash('snapshot_index_keys 19999 > /dev/null; echo "CALLS:$(wc -l < "$STUB_CURL_COUNTER_FILE")"', {
    modes: "empty",
    daySpan: 3,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /CALLS:\s*4$/m, "one call per day from day_now through day_now - 3, inclusive");
});

// Fails without the fix: reverting `shutdown.sh`'s `snapshot_index_keys` to
// its old two-argument, today/yesterday-only form makes this MARKER_OK:1 —
// the day-3 upload is never even listed, so `confirm_new_upload` never sees
// it. `day_now`'s offset-3 day prefix (three days back) stands in for a
// backlogged/reopened record's index table, which can legitimately land
// under any day up to `INDEX_DAY_SPAN_DAYS` (7 in production, bounded by
// Loki's own `reject_old_samples_max_age: 7d`) in the past — a day the old
// today/yesterday-only check never looked at.
test("B-M8: a backlogged upload landing under a day older than yesterday is confirmed as new, not silently missed", () => {
  const script = `
day_now=19999
before_keys="$(snapshot_index_keys "$day_now")"
after_keys="$(snapshot_index_keys "$day_now")"
if confirm_new_upload "uploaderA" "$before_keys" "$after_keys"; then
  echo "MARKER_OK:0"
else
  echo "MARKER_OK:1"
fi
`;
  // BEFORE (offsets 0..3, today..day_now-3): all empty. AFTER: today,
  // day_now-1, day_now-2 still empty; day_now-3 (the oldest day this span
  // covers) now has the uploader's key — a backlogged upload three days
  // back, never touched by the pre-fix today/yesterday-only check.
  const res = runBash(script, { modes: "empty,empty,empty,empty,empty,empty,empty,haskey", daySpan: 3 });
  assert.equal(res.status, 0, res.stderr);
  assert.match(
    res.stdout,
    /MARKER_OK:0/,
    "a genuinely new upload under a day older than yesterday must still confirm the marker",
  );
});
