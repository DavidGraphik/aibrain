#!/bin/sh
set -eu

fail() {
  echo "AiBrain worker sandbox refused to start: $1" >&2
  exit 78
}

[ "$(id -u)" -ne 0 ] || fail "workers must not run as root"
[ "$#" -ge 1 ] || fail "Codex App Server arguments are required"
[ "${1:-}" = app-server ] || fail "only codex app-server may use the worker launcher"

config_path=/etc/aibrain/installation.json
[ -f "$config_path" ] && [ ! -L "$config_path" ] || fail "installation config is unavailable"

read_config_path() {
  config_key=$1
  node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const value = config?.paths?.[process.argv[2]];
  if (typeof value !== "string" || !path.isAbsolute(value) || value === "/" || /[\0\r\n]/.test(value)) process.exit(64);
  process.stdout.write(path.resolve(value));
' "$config_path" "$config_key"
}

data_root=$(read_config_path dataRoot) || fail "dataRoot is invalid"
company_root=$(read_config_path companyContextRoot) || fail "companyContextRoot is invalid"
users_root=$(read_config_path usersRoot) || fail "usersRoot is invalid"
source_root=$(read_config_path sourceReadRoot) || fail "sourceReadRoot is invalid"
publish_root=$(read_config_path publishWriteRoot) || fail "publishWriteRoot is invalid"

workspace=$(pwd -P)
user_root=$(dirname "$workspace")
runtime_root=$user_root/runtime
staging_root=$user_root/staging
uploaded_documents_root=$staging_root/threads
artifacts_root=$user_root/artifacts
transport_audit_root=$user_root/audit/transport

[ "$workspace" = "$user_root/workspace" ] || fail "working directory is not the provisioned employee workspace"
[ "$(dirname "$user_root")" = "$users_root" ] || fail "working directory is outside the configured users root"
[ "${HOME:-}" = "$runtime_root/home" ] || fail "HOME is not bound to the provisioned employee"
[ "${CODEX_HOME:-}" = "$runtime_root/codex-home" ] || fail "CODEX_HOME is not bound to the provisioned employee"
[ "${XDG_CACHE_HOME:-}" = "$runtime_root/xdg/cache" ] || fail "XDG cache is not employee-private"
[ "${XDG_CONFIG_HOME:-}" = "$runtime_root/xdg/config" ] || fail "XDG config is not employee-private"
[ "${XDG_DATA_HOME:-}" = "$runtime_root/xdg/data" ] || fail "XDG data is not employee-private"
[ "${XDG_STATE_HOME:-}" = "$runtime_root/xdg/state" ] || fail "XDG state is not employee-private"
[ "${TMPDIR:-}" = "$staging_root/tmp" ] || fail "TMPDIR is not employee-private"

for writable_root in "$runtime_root" "$workspace" "$staging_root" "$artifacts_root" "$transport_audit_root"; do
  [ -d "$writable_root" ] && [ ! -L "$writable_root" ] || fail "unsafe worker root: $writable_root"
  canonical_root=$(realpath "$writable_root")
  [ "$canonical_root" = "$writable_root" ] || fail "worker roots may not resolve through symlinks"
done
[ -d "$uploaded_documents_root" ] && [ ! -L "$uploaded_documents_root" ] || fail "uploaded document root is unsafe"
[ "$(realpath "$uploaded_documents_root")" = "$uploaded_documents_root" ] || fail "uploaded document root may not resolve through symlinks"

[ -d "$publish_root" ] && [ ! -L "$publish_root" ] || fail "publish root is unavailable"
[ "$(realpath "$publish_root")" = "$publish_root" ] || fail "publish root may not resolve through symlinks"
[ -d "$data_root" ] && [ ! -L "$data_root" ] || fail "data root is unavailable"
[ -d "$company_root" ] && [ ! -L "$company_root" ] || fail "company context root is unavailable"
[ -d "$source_root" ] && [ ! -L "$source_root" ] || fail "source read root is unavailable"
[ "$(realpath "$data_root")" = "$data_root" ] || fail "data root may not resolve through symlinks"
[ "$(realpath "$company_root")" = "$company_root" ] || fail "company context root may not resolve through symlinks"
[ "$(realpath "$source_root")" = "$source_root" ] || fail "source read root may not resolve through symlinks"

case "$company_root/" in
  "$data_root"/*) ;;
  *) fail "company context root is outside dataRoot" ;;
esac
case "$users_root/" in
  "$data_root"/*) ;;
  *) fail "users root is outside dataRoot" ;;
esac
case "$user_root/" in
  "$users_root"/*) ;;
  *) fail "employee root is outside usersRoot" ;;
esac

for private_context_file in PROFILE.md PREFERENCES.md PERMISSIONS.md; do
  context_path=$user_root/$private_context_file
  [ -f "$context_path" ] && [ ! -L "$context_path" ] || fail "employee context is unavailable: $private_context_file"
done

# The app opens and locks the generation inode with O_NOFOLLOW. Keep that
# descriptor in bwrap's monitor for the entire sandbox lifetime; model children
# cannot access the app-owned audit path or release this monitor descriptor.
worker_sync_options=
if [ "${AIBRAIN_WORKER_LOCK_FD:-}" = 3 ]; then
  node -e '
  const fs=require("node:fs"),path=require("node:path");
  const target=fs.readlinkSync("/proc/self/fd/3"),s=fs.fstatSync(3),entry=fs.lstatSync(target);
  if(path.dirname(target)!==process.argv[1]||!/[a-f0-9-]{36}\.lock$/.test(path.basename(target))||
     !s.isFile()||s.nlink!==1||(s.mode&63)!==0||s.uid!==process.getuid()||entry.isSymbolicLink()||
     s.dev!==entry.dev||s.ino!==entry.ino)process.exit(78);
' "$transport_audit_root/kernel-owners" || fail "unsafe worker ownership descriptor"
  worker_sync_options="--sync-fd 3"
fi
unset AIBRAIN_WORKER_LOCK_FD

# The launcher has finished reading the operator config. Hide it from the model
# worker along with the complete product dataRoot after mounting the root read-only.
# Only company context, source-ro, this employee's explicit Markdown context and
# declared writable roots and the employee's upload directory are re-exposed.
# Transport audit logs stay hidden; the parent gateway persists them outside
# this mount namespace.
# Uploads are read-only at `staging/threads`; only `staging/tmp` remains
# writable. This prevents credential theft from browser profiles, local
# sessions, backups or sibling employees.
exec /usr/bin/bwrap \
  $worker_sync_options \
  --die-with-parent \
  --new-session \
  --unshare-pid \
  --unshare-ipc \
  --unshare-uts \
  --hostname aibrain-worker \
  --ro-bind / / \
  --dev /dev \
  --proc /proc \
  --tmpfs /tmp \
  --tmpfs /run \
  --tmpfs /etc/aibrain \
  --remount-ro /etc/aibrain \
  --tmpfs /usr/local/share/aibrain/internal-agent-context \
  --tmpfs "$data_root" \
  --ro-bind "$company_root" "$company_root" \
  --ro-bind "$source_root" "$source_root" \
  --ro-bind "$user_root/PROFILE.md" "$user_root/PROFILE.md" \
  --ro-bind "$user_root/PREFERENCES.md" "$user_root/PREFERENCES.md" \
  --ro-bind "$user_root/PERMISSIONS.md" "$user_root/PERMISSIONS.md" \
  --tmpfs "$publish_root" \
  --remount-ro "$publish_root" \
  --bind "$runtime_root" "$runtime_root" \
  --bind "$workspace" "$workspace" \
  --ro-bind "$uploaded_documents_root" "$uploaded_documents_root" \
  --bind "$staging_root/tmp" "$staging_root/tmp" \
  --bind "$artifacts_root" "$artifacts_root" \
  --chdir "$workspace" \
  /usr/local/bin/codex-real "$@"
