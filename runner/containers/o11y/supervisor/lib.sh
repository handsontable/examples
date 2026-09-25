#!/bin/bash
# Shared helpers for entrypoint.sh and shutdown.sh. Sourced, never executed
# directly. Bash (not POSIX sh): the base image ships bash, and the trap /
# `wait -n` behaviour the supervisor needs is bash's, not busybox ash's.
set -u

log() {
  # A structured-ish line on stdout; this box exports no Workers Logs of its
  # own (ADR-0041 §B.6) — this is operator-visible container stdout only.
  printf '%s supervisor: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$*"
}

# Build the base curl args for a signed request against the Loki bucket.
# The credentials reach the box as LOKI_S3_* envVars, scoped to that bucket
# only (ADR-0041 §A) — the shutdown script never touches any other bucket.
r2_curl_base() {
  local scheme="https"
  if [ "${LOKI_S3_INSECURE:-false}" = "true" ]; then
    scheme="http"
  fi
  R2_BASE_URL="${scheme}://${LOKI_S3_ENDPOINT}/${LOKI_S3_BUCKET}"
  R2_SIGV4_ARGS=(--aws-sigv4 "aws:amz:${LOKI_S3_REGION:-auto}:s3" \
    --user "${LOKI_S3_ACCESS_KEY_ID}:${LOKI_S3_SECRET_ACCESS_KEY}")
}

# r2_list_prefix <prefix>  — object keys under a prefix, one per line, via
# the S3 ListObjectsV2 XML API. Used to prove the index actually landed in
# the bucket rather than trusting a local directory or a 202-style response
# ("POST /flush returns before anything is written" — ADR-0041 traps).
#
# F2 fix (final review, B-I2 "shutdown.sh fails open when the pre-SIGTERM
# listing fails"): the previous version piped `curl -fsS | grep -o | sed`
# straight through with no `set -o pipefail` and no check on curl's own exit
# status — a network blip, a timeout, or a 5xx made `curl -f` fail, but the
# pipeline's overall exit code was whatever `sed` returned (0, on empty
# input), so the caller (shutdown.sh, via `$(r2_list_prefix ... || true)`)
# read a FAILED listing as a CONFIRMED-EMPTY one. shutdown.sh's own C1 diff
# then treated a pre-existing, mid-wake periodic upload as "new" once the
# (successful) after-listing ran, and wrote a marker for a stop whose FINAL
# upload was never actually confirmed. Fixed here, not by adding
# `set -o pipefail` (which has its own trap — see the test file's own note:
# a genuinely EMPTY, successful listing makes `grep -o` exit 1 too, for "no
# match", which `pipefail` would then also read as failure, breaking the
# very first wake of every UTC day before any index object exists yet):
#   1. Capture curl's own body and exit status explicitly (`|| return 1`) —
#      a curl failure is now a hard, unambiguous function failure.
#   2. Require the body to actually contain a `<ListBucketResult` root
#      before treating it as a real listing — an error response (S3
#      `<Error>...</Error>` XML) or a non-XML proxy error page must not be
#      silently parsed as "zero keys."
#   3. Refuse a truncated listing (`<IsTruncated>true</IsTruncated>`) rather
#      than silently returning a partial (and therefore wrong for a "does
#      X exist" check) key set — see this file's own header note on why an
#      unpaginated whole-`index/` listing was rejected in the first place;
#      the same reasoning applies to a single day prefix once it grows past
#      1000 keys.
# Every caller must check this function's OWN exit status (never
# `$(... || true)`) and treat a failure as "cannot confirm," not as "found
# nothing" — see shutdown.sh's `snapshot_index_keys`.
r2_list_prefix() {
  local prefix="$1"
  r2_curl_base
  local body
  body="$(curl -fsS --max-time 15 "${R2_SIGV4_ARGS[@]}" \
    "${R2_BASE_URL}/?list-type=2&prefix=$(printf '%s' "$prefix" | sed 's/\//%2F/g')")" || return 1
  case "$body" in
    *"<ListBucketResult"*) ;;
    *)
      log "r2_list_prefix: response for prefix '${prefix}' has no <ListBucketResult> root — treating as a failure, not an empty listing"
      return 1
      ;;
  esac
  if printf '%s' "$body" | grep -q '<IsTruncated>true</IsTruncated>'; then
    log "r2_list_prefix: truncated listing for prefix '${prefix}' (over 1000 keys) — cannot confirm the full set"
    return 1
  fi
  printf '%s' "$body" | grep -o '<Key>[^<]*</Key>' | sed -e 's/<Key>//' -e 's#</Key>##'
  return 0
}

# r2_put <key> <file>  — PUT then HEAD to confirm (200s only; never trust
# the PUT response alone).
r2_put_and_verify() {
  local key="$1" file="$2"
  r2_curl_base
  local put_code
  put_code=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
    "${R2_SIGV4_ARGS[@]}" -X PUT --data-binary "@${file}" \
    "${R2_BASE_URL}/${key}")
  if [ "$put_code" != "200" ]; then
    log "marker PUT failed: HTTP ${put_code}"
    return 1
  fi
  local head_code
  head_code=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
    "${R2_SIGV4_ARGS[@]}" -I "${R2_BASE_URL}/${key}")
  if [ "$head_code" != "200" ]; then
    log "marker HEAD confirmation failed: HTTP ${head_code}"
    return 1
  fi
  return 0
}
