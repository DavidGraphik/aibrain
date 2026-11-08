#!/bin/sh
set -eu

umask 077

fail() {
  echo "AiBrain container preflight failed: $1" >&2
  exit 78
}

require_value() {
  variable_name=$1
  variable_value=$(printenv "$variable_name" 2>/dev/null || true)
  [ -n "$variable_value" ] || fail "$variable_name is required"
  case "$variable_value" in
    replace-*|*replace_me*|000.0.0000.0) fail "$variable_name still contains an example value" ;;
  esac
}

require_secret() {
  variable_name=$1
  require_value "$variable_name"
  variable_value=$(printenv "$variable_name")
  byte_length=$(printf %s "$variable_value" | wc -c | tr -d ' ')
  [ "$byte_length" -ge 32 ] || fail "$variable_name must contain at least 32 bytes"
}

[ "$(id -u)" -ne 0 ] || fail "the application must not run as root"
[ "${NODE_ENV:-}" = production ] || fail "NODE_ENV must be production"
[ "${AIBRAIN_AUTH_MODE:-}" = supabase ] || fail "AIBRAIN_AUTH_MODE must be supabase"
[ "${CHAT_RUNTIME:-}" = codex ] || fail "CHAT_RUNTIME must be codex"
[ "${CODEX_BIN:-}" = /usr/local/bin/aibrain-codex-worker ] || fail "CODEX_BIN must use the worker filesystem sandbox"
[ "${AIBRAIN_CHROME_BIN:-}" = /usr/local/bin/aibrain-chrome ] || fail "AIBRAIN_CHROME_BIN must use the employee browser filesystem sandbox"
[ "${AIBRAIN_SOFFICE_BIN:-}" = /usr/local/bin/aibrain-soffice ] || fail "LibreOffice must use the safe headless wrapper"
[ "${AIBRAIN_PDFINFO_BIN:-}" = /usr/local/bin/aibrain-pdfinfo ] || fail "pdfinfo must use the document filesystem sandbox"
[ "${AIBRAIN_PDFTOPPM_BIN:-}" = /usr/local/bin/aibrain-pdftoppm ] || fail "pdftoppm must use the document filesystem sandbox"
[ "${AIBRAIN_PDFTOTEXT_BIN:-}" = /usr/local/bin/aibrain-pdftotext ] || fail "pdftotext must use the document filesystem sandbox"
[ "${AIBRAIN_QPDF_BIN:-}" = /usr/local/bin/aibrain-qpdf ] || fail "qpdf must use the document filesystem sandbox"

require_secret AIBRAIN_SESSION_SECRET
require_secret AIBRAIN_AUTH_CHALLENGE_SECRET
require_secret AIBRAIN_PUBLICATION_SECRET
require_secret AIBRAIN_BROWSER_GATEWAY_SECRET
require_secret AIBRAIN_MAINTENANCE_SECRET
require_value NEXT_PUBLIC_SUPABASE_URL
require_value NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
require_value AIBRAIN_CHROME_EXPECTED_VERSION
[ "${AIBRAIN_CODEX_EXPECTED_VERSION:-}" = 0.162.1 ] || fail "AIBRAIN_CODEX_EXPECTED_VERSION must be the contract-pinned version 0.162.1"

node -e '
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    process.exit(64);
  }
' || fail "NEXT_PUBLIC_SUPABASE_URL must be a credential-free HTTPS origin"

server_proxy_url=$(node /usr/local/share/aibrain/configure-egress.mjs) \
  || fail "authenticated egress policy is invalid"
export NODE_USE_ENV_PROXY=1
export HTTP_PROXY=$server_proxy_url
export HTTPS_PROXY=$server_proxy_url
export ALL_PROXY=$server_proxy_url
export NO_PROXY=127.0.0.1,localhost,::1
unset server_proxy_url

printf %s "$AIBRAIN_CHROME_EXPECTED_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "AIBRAIN_CHROME_EXPECTED_VERSION must be an exact four-part version"

config_path=${AIBRAIN_INSTALLATION_CONFIG:-/etc/aibrain/installation.json}
[ "$config_path" = /etc/aibrain/installation.json ] || fail "installation config must use the immutable container path"
[ -f "$config_path" ] && [ ! -L "$config_path" ] || fail "installation config must be a regular non-symlink file"

node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const expected = {
    dataRoot: "/var/lib/aibrain/data",
    companyContextRoot: "/var/lib/aibrain/data/company-context",
    usersRoot: "/var/lib/aibrain/data/users",
    sourceReadRoot: "/srv/aibrain/source-ro",
    publishWriteRoot: "/srv/aibrain/publish-rw",
    backupsRoot: "/var/lib/aibrain/data/backups",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (config?.paths?.[key] !== value) {
      throw new Error(`installation paths.${key} must be ${value} inside the container`);
    }
  }
' "$config_path" || fail "installation config does not match the container mount contract"

[ -d /var/lib/aibrain/data ] && [ -w /var/lib/aibrain/data ] || fail "data volume is not writable by the application user"
[ -d /var/lib/aibrain/data/backups ] && [ -w /var/lib/aibrain/data/backups ] || fail "backup volume is not writable by the application user"
[ -d /var/lib/aibrain-restores ] && [ -w /var/lib/aibrain-restores ] || fail "restore validation volume is not writable by the application user"
[ -d /srv/aibrain/source-ro ] && [ ! -w /srv/aibrain/source-ro ] || fail "source-ro is missing or writable"
[ -d /srv/aibrain/publish-rw ] && [ -w /srv/aibrain/publish-rw ] || fail "publish-rw is missing or not writable by the server publisher"

for private_directory in \
  /var/lib/aibrain/data/app-home \
  /var/lib/aibrain/data/company-context \
  /var/lib/aibrain/data/users \
  /var/lib/aibrain/data/server/xdg/cache \
  /var/lib/aibrain/data/server/xdg/config \
  /var/lib/aibrain/data/server/xdg/data \
  /var/lib/aibrain/data/server/xdg/state; do
  mkdir -p "$private_directory"
  chmod 0700 "$private_directory"
done

for executable in \
  /usr/local/bin/codex-real \
  /usr/local/bin/aibrain-codex-worker \
  /usr/local/bin/aibrain-chrome \
  /usr/local/bin/aibrain-soffice \
  /usr/local/bin/aibrain-pdfinfo \
  /usr/local/bin/aibrain-pdftoppm \
  /usr/local/bin/aibrain-pdftotext \
  /usr/local/bin/aibrain-qpdf \
  /usr/local/bin/aibrain-backup \
  /usr/local/bin/aibrain-backup-replicate \
  /usr/local/bin/aibrain-alerts \
  /usr/local/share/aibrain/configure-egress.mjs \
  /usr/bin/bwrap \
  /usr/bin/chromium \
  /usr/bin/soffice \
  /usr/bin/pdfinfo \
  /usr/bin/pdftoppm \
  /usr/bin/pdftotext \
  /usr/bin/python3 \
  /usr/bin/qpdf \
  /usr/bin/restic; do
  [ -x "$executable" ] || fail "required executable is unavailable: $executable"
done

actual_chrome_version=$(/usr/bin/chromium --version | sed -n 's/^[^0-9]*\([0-9][0-9.]*\).*$/\1/p')
[ "$actual_chrome_version" = "$AIBRAIN_CHROME_EXPECTED_VERSION" ] || fail "Chromium does not match AIBRAIN_CHROME_EXPECTED_VERSION"

actual_codex_version=$(/usr/local/bin/codex-real --version | sed -n 's/^codex-cli \([0-9][0-9.]*\)$/\1/p')
[ "$actual_codex_version" = "$AIBRAIN_CODEX_EXPECTED_VERSION" ] || fail "Codex does not match the generated App Server contracts"

# Fail closed when the host cannot create the worker mount namespace, hide the
# product data root, selectively re-expose an approved read root, or mask the
# official publisher root. There is deliberately no unsandboxed fallback.
boundary_marker=$(mktemp /srv/aibrain/publish-rw/.aibrain-boundary.XXXXXX)
hidden_marker=$(mktemp /var/lib/aibrain/data/.aibrain-hidden.XXXXXX)
allowed_marker=$(mktemp /var/lib/aibrain/data/company-context/.aibrain-allowed.XXXXXX)
trap 'rm -f "$boundary_marker" "$hidden_marker" "$allowed_marker"' EXIT INT TERM
/usr/bin/bwrap \
  --ro-bind / / \
  --dev /dev \
  --proc /proc \
  --unshare-pid \
  --unshare-ipc \
  --tmpfs /var/lib/aibrain/data \
  --ro-bind /var/lib/aibrain/data/company-context /var/lib/aibrain/data/company-context \
  --tmpfs /srv/aibrain/publish-rw \
  --remount-ro /srv/aibrain/publish-rw \
  /bin/sh -c '[ ! -e "$1" ] && [ -f "$2" ] && ! /bin/sh -c '\'' : >"$1" '\'' sh "$2" && [ ! -e "$3" ] && ! /bin/sh -c '\'' : >"$1" '\'' sh "$4"' sh \
    "$hidden_marker" "$allowed_marker" \
    "$boundary_marker" /srv/aibrain/publish-rw/worker-write-test \
  >/dev/null 2>&1 || fail "bubblewrap worker isolation is unavailable on this host"
rm -f "$boundary_marker" "$hidden_marker" "$allowed_marker"
trap - EXIT INT TERM

# Exercise the exact document launcher. Conversion must see only its private
# work directory; product state and the official publisher mount stay hidden.
document_test_user=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
document_test_thread=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
document_test_upload=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
document_test_user_root=/var/lib/aibrain/data/users/$document_test_user
document_preview_root=$document_test_user_root/state/document-previews/$document_test_thread/$document_test_upload
mkdir -p "$document_preview_root"
document_work=$(mktemp -d "$document_preview_root/.work-XXXXXX")
document_hidden_marker=$(mktemp /var/lib/aibrain/data/.aibrain-document-hidden.XXXXXX)
document_publish_marker=$(mktemp /srv/aibrain/publish-rw/.aibrain-document-publish.XXXXXX)
trap 'rm -rf "$document_test_user_root"; rm -f "$document_hidden_marker" "$document_publish_marker"' EXIT INT TERM
for document_launcher in soffice pdfinfo pdftoppm pdftotext qpdf; do
  (
    cd "$document_work"
    AIBRAIN_DOCUMENT_SANDBOX_PREFLIGHT=entrypoint-boundary-v1 \
    AIBRAIN_DOCUMENT_PREFLIGHT_HIDDEN=$document_hidden_marker \
    AIBRAIN_DOCUMENT_PREFLIGHT_PUBLISH=$document_publish_marker \
      /usr/local/bin/aibrain-$document_launcher --aibrain-preflight
  ) >/dev/null 2>&1 || fail "bubblewrap document isolation is unavailable for $document_launcher"
  [ -f "$document_work/preflight-aibrain-$document_launcher-ok" ] \
    || fail "document isolation did not preserve the $document_launcher private work directory"
done
rm -rf "$document_test_user_root"
rm -f "$document_hidden_marker" "$document_publish_marker"
trap - EXIT INT TERM

# Exercise the exact browser launcher too. A synthetic employee marker must be
# visible, while a sibling employee and the official publisher marker remain
# hidden. Only these newly-created synthetic roots are removed afterwards.
browser_test_user=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
browser_sibling_user=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
browser_test_root=/var/lib/aibrain/data/users/$browser_test_user
browser_sibling_root=/var/lib/aibrain/data/users/$browser_sibling_user
mkdir -p "$browser_test_root/browser/profile" "$browser_test_root/browser/downloads" "$browser_sibling_root/browser"
browser_own_marker=$browser_test_root/browser/.aibrain-preflight
browser_sibling_marker=$browser_sibling_root/browser/.aibrain-preflight
browser_publish_marker=$(mktemp /srv/aibrain/publish-rw/.aibrain-browser-boundary.XXXXXX)
: >"$browser_own_marker"
: >"$browser_sibling_marker"
trap 'rm -rf "$browser_test_root" "$browser_sibling_root"; rm -f "$browser_publish_marker"' EXIT INT TERM
AIBRAIN_BROWSER_PREFLIGHT=entrypoint-boundary-v1 \
AIBRAIN_BROWSER_PREFLIGHT_SIBLING=$browser_sibling_marker \
AIBRAIN_BROWSER_PREFLIGHT_PUBLISH=$browser_publish_marker \
  /usr/local/bin/aibrain-chrome \
  --user-data-dir="$browser_test_root/browser/profile" \
  --aibrain-preflight \
  >/dev/null 2>&1 || fail "bubblewrap browser isolation is unavailable on this host"
rm -rf "$browser_test_root" "$browser_sibling_root"
rm -f "$browser_publish_marker"
trap - EXIT INT TERM

# A version check proves only that a binary exists. Exercise the packaged
# worker launcher, private gateway, durable journals and real Codex App Server
# protocol across a clean process restart before this container can become
# globally ready. The inherited marker belongs to this exact startup only.
node /usr/local/share/aibrain/container-app-server-acceptance.mjs \
  || fail "Codex App Server protocol acceptance failed"
export AIBRAIN_CODEX_APP_SERVER_ACCEPTED=1

exec "$@"
