#!/bin/sh
set -eu

umask 077

interval=${AIBRAIN_ALERT_INTERVAL_SECONDS:-60}
case "$interval" in
  ''|*[!0-9]*) echo "AIBRAIN_ALERT_INTERVAL_SECONDS must be an integer" >&2; exit 64 ;;
esac
[ "$interval" -ge 15 ] && [ "$interval" -le 3600 ] \
  || { echo "AIBRAIN_ALERT_INTERVAL_SECONDS must be between 15 and 3600" >&2; exit 64; }
if [ "${AIBRAIN_ALERT_SINK:-}" = file ]; then
  [ "${AIBRAIN_G03_RECOVERY_DECISION:-}" = host-loss-risk-accepted-20261005 ] \
    || { echo "Local alert collection needs the explicit G03 host-only decision" >&2; exit 78; }
  node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(process.env.AIBRAIN_INSTALLATION_CONFIG,"utf8")); if(c.installationId!=="g03-production" || c.publicUrl!=="https://g03.graphikai.com")process.exit(78)'
  echo "G03: local operational alert collection; no external notification or host-loss coverage."
else
[ "${AIBRAIN_ALERT_SINK:-}" = webhook ] \
  || { echo "AIBRAIN_ALERT_SINK=webhook is required" >&2; exit 78; }
[ -n "${AIBRAIN_ALERT_WEBHOOK_URL:-}" ] \
  || { echo "AIBRAIN_ALERT_WEBHOOK_URL is required" >&2; exit 78; }
fi

while :; do
  status=$(/usr/local/bin/aibrain-alerts \
    --restart-count-15m "${AIBRAIN_ALERT_RESTART_COUNT_15M:-0}" \
    --preflight-failure-count-15m "${AIBRAIN_ALERT_PREFLIGHT_FAILURE_COUNT_15M:-0}")
  printf '%s\n' "$status"
  printf '%s\n' "$status" > /tmp/.aibrain-alert-controller-status.pending
  chmod 0600 /tmp/.aibrain-alert-controller-status.pending
  mv /tmp/.aibrain-alert-controller-status.pending /tmp/aibrain-alert-controller-status.json
  date +%s > /tmp/.aibrain-alert-controller-heartbeat.pending
  chmod 0600 /tmp/.aibrain-alert-controller-heartbeat.pending
  mv /tmp/.aibrain-alert-controller-heartbeat.pending /tmp/aibrain-alert-controller-heartbeat
  sleep "$interval"
done
