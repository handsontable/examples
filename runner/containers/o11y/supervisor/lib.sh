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
r2_list_prefix() {
  local prefix="$1"
  r2_curl_base
  curl -fsS --max-time 15 "${R2_SIGV4_ARGS[@]}" \
    "${R2_BASE_URL}/?list-type=2&prefix=$(printf '%s' "$prefix" | sed 's/\//%2F/g')" \
    | grep -o '<Key>[^<]*</Key>' | sed -e 's/<Key>//' -e 's#</Key>##'
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
