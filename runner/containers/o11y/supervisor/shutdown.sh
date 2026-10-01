#!/bin/bash
# Sourced by entrypoint.sh, never executed directly. Defines run_stop_protocol,
# called from entrypoint's SIGTERM trap with LOKI_PID/GRAFANA_PID as globals.
#
# ADR-0041 §A stop protocol: stop Loki (SIGTERM, wait for a 0 exit) -> confirm
# THIS instance's TSDB index landed in R2 (never trust an empty local dir or
# POST /flush, which answers before anything is written) -> only then write
# state/wakes/<wakeId>/clean -> stop Grafana. Fail-closed; WAKE_ID missing is
# refused outright.
#
# An uploader-name match alone is not proof of a NEW upload (the shipper also
# uploads periodically while Loki runs), so the check snapshots uploader-named
# keys BEFORE SIGTERM and requires a key NOT in that snapshot after exit. A
# false "unclean" is the safe failure direction (a replay costs a dedupe'd
# duplicate, ADR-0041 §B.3).

STOP_GRACE_SECONDS="${O11Y_STOP_GRACE_SECONDS:-30}"
# Bounds the final Grafana wait so a Grafana that ignores SIGTERM cannot hold the
# stop until the platform's SIGKILL (ADR-0041 §A, stop grace bound).
GRAFANA_STOP_GRACE_SECONDS="${O11Y_GRAFANA_STOP_GRACE_SECONDS:-30}"

# Loki's own `reject_old_samples_max_age: 7d` means a backlogged/reopened
# record can write a NEW index table up to 7 days in the past; this bounds
# how far back a stop check must look. Overridable for tests.
INDEX_DAY_SPAN_DAYS="${O11Y_INDEX_DAY_SPAN_DAYS:-7}"

# The snapshot-diff decision lives in its own testable functions (separate
# from `run_stop_protocol`, which needs a real LOKI_PID to exercise at all).
# See `pipeline/o11y-shutdown-snapshot.test.mjs` for the deterministic proof.

# snapshot_index_keys <day_now>  — uploader-named keys for `day_now` down through
# `day_now - INDEX_DAY_SPAN_DAYS`, each day under `index/index/` and `index/index_`
# (records up to 7 days old still land in the old table after `index_` starts, which
# must be live in the image before its `from`). Returns 1 on ANY failed listing:
# "cannot confirm," never "empty." Worst case 16 listings x 15 s = 240 s per snapshot.
snapshot_index_keys() {
  local day_now="$1"
  local keys="" offset day listing key_prefix
  for offset in $(seq 0 "$INDEX_DAY_SPAN_DAYS"); do
    day=$((day_now - offset))
    for key_prefix in "index/index/${day}/" "index/index_${day}/"; do
      if ! listing="$(r2_list_prefix "$key_prefix")"; then
        return 1
      fi
      keys="${keys}${listing}
"
    done
  done
  printf '%s' "$keys"
  return 0
}

# confirm_new_upload <uploader_name> <before_keys> <after_keys> — true (0)
# iff a key bearing <uploader_name> is new in <after_keys> vs <before_keys>.
confirm_new_upload() {
  local uploader_name="$1" before_keys="$2" after_keys="$3"
  local before_matches after_matches new_matches
  before_matches="$(printf '%s\n' "$before_keys" | grep -F "$uploader_name" | sort -u || true)"
  after_matches="$(printf '%s\n' "$after_keys" | grep -F "$uploader_name" | sort -u || true)"
  new_matches="$(comm -13 <(printf '%s\n' "$before_matches") <(printf '%s\n' "$after_matches"))"
  [ -n "$new_matches" ]
}

run_stop_protocol() {
  local marker_ok=1

  if [ -z "${WAKE_ID:-}" ]; then
    log "refusing stop protocol: WAKE_ID is not set"
  fi

  # --- 1. stop Loki gracefully -------------------------------------------
  # The uploader-name path is overridable via LOKI_UPLOADER_NAME_FILE, which
  # makes `run_stop_protocol` itself directly testable
  # (`pipeline/o11y-shutdown-snapshot.test.mjs`) without a real `/loki` filesystem.
  local uploader_name_file="${LOKI_UPLOADER_NAME_FILE:-/loki/tsdb-index/uploader/name}"
  local loki_exit=1
  if [ -n "${LOKI_PID:-}" ] && kill -0 "$LOKI_PID" 2>/dev/null; then
    local uploader_name=""
    if [ -r "$uploader_name_file" ]; then
      uploader_name="$(cat "$uploader_name_file" 2>/dev/null || true)"
    fi
    if [ -z "$uploader_name" ] && [ "${STORAGE:-s3}" = "s3" ]; then
      log "could not read ${uploader_name_file} before stop — index upload cannot be confirmed"
    fi

    # Snapshot BEFORE SIGTERM: a periodic shipper upload can already exist
    # this wake, so "does one exist" after exit isn't proof of the FINAL
    # upload. `snapshot_ok` ensures a FAILED listing is never read as empty.
    local day_now before_keys="" snapshot_ok=0
    if [ "${STORAGE:-s3}" = "s3" ] && [ -n "$uploader_name" ]; then
      day_now=$(( $(date -u +%s) / 86400 ))
      if before_keys="$(snapshot_index_keys "$day_now")"; then
        snapshot_ok=1
      else
        log "pre-SIGTERM index listing failed — cannot confirm a new upload this wake; will refuse the marker"
      fi
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

    # --- 2. confirm THIS instance uploaded a NEW index object ------------
    # Requires `snapshot_ok` too — a stop that could not even confirm the
    # BEFORE state must never write a marker, no matter how the
    # after-listing or Loki's own exit code turn out.
    if [ "$loki_exit" -eq 0 ] && [ -n "${WAKE_ID:-}" ] && [ "${STORAGE:-s3}" = "s3" ] && [ -n "$uploader_name" ] && [ "$snapshot_ok" -eq 1 ]; then
      local after_keys
      if after_keys="$(snapshot_index_keys "$day_now")"; then
        if confirm_new_upload "$uploader_name" "$before_keys" "$after_keys"; then
          log "new index upload confirmed (not present before SIGTERM)"
          marker_ok=0
        else
          log "no index object bearing uploader name '${uploader_name}' is new since before SIGTERM under index/index/ and index/index_ for days $((day_now - INDEX_DAY_SPAN_DAYS))..${day_now} — not writing a marker (plan B territory, see ADR-0041 exit criterion 1)"
          marker_ok=1
        fi
      else
        log "post-exit index listing failed — cannot confirm a new upload this wake; treating this stop as unclean"
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
    local grafana_waited=0
    while kill -0 "$GRAFANA_PID" 2>/dev/null && [ "$grafana_waited" -lt "$GRAFANA_STOP_GRACE_SECONDS" ]; do
      sleep 1
      grafana_waited=$((grafana_waited + 1))
    done
    if kill -0 "$GRAFANA_PID" 2>/dev/null; then
      log "grafana did not exit within ${GRAFANA_STOP_GRACE_SECONDS}s of SIGTERM; exiting without it"
    else
      wait "$GRAFANA_PID" 2>/dev/null
      log "grafana exited with code $?"
    fi
  fi

  return "$marker_ok"
}
