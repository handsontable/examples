#!/bin/bash
# Sourced by entrypoint.sh, never executed directly. Defines run_stop_protocol,
# called from entrypoint's SIGTERM trap with LOKI_PID / GRAFANA_PID already
# set as globals by entrypoint's start().
#
# ADR-0041 §A stop protocol, in order:
#   1. stop Loki gracefully (SIGTERM, wait for real exit — a 0 exit code)
#   2. confirm THIS instance's TSDB index objects are uploaded to R2 (never
#      trust a local directory being empty, and never trust POST /flush: it
#      answers before anything is written, ADR-0041 "Traps")
#   3. only then write state/wakes/<wakeId>/clean into the Loki bucket
#   4. stop Grafana
#
# Fail-closed throughout: any step that does not hold skips the marker write
# and the function returns non-zero. WAKE_ID missing is refused outright —
# never guess a wake id.
#
# Spike result (ADR-0041 exit criterion 1, T01 Outcome): Loki 3.3.2 DOES
# upload its active TSDB index table on a graceful SIGTERM — confirmed by a
# real push -> SIGTERM -> bucket-listing round trip against MinIO
# (containers/o11y/local/stop-roundtrip.mjs). Plan A is what ships; Plan B
# (wait for the next 15-minute index rotation) is documented but not wired,
# because Plan A's own upload-confirmation check already fails closed if
# some future Loki upgrade regresses that behaviour — see the T01 report for
# the decisive log line ("uploading table ... finished uploading table").
#
# Index check design: the TSDB shipper writes each period's table at
# index/index/<day>/<uploaderName>-<file>.tsdb.gz, where <day> is days since
# the Unix epoch (schema_config period = 24h) and <uploaderName> is this
# Loki instance's own stable id, on disk at
# /loki/tsdb-index/uploader/name (read while Loki is still running — the
# shipper deletes local index files right after a successful upload, so
# reading it after exit is not reliable). A whole-prefix "any new key under
# index/" diff was tried first and rejected: R2's ListObjectsV2 caps a
# listing at 1000 keys in lexicographic order, and this bucket accumulates
# index objects across a 90-day retention window (§H) — once it holds over
# 1000, an unpaginated listing of the bare index/ prefix silently stops
# seeing the newest (highest-sorting) keys, and every future stop would read
# as unclean. Scoping the listing to today's (and, for a wake that straddles
# UTC midnight, yesterday's) single-day table prefix keeps each listing
# small for the life of the bucket, and searching for this instance's own
# uploader name distinguishes "we uploaded something" from "some other wake,
# maybe running concurrently, uploaded something."

STOP_GRACE_SECONDS="${O11Y_STOP_GRACE_SECONDS:-30}"

run_stop_protocol() {
  local marker_ok=1

  if [ -z "${WAKE_ID:-}" ]; then
    log "refusing stop protocol: WAKE_ID is not set"
  fi

  # --- 1. stop Loki gracefully -------------------------------------------
  local loki_exit=1
  if [ -n "${LOKI_PID:-}" ] && kill -0 "$LOKI_PID" 2>/dev/null; then
    local uploader_name=""
    if [ -r /loki/tsdb-index/uploader/name ]; then
      uploader_name="$(cat /loki/tsdb-index/uploader/name 2>/dev/null || true)"
    fi
    if [ -z "$uploader_name" ] && [ "${STORAGE:-s3}" = "s3" ]; then
      log "could not read /loki/tsdb-index/uploader/name before stop — index upload cannot be confirmed"
    fi

    log "sending SIGTERM to loki (pid $LOKI_PID)"
    kill -TERM "$LOKI_PID" 2>/dev/null

    local waited=0
    while kill -0 "$LOKI_PID" 2>/dev/null; do
      if [ "$waited" -ge "$STOP_GRACE_SECONDS" ]; then
        log "loki did not exit within ${STOP_GRACE_SECONDS}s of SIGTERM; giving up on a clean marker"
        break
      fi
      sleep 1
      waited=$((waited + 1))
    done

    if ! kill -0 "$LOKI_PID" 2>/dev/null; then
      wait "$LOKI_PID"
      loki_exit=$?
      log "loki exited with code $loki_exit after ${waited}s"
    else
      loki_exit=1
    fi

    # --- 2. confirm THIS instance's index objects landed in R2 -----------
    if [ "$loki_exit" -eq 0 ] && [ -n "${WAKE_ID:-}" ] && [ "${STORAGE:-s3}" = "s3" ] && [ -n "$uploader_name" ]; then
      local day_now day_prev found=""
      day_now=$(( $(date -u +%s) / 86400 ))
      day_prev=$((day_now - 1))
      for day in "$day_now" "$day_prev"; do
        local keys
        keys="$(r2_list_prefix "index/index/${day}/" || true)"
        local match
        match="$(printf '%s\n' "$keys" | grep -F "$uploader_name" || true)"
        if [ -n "$match" ]; then
          found="$match"
          log "index upload confirmed for table ${day}: $(printf '%s' "$match" | tr '\n' ' ')"
          break
        fi
      done
      if [ -n "$found" ]; then
        marker_ok=0
      else
        log "no index object bearing uploader name '${uploader_name}' found under index/index/{${day_now},${day_prev}}/ after graceful stop — not writing a marker (plan B territory, see ADR-0041 exit criterion 1)"
        marker_ok=1
      fi
    else
      marker_ok=1
    fi
  else
    log "loki is not running; nothing to stop, no marker"
  fi

  # --- 3. write the clean-shutdown marker, only if every check held ------
  if [ "$marker_ok" -eq 0 ]; then
    local marker_file
    marker_file="$(mktemp)"
    printf '{"wakeId":"%s","at":"%s"}' "$WAKE_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker_file"
    if r2_put_and_verify "state/wakes/${WAKE_ID}/clean" "$marker_file"; then
      log "clean-shutdown marker written: state/wakes/${WAKE_ID}/clean"
      marker_ok=0
    else
      log "marker PUT/HEAD did not both return 200 — treating this stop as unclean"
      marker_ok=1
    fi
    rm -f "$marker_file"
  fi

  # --- 4. stop Grafana -----------------------------------------------------
  if [ -n "${GRAFANA_PID:-}" ] && kill -0 "$GRAFANA_PID" 2>/dev/null; then
    log "sending SIGTERM to grafana (pid $GRAFANA_PID)"
    kill -TERM "$GRAFANA_PID" 2>/dev/null
    wait "$GRAFANA_PID" 2>/dev/null
    log "grafana exited with code $?"
  fi

  return "$marker_ok"
}
