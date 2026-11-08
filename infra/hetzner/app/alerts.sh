#!/bin/sh
set -eu

if [ "$#" -ne 4 ] || [ "${1:-}" != "--restart-count-15m" ] || [ "${3:-}" != "--preflight-failure-count-15m" ]; then
  echo "Usage: aibrain-alerts --restart-count-15m N --preflight-failure-count-15m N" >&2
  exit 64
fi

exec /usr/local/bin/tsx /app/scripts/run-operational-alerts.ts "$@"
