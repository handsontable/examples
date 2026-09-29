#!/bin/bash
# containers/o11y/supervisor/entrypoint.sh — PID 1 of the Grafana box.
#
# Starts Loki and Grafana as background children and is the ONLY process
# that receives container signals (no tini/`-g`, no `init: true`): a plain
# SIGTERM to the container reaches this trap, never Loki or Grafana
# directly, so the stop protocol in shutdown.sh always runs first.
#
# A SIGKILL bypasses this script entirely (nothing traps SIGKILL) — that is
# the point: no marker is ever written for an unclean stop (ADR-0041 exit
# criterion 12).
set -u

# shellcheck source=./lib.sh
. /lib.sh
# shellcheck source=./shutdown.sh
. /shutdown.sh

LOKI_CONFIG_FILE="/etc/loki/loki-config.yaml"
if [ "${STORAGE:-s3}" = "filesystem" ]; then
  LOKI_CONFIG_FILE="/etc/loki/loki-config.filesystem.yaml"
fi

LOKI_PID=""
GRAFANA_PID=""
STOPPING=0

term_handler() {
  STOPPING=1
  log "received SIGTERM"
  run_stop_protocol
  local rc=$?
  log "stop protocol finished with status $rc"
  exit "$rc"
}
trap term_handler TERM

log "wakeId=${WAKE_ID:-<unset>} storage=${STORAGE:-s3} config=${LOKI_CONFIG_FILE}"

log "starting loki"
/usr/bin/loki -config.file="$LOKI_CONFIG_FILE" -config.expand-env=true &
LOKI_PID=$!

log "starting grafana"
grafana server \
  --homepath="${GF_PATHS_HOME:-/usr/share/grafana}" \
  --config="${GF_PATHS_CONFIG:-/etc/grafana/grafana.ini}" \
  --packaging=docker \
  cfg:default.log.mode="console" \
  cfg:default.paths.data="${GF_PATHS_DATA:-/var/lib/grafana}" \
  cfg:default.paths.logs="${GF_PATHS_LOGS:-/var/log/grafana}" \
  cfg:default.paths.plugins="${GF_PATHS_PLUGINS:-/var/lib/grafana/plugins}" \
  cfg:default.paths.provisioning="${GF_PATHS_PROVISIONING:-/etc/grafana/provisioning}" &
GRAFANA_PID=$!

log "loki pid=${LOKI_PID} grafana pid=${GRAFANA_PID}"

# Reap an unexpected crash of either child (not triggered by our own
# SIGTERM) as a hard failure, instead of hanging forever with one process
# left running.
while true; do
  wait -n "$LOKI_PID" "$GRAFANA_PID"
  rc=$?
  if [ "$STOPPING" -eq 1 ]; then
    # term_handler already ran (and will exit); nothing left to do here.
    exit "$rc"
  fi
  if ! kill -0 "$LOKI_PID" 2>/dev/null; then
    log "loki exited unexpectedly with code $rc"
    exit "$rc"
  fi
  if ! kill -0 "$GRAFANA_PID" 2>/dev/null; then
    log "grafana exited unexpectedly with code $rc"
    exit "$rc"
  fi
done
