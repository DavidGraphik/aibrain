#!/bin/bash
set -euo pipefail
fail() { echo 'AiBrain passive XLS boundary refused to start.' >&2; exit 78; }
[ "$(id -u)" -ne 0 ] || fail
[ "$#" -eq 0 ] || fail
work=$(pwd -P)
[ "$(pwd -L)" = "$work" ] || fail
[[ "$work" =~ ^/tmp/aibrain-passive-xls-[A-Za-z0-9_-]+$ ]] || fail
[ "$(realpath "$work")" = "$work" ] || fail
[ -f "$work/source.biff" ] && [ ! -L "$work/source.biff" ] || fail
[ -d "$work/output" ] && [ ! -L "$work/output" ] || fail
[ "$(stat -c %h "$work/source.biff")" -eq 1 ] || fail
[ "$(stat -c %a "$work")" = 700 ] || fail
[ "$(stat -c %a "$work/source.biff")" = 600 ] || fail
[ "$(stat -c %a "$work/output")" = 700 ] || fail
ulimit -t 35
ulimit -f 81920
ulimit -v 786432
# A fresh root exposes only immutable program libraries and this one input/output.
# No application directory, customer data, auth, home, sockets or host /proc.
exec /usr/bin/bwrap \
  --die-with-parent --new-session --unshare-all --cap-drop ALL \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --ro-bind /opt/aibrain-passive-xls /opt/aibrain-passive-xls \
  --dev /dev --tmpfs /tmp --dir /work --dir /work/output \
  --ro-bind "$work/source.biff" /work/source.biff \
  --bind "$work/output" /work/output \
  --remount-ro / --chdir /work --clearenv \
  --setenv HOME /tmp --setenv LANG C.UTF-8 --setenv LC_ALL C.UTF-8 \
  /opt/aibrain-passive-xls/bin/python -I -B /usr/local/share/aibrain/xls-passive-read.py
