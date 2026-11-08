#!/bin/sh
set -eu

if [ "$#" -ne 2 ] || [ "${1:-}" != "--snapshot" ] || [ -z "${2:-}" ]; then
  echo "Usage: aibrain-backup-replicate --snapshot /absolute/snapshot/root" >&2
  exit 64
fi

exec /usr/local/bin/tsx /app/scripts/replicate-backup.ts "$@"
