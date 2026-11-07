#!/usr/bin/env bash
# Install as a root systemd timer on the installation host. No database secrets
# are passed on the command line or printed to logs.
set -euo pipefail
umask 077
config=/etc/aibrain/company-qa/horaria
compose=/opt/aibrain-company-qa/ghcr-ops/horaria.compose.yaml
root=/var/lib/docker/volumes/aibrain-company-qa-backups/_data/horaria
[[ "$(id -u)" == 0 ]]
install -d -m 700 "$root"
exec 8>"$config/backup.lock"
flock --exclusive --nonblock 8
dc() { docker compose --env-file "$config/compose.env" -f "$compose" "$@"; }
target="$root/horaria-$(date -u +%Y%m%dT%H%M%SZ).dump"
trap 'rm -f "$target.pending"' EXIT
dc exec -T horaria-db pg_dump -U horaria -d horaria -Fc > "$target.pending"
[[ -s "$target.pending" ]]
dc exec -T horaria-db pg_restore --list < "$target.pending" >/dev/null
mv "$target.pending" "$target"
sha256sum "$target" > "$target.sha256"
# Customer data and source migration backups are never pruned by this script.
printf 'HORARIA_BACKUP_OK %s\n' "$(basename "$target")"
