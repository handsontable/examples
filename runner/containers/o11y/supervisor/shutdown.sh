#!/bin/bash
# Sourced by entrypoint.sh, never executed directly. Defines run_stop_protocol,
# called from entrypoint's SIGTERM trap with LOKI_PID / GRAFANA_PID already
# set as globals by entrypoint's start().
#
# ADR-0041 §A stop protocol, in order:
#   1. stop Loki gracefully (SIGTERM, wait for real exit — a 0 exit code)
#   2. confirm the TSDB index for this wake is uploaded to R2 (bucket
#      listing under the index/ prefix, before vs. after — never trust a
#      local directory being empty, and never trust POST /flush: it answers
#      before anything is written, ADR-0041 "Traps")
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
# because Plan A's own listing check already fails closed if some future
# Loki upgrade regresses that behaviour — see the T01 report for the
# decisive log line ("uploading table ... finished uploading table").

INDEX_PREFIX="index/"
STOP_GRACE_SECONDS="${O11Y_STOP_GRACE_SECONDS:-30}"

run_stop_protocol() {
  local marker_ok=1

  if [ -z "${WAKE_ID:-}" ]; then
    log "refusing stop protocol: WAKE_ID is not set"
  fi

  # --- 1. stop Loki gracefully -------------------------------------------
  local loki_exit=1
  if [ -n "${LOKI_PID:-}" ] && kill -0 "$LOKI_PID" 2>/dev/null; then
    local before_index
    if [ "${STORAGE:-s3}" = "s3" ]; then
      before_index="$(r2_list_prefix "$INDEX_PREFIX" || true)"
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

    # --- 2. confirm the index actually landed in R2 ----------------------
    if [ "$loki_exit" -eq 0 ] && [ -n "${WAKE_ID:-}" ] && [ "${STORAGE:-s3}" = "s3" ]; then
      local after_index new_keys
      after_index="$(r2_list_prefix "$INDEX_PREFIX" || true)"
      new_keys="$(comm -13 <(printf '%s\n' "$before_index" | sort) <(printf '%s\n' "$after_index" | sort))"
      if [ -n "$new_keys" ]; then
        log "index upload confirmed: $(printf '%s' "$new_keys" | tr '\n' ' ')"
        marker_ok=0
      else
        log "no new index object found under ${INDEX_PREFIX} after graceful stop — not writing a marker (plan B territory, see ADR-0041 exit criterion 1)"
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
