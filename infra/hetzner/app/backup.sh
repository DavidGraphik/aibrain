#!/bin/sh
set -eu

case "${1:-}" in
  create|verify|restore) ;;
  *) echo "Usage: aibrain-backup create|verify|restore [arguments]" >&2; exit 64 ;;
esac

exec /usr/local/bin/tsx /app/scripts/backup.ts "$@"
