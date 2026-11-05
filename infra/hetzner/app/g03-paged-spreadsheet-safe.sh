#!/bin/bash
set -euo pipefail
fail() { echo 'AiBrain paged spreadsheet boundary refused to start.' >&2; exit 78; }
[ "$(id -u)" -ne 0 ] || fail
[ "$#" -eq 2 ] || fail
case "$1" in .xlsx|.xltx|.xlsm) suffix=$1 ;; *) fail ;; esac
[[ "$2" =~ ^[1-9][0-9]{0,2}$ ]] || fail
work=$(pwd -P)
[ "$(pwd -L)" = "$work" ] || fail
[[ "$work" =~ ^/tmp/aibrain-g03-paged-[A-Za-z0-9_-]+$ ]] || fail
[ "$(realpath "$work")" = "$work" ] || fail
[ -d "$work" ] && [ ! -L "$work" ] && [ "$(stat -c %a "$work")" = 700 ] && [ "$(stat -c %u "$work")" = "$(id -u)" ] || fail
source="$work/source$suffix"
[ -f "$source" ] && [ ! -L "$source" ] && [ "$(stat -c %h "$source")" -eq 1 ] || fail
[ "$(stat -c %a "$source")" = 600 ] && [ "$(stat -c %u "$source")" = "$(id -u)" ] || fail
[ -f /usr/local/share/aibrain/g03-spreadsheet-paged.py ] && [ ! -L /usr/local/share/aibrain/g03-spreadsheet-paged.py ] || fail
[ "$(stat -c %u /usr/local/share/aibrain/g03-spreadsheet-paged.py)" = 0 ] || fail
permissions=$(stat -c %a /usr/local/share/aibrain/g03-spreadsheet-paged.py)
(( (8#$permissions & 0022) == 0 )) || fail
# No writable application paths, host processes, network, sockets, home, or secrets.
exec 3<"$source"
exec 4</usr/local/share/aibrain/g03-spreadsheet-paged.py
exec /usr/bin/bwrap \
  --die-with-parent --new-session --unshare-all --cap-drop ALL \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --dev /dev --tmpfs /tmp --ro-bind-data 3 /input --ro-bind-data 4 /extractor.py --remount-ro / \
  --chdir /tmp --clearenv --setenv LANG C.UTF-8 \
  /usr/bin/python3 -I -B /extractor.py --format "$suffix" --part "$2"
