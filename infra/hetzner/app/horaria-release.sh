#!/usr/bin/env bash
set -euo pipefail
umask 077
config=/etc/aibrain/company-qa/horaria
compose=/opt/aibrain-company-qa/ghcr-ops/horaria.compose.yaml
image="${1:?immutable image required}"
revision="${2:?revision required}"
[[ "$image" =~ ^ghcr.io/arnautxu/aibrain@sha256:[0-9a-f]{64}$ ]]
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
[[ -f "$config/compose.env" && ! -L "$config/compose.env" ]]
[[ "$(stat -c %u "$config/compose.env")" == 0 ]]
[[ -f "$compose" && ! -L "$compose" && "$(stat -c %u "$compose")" == 0 ]]
exec 8>"$config/release.lock"
flock --exclusive --nonblock 8
dc() { docker compose --env-file "$config/compose.env" -f "$compose" "$@"; }
existing="$(dc ps -q horaria)"
cp "$config/compose.env" "$config/compose.env.previous"
awk -v image="$image" -v revision="$revision" '
  /^AIBRAIN_IMAGE=/ { print "AIBRAIN_IMAGE=" image; next }
  /^AIBRAIN_REVISION=/ { print "AIBRAIN_REVISION=" revision; next }
  { print }
' "$config/compose.env.previous" > "$config/compose.env.pending"
mv "$config/compose.env.pending" "$config/compose.env"
recover() {
  status=$?
  if (( status != 0 )); then
    cp "$config/compose.env.previous" "$config/compose.env"
    if [[ -n "$existing" ]]; then dc up -d --no-deps --wait --wait-timeout 120 horaria >/dev/null || true; fi
    echo 'HORARIA_DEPLOY_FAILED: previous service input restored; inspect database migration before retry' >&2
  fi
  exit "$status"
}
trap recover EXIT
dc up -d --wait --wait-timeout 120 horaria-db
dc run --rm --no-deps --entrypoint node horaria /opt/aibrain-horaria/node_modules/prisma/build/index.js migrate deploy --schema /opt/aibrain-horaria/prisma/schema.prisma
dc up -d --no-deps --wait --wait-timeout 120 horaria
container="$(dc ps -q horaria)"
actual="$(docker inspect --format '{{.Image}}' "$container")"
[[ "$actual" == "$(docker image inspect --format '{{.Id}}' "$image")" ]]
[[ "$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")" == "$revision" ]]
jq -n --arg revision "$revision" --arg image "$image" '{revision:$revision,image:$image,verifiedAt:(now|todateiso8601)}' > "$config/release.json.pending"
mv "$config/release.json.pending" "$config/release.json"
echo "HORARIA_DEPLOY_OK revision=$revision"
