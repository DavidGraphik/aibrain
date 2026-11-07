#!/bin/sh
set -eu

fail() {
  echo "AiBrain browser sandbox refused to start: $1" >&2
  exit 78
}

[ "$(id -u)" -ne 0 ] || fail "browser must not run as root"
[ "$#" -ge 1 ] || fail "Chromium arguments are required"

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
users_root=$(read_config_path usersRoot) || fail "usersRoot is invalid"
source_root=$(read_config_path sourceReadRoot) || fail "sourceReadRoot is invalid"
publish_root=$(read_config_path publishWriteRoot) || fail "publishWriteRoot is invalid"

user_data_dir=
for argument in "$@"; do
  case "$argument" in
    --user-data-dir=*)
      [ -z "$user_data_dir" ] || fail "multiple profile roots are forbidden"
      user_data_dir=${argument#--user-data-dir=}
      ;;
  esac
done
[ -n "$user_data_dir" ] || fail "an employee profile root is required"
[ "${user_data_dir#/}" != "$user_data_dir" ] || fail "profile root must be absolute"

profile=$user_data_dir
browser_root=$(dirname "$profile")
user_root=$(dirname "$browser_root")
user_id=$(basename "$user_root")
[ "$profile" = "$browser_root/profile" ] || fail "profile is not the provisioned browser profile"
[ "$(dirname "$user_root")" = "$users_root" ] || fail "browser root is outside the configured users root"
printf %s "$user_id" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' \
  || fail "employee id is not a canonical UUID"

for root in "$data_root" "$users_root" "$user_root" "$browser_root" "$profile" "$browser_root/downloads" "$source_root" "$publish_root"; do
  [ -d "$root" ] && [ ! -L "$root" ] || fail "required browser boundary root is unsafe: $root"
  [ "$(realpath "$root")" = "$root" ] || fail "browser boundary roots may not resolve through symlinks"
done

case "$users_root/" in
  "$data_root"/*) ;;
  *) fail "users root is outside dataRoot" ;;
esac
case "$browser_root/" in
  "$users_root"/*) ;;
  *) fail "browser root is outside usersRoot" ;;
esac

if [ "${AIBRAIN_BROWSER_PREFLIGHT:-}" = entrypoint-boundary-v1 ]; then
  [ "$#" -eq 2 ] && [ "$2" = --aibrain-preflight ] || fail "browser preflight arguments are invalid"
  sibling_marker=${AIBRAIN_BROWSER_PREFLIGHT_SIBLING:-}
  publish_marker=${AIBRAIN_BROWSER_PREFLIGHT_PUBLISH:-}
  [ -n "$sibling_marker" ] && [ -n "$publish_marker" ] || fail "browser preflight markers are missing"
  set -- /bin/sh -c '[ -f "$1" ] && [ ! -e "$2" ] && [ ! -e "$3" ] && ! /bin/sh -c '\'' : >"$1" '\'' sh "$4"' sh \
    "$browser_root/.aibrain-preflight" "$sibling_marker" "$publish_marker" "$publish_root/browser-write-test"
else
  # Chromium's setuid/user-namespace sandbox cannot initialize below Docker's
  # no-new-privileges boundary and aborts before opening the inherited CDP
  # pipes. This launcher is already the browser sandbox: non-root/no caps in
  # Compose plus a private bwrap PID, IPC, UTS and filesystem namespace. Only
  # this root-owned wrapper may disable Chromium's redundant inner sandbox;
  # application-supplied --no-sandbox remains rejected by ChromeCdpRuntime.
  # Chromium creates its process-singleton Unix socket below TMPDIR. The
  # provisioned per-user path is intentionally descriptive but exceeds Linux's
  # Unix-socket path limit. `/tmp` is a private tmpfs inside this bwrap, so it is
  # both short and isolated from every other employee browser.
  export TMPDIR=/tmp
  set -- /usr/bin/chromium --no-sandbox "$@"
fi

# The browser retains the parent's network namespace solely to reach its
# per-user DNS-pinning proxy on loopback. PID/IPC/UTS and filesystem namespaces
# are private: all product data is hidden, then only this employee's browser
# root is re-exposed read-write. Official source and publisher mounts are masked.
exec /usr/bin/bwrap \
  --die-with-parent \
  --new-session \
  --unshare-pid \
  --unshare-ipc \
  --unshare-uts \
  --hostname aibrain-browser \
  --ro-bind / / \
  --dev /dev \
  --proc /proc \
  --tmpfs /tmp \
  --tmpfs /run \
  --tmpfs "$data_root" \
  --bind "$browser_root" "$browser_root" \
  --tmpfs "$source_root" \
  --remount-ro "$source_root" \
  --tmpfs "$publish_root" \
  --remount-ro "$publish_root" \
  --chdir "$browser_root" \
  "$@"
