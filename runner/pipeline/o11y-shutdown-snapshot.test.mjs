// `shutdown.sh` must fail open when the pre-SIGTERM listing fails.
// Deterministic, fast proof, driven at the shell-function level —
// `containers/o11y/supervisor/{lib,shutdown}.sh`'s
// `r2_list_prefix`/`snapshot_index_keys`/`confirm_new_upload`, sourced for
// real into a plain `bash` subprocess with a stubbed `curl`
// (`fixtures/stub-bin/curl`) on `PATH`.
//
// Why a shell-level test rather than a full `stop-roundtrip.mjs` docker
// scenario: the bug needs an asymmetric failure — the pre-SIGTERM listing
// fails while the post-exit one succeeds — which is a live R2/MinIO
// policy-toggle timed against the exact moment `shutdown.sh`'s trap runs
// inside the container. That is not reproducible deterministically over
// docker; this test controls the exact sequence of curl responses instead,
// which is what actually exercises the fixed control flow.
// `stop-roundtrip.mjs`'s own case still proves the real end-to-end
// index-upload/marker path against a real Loki + MinIO; this test proves
// the specific listing-failure branch that path cannot reach on demand.
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
 *  `daySpan` sets `O11Y_INDEX_DAY_SPAN_DAYS` (read at source time); the
 *  default of 1 means four listings per snapshot (2 days x 2 index prefixes). */
function runBash(script, { modes = "empty", daySpan = 1 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "o11y-shutdown-test-"));
  const counterFile = path.join(dir, "curl-calls");
  writeFileSync(counterFile, "");
  const argsFile = path.join(dir, "curl-args");
  writeFileSync(argsFile, "");
  try {
    const full = `
set -u
export STUB_CURL_MODES=${JSON.stringify(modes)}
export STUB_CURL_COUNTER_FILE=${JSON.stringify(counterFile)}
export STUB_CURL_ARGS_FILE=${JSON.stringify(argsFile)}
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

test("snapshot_index_keys: fails (prints nothing usable) when any one listing fails", () => {
  const res = runBash('snapshot_index_keys 19999 > /dev/null; echo "EXIT:$?"', { modes: "fail" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:1$/m);
});

test("snapshot_index_keys: succeeds (possibly empty) when every listing succeeds", () => {
  const res = runBash('snapshot_index_keys 19999 > /dev/null; echo "EXIT:$?"', { modes: "empty" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:0$/m);
});

// ---- the bug shape: before fails, after succeeds ---------------------------

test("the marker decision refuses when the PRE-SIGTERM snapshot failed, even though a real new upload would otherwise be confirmed", () => {
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
  // Calls 1-4 (the BEFORE snapshot's four listings) fail; calls
  // 5-8 (the AFTER snapshot) succeed and find the pre-existing key.
  const res = runBash(script, { modes: "fail,fail,fail,fail,haskey,haskey,haskey,haskey" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /SNAPSHOT_OK:0/);
  assert.match(res.stdout, /MARKER_OK:1/, "the marker must be refused — the pre-existing key must never be read as new");
});

test("revert check / positive control: with BOTH snapshots succeeding, a genuinely new key IS confirmed and the marker is written", () => {
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
  // BEFORE all four empty, AFTER all four find the key — a genuine new upload.
  const res = runBash(script, { modes: "empty,empty,empty,empty,haskey,haskey,haskey,haskey" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /MARKER_OK:0/, "a real new upload, cleanly confirmed both sides, must still write the marker");
});

// ---- drive the real run_stop_protocol(), not a copy -------------------------
//
// The two tests above re-implement the `snapshot_ok` gate inline in the
// test's own script, rather than calling `run_stop_protocol` itself —
// deleting shutdown.sh:168 would fail no test that way. The two tests
// below call the real function, driven with: a real backgrounded process
// as LOKI_PID (traps SIGTERM and exits 0, so `run_stop_protocol`'s own
// `kill -TERM`/`wait` logic runs for real, not a stub), and
// `LOKI_UPLOADER_NAME_FILE` pointed at a real temp file (the hardcoded
// `/loki/...` path is not writable outside a real container).
//
// `code200` (the stub-curl mode) is what a real `r2_put_and_verify`
// PUT+HEAD pair needs — the marker path this pair exercises, which the two
// tests above never reach at all (they stop at the boolean decision, never
// call `r2_put_and_verify`).

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

test("second wave: run_stop_protocol() itself refuses the marker when the PRE-SIGTERM listing fails, even though the after-listing would confirm a real upload", () => {
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

test("second wave (revert check / positive control): run_stop_protocol() writes a real marker when both snapshots succeed and a genuinely new key is confirmed", () => {
  const res = withFakeLoki('run_stop_protocol; echo "EXIT:$?"; echo "CALLS:$(wc -l < "$STUB_CURL_COUNTER_FILE")"', {
    modes: "empty,empty,empty,empty,haskey,haskey,haskey,haskey,code200,code200",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:0$/m, "run_stop_protocol must return 0 — a clean stop, marker written");
  assert.match(res.stdout, /CALLS:\s*10$/m, "before x4, after x4, PUT, HEAD — the full real marker-write path");
});

// ---- the snapshot must span every day a backlogged upload could land, not
// just today and yesterday ---------------------------------------------------

test("snapshot_index_keys: queries one prefix per day from day_now down through day_now - INDEX_DAY_SPAN_DAYS", () => {
  // daySpan=3 -> 4 days (offsets 0..3) x 2 index prefixes -> 8 curl calls for one snapshot.
  const res = runBash('snapshot_index_keys 19999 > /dev/null; echo "CALLS:$(wc -l < "$STUB_CURL_COUNTER_FILE")"', {
    modes: "empty",
    daySpan: 3,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /CALLS:\s*8$/m, "one call per day and index prefix from day_now through day_now - 3, inclusive");
});

// `shutdown.sh`'s `snapshot_index_keys` must not use a two-argument,
// today/yesterday-only form: that would leave the day-3 upload never even
// listed, so `confirm_new_upload` never sees it. `day_now`'s offset-3 day
// prefix (three days back) stands in for a backlogged/reopened record's
// index table, which can legitimately land under any day up to
// `INDEX_DAY_SPAN_DAYS` (7 in production, bounded by Loki's own
// `reject_old_samples_max_age: 7d`) in the past — a day a today/yesterday-
// only check would never look at.
test("a backlogged upload landing under a day older than yesterday is confirmed as new, not silently missed", () => {
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

// ---- both index prefixes are listed ----------------------------------------

test("snapshot_index_keys: lists each day under both the index/ and index_ table prefixes", () => {
  const res = runBash('snapshot_index_keys 19999 > /dev/null; cat "$STUB_CURL_ARGS_FILE"', {
    modes: "empty",
    daySpan: 0,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /prefix=index%2Findex%2F19999%2F/, "old-prefix table listed");
  assert.match(res.stdout, /prefix=index%2Findex_19999%2F/, "new-prefix table listed");
});

test("snapshot_index_keys: a failure in the index_ listing alone fails the whole snapshot", () => {
  // daySpan=0 -> call 1 is index/index/<day>/ (empty), call 2 is index/index_<day>/ (fails).
  const res = runBash('snapshot_index_keys 19999 > /dev/null; echo "EXIT:$?"', { modes: "empty,fail", daySpan: 0 });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:1$/m, "an unconfirmable listing under either prefix is cannot-confirm, never empty");
});

test("a new upload under the index_ prefix is confirmed as new", () => {
  const script = `
day_now=19999
before_keys="$(snapshot_index_keys "$day_now")"
after_keys="$(snapshot_index_keys "$day_now")"
if confirm_new_upload "uploaderA" "$before_keys" "$after_keys"; then echo "MARKER_OK:0"; else echo "MARKER_OK:1"; fi
`;
  // daySpan=0: before = old, new (both empty); after = old (empty), new (has the key).
  const res = runBash(script, { modes: "empty,empty,empty,haskey", daySpan: 0 });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /MARKER_OK:0/, "a key that only exists under index_<day>/ must count");
});

// ---- the Grafana wait is bounded ---------------------------------------------

test("run_stop_protocol() gives up on a Grafana that ignores SIGTERM after its grace and still returns the marker decision", () => {
  const script = `
GRAFANA_STOP_GRACE_SECONDS=1
export WAKE_ID=test-wake-grafana
export LOKI_UPLOADER_NAME_FILE=/nonexistent
ready="$(mktemp -u)"
bash -c 'trap "" TERM; touch "$0"; while true; do sleep 0.05; done' "$ready" &
GRAFANA_PID=$!
for _ in $(seq 100); do [ -e "$ready" ] && break; sleep 0.05; done
[ -e "$ready" ] || { echo 'fake grafana never became ready'; exit 9; }
start=$(date +%s)
run_stop_protocol; rc=$?
echo "EXIT:$rc"
echo "ELAPSED:$(( $(date +%s) - start ))"
kill -KILL "$GRAFANA_PID" 2>/dev/null
`;
  const res = runBash(script, { modes: "empty" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EXIT:1$/m, "no Loki, so no marker: the decision survives the Grafana timeout");
  const elapsed = Number(/ELAPSED:(\d+)/.exec(res.stdout)?.[1]);
  assert.ok(elapsed <= 5, `run_stop_protocol returned after ${elapsed}s`);
  assert.match(res.stderr + res.stdout, /grafana did not exit within 1s/);
});

test("run_stop_protocol() logs the real exit code of a Grafana that stops within its grace", () => {
  const script = `
GRAFANA_STOP_GRACE_SECONDS=5
export WAKE_ID=test-wake-grafana
export LOKI_UPLOADER_NAME_FILE=/nonexistent
ready="$(mktemp -u)"
bash -c 'trap "exit 3" TERM; touch "$0"; while true; do sleep 0.05; done' "$ready" &
GRAFANA_PID=$!
for _ in $(seq 100); do [ -e "$ready" ] && break; sleep 0.05; done
[ -e "$ready" ] || { echo 'fake grafana never became ready'; exit 9; }
run_stop_protocol; echo "EXIT:$?"
`;
  const res = runBash(script, { modes: "empty" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr + res.stdout, /grafana exited with code 3/);
});
