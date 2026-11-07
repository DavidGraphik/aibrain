#!/usr/bin/env python3
"""Trigger the existing bounded maintainer before bytes or inodes are exhausted.

This watchdog has no deletion code. The existing maintainer retains its own
storage/deployment locks, allowlist and recovery checks.
"""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time

GIB = 1024 ** 3
SERVICE = "aibrain-storage-maintain.service"
LOCK = Path("/run/lock/aibrain-storage.lock")
STATE = Path("/run/aibrain-storage-pressure/latest.json")


def measure():
    stat = os.statvfs("/")
    return {
        "free_bytes": stat.f_bavail * stat.f_frsize,
        "free_inode_percent": 100 * stat.f_favail / stat.f_files if stat.f_files else 100,
    }


def under_pressure(reading, minimum_gib, minimum_inode_percent):
    return reading["free_bytes"] < minimum_gib * GIB or reading["free_inode_percent"] < minimum_inode_percent


def maintenance_busy():
    # This is only a preflight. The maintainer acquires this lock itself, so a
    # deployment starting after this probe remains protected by its own check.
    with LOCK.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False


def load_state():
    try:
        value = json.loads(STATE.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(report):
    # /run is tmpfs: reports cannot consume the customer data disk. Only the
    # latest bounded report is retained, with normal bounded journald history.
    try:
        STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        pending = STATE.with_suffix(".pending")
        with pending.open("w") as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(report, handle, sort_keys=True)
            handle.write("\n")
        pending.replace(STATE)
    except OSError:
        pass  # The journal/stdout report remains available if /run is full.


def evaluate(minimum_gib, minimum_inode_percent=5, cooldown_seconds=1800, check_only=False):
    before = measure()
    now = time.time()
    previous = load_state()
    last_attempt = previous.get("last_attempt", 0)
    if not isinstance(last_attempt, (int, float)) or last_attempt < 0 or last_attempt > now:
        last_attempt = 0
    report = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "before": before,
        "minimum_free_gib": minimum_gib,
        "minimum_free_inode_percent": minimum_inode_percent,
        "last_attempt": last_attempt,
    }
    if not under_pressure(before, minimum_gib, minimum_inode_percent):
        report["status"] = "healthy"
    elif check_only:
        report["status"] = "pressure_detected"
    elif maintenance_busy():
        report["status"] = "deferred_storage_lock"
    # Even critical pressure never permits more frequent than the five-minute
    # timer. Normal unresolved pressure scans are limited to twice an hour.
    elif now - last_attempt < (min(cooldown_seconds, 300) if before["free_bytes"] < GIB else cooldown_seconds):
        report["status"] = "deferred_cooldown"
    else:
        report["last_attempt"] = now
        try:
            # The existing unit prevents duplicate maintenance jobs. A timeout
            # ends only our wait; it never kills an in-flight cleanup/activation.
            result = subprocess.run(
                ["systemctl", "start", "--wait", SERVICE],
                check=False, timeout=420, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            report["maintenance_exit_code"] = result.returncode
            report["after"] = measure()
            report["status"] = (
                "maintenance_failed" if result.returncode else
                "insufficient_safe_reclaim" if under_pressure(report["after"], minimum_gib, minimum_inode_percent) else
                "recovered"
            )
        except (OSError, subprocess.TimeoutExpired):
            report["status"] = "maintenance_unavailable"
    if not check_only:
        save_state(report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--min-free-gib", type=float, required=True)
    parser.add_argument("--min-free-inode-percent", type=float, default=5)
    parser.add_argument("--check", action="store_true", help="Read-only pressure report; no maintenance or status write")
    args = parser.parse_args()
    if args.min_free_gib <= 0 or not 0 < args.min_free_inode_percent < 100:
        parser.error("Thresholds must be positive; inode threshold must be below 100")
    report = evaluate(args.min_free_gib, args.min_free_inode_percent, check_only=args.check)
    print(json.dumps(report, sort_keys=True))
    return 1 if report["status"] in {"insufficient_safe_reclaim", "maintenance_failed", "maintenance_unavailable"} else 0


if __name__ == "__main__":
    raise SystemExit(main())
