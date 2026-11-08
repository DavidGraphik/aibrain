#!/bin/sh
set -eu

case "${1:-}" in
  --apply|--dry-run) ;;
  --grace-ms|--retention-ms) ;;
  "") ;;
  *) echo "Usage: aibrain-document-maintenance [--dry-run|--apply] [--grace-ms N] [--retention-ms N]" >&2; exit 64 ;;
esac

exec /usr/local/bin/tsx /app/scripts/maintain-document-temporaries.ts "$@"
