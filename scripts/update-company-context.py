#!/usr/bin/env python3
"""Operator-only content update. Dry-run by default; preserves policy and originals.

Run on the host, never in an employee worker. Keep the private revision directory
outside company-context. Atomic files, whole-input compare-and-swap, reversible
receipt. Run while no company-context writer is active; this is not an ACL tool.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import shutil
import tempfile
import uuid


def digest(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def real_directory(value):
    result = pathlib.Path(value)
    if not result.is_absolute() or result.is_symlink() or result.resolve() != result or not result.is_dir():
        raise ValueError("A canonical real absolute directory is required")
    return result


def inventory(root):
    result = {}
    for file in sorted(root.rglob("*")):
        if file.is_symlink():
            raise ValueError("Symlinks are forbidden")
        if file.is_dir():
            continue
        if not file.is_file() or file.stat().st_size > 8 * 1024 * 1024:
            raise ValueError("Only bounded regular files are allowed")
        result[str(file.relative_to(root))] = digest(file.read_bytes())
    return result


def atomic(file, data, mode, uid, gid):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # New directories must be readable by the installation's runtime owner.
    if os.geteuid() == 0:
        os.chown(file.parent, uid, gid)
    fd, temporary = tempfile.mkstemp(prefix=".context-update-", dir=file.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            if os.geteuid() == 0:
                os.fchown(stream.fileno(), uid, gid)
            os.fsync(stream.fileno())
        os.replace(temporary, file)
        directory_fd = os.open(file.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--revisions", required=True)
    parser.add_argument("--source")
    parser.add_argument("--expected", help="Exact plan fingerprint from dry-run")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--rollback", help="Private revision directory name")
    args = parser.parse_args()
    root, revisions = real_directory(args.root), real_directory(args.revisions)
    if root == revisions or root in revisions.parents or revisions in root.parents:
        raise ValueError("Revisions must be outside the shared company root")
    if revisions.stat().st_mode & 0o077:
        raise ValueError("Revision directory must be private (0700)")
    with open(revisions / ".update.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.rollback:
            if pathlib.Path(args.rollback).name != args.rollback or args.rollback in (".", ".."):
                raise ValueError("Invalid revision")
            revision = real_directory(str(revisions / args.rollback))
            receipt = json.loads((revision / "receipt.json").read_text())
            if inventory(real_directory(str(revision / "before"))) != receipt["before"]:
                raise ValueError("Backup integrity failed; no active files were changed")
            current = inventory(root)
            recoverable = set(current).issubset(set(receipt["after"])) and all(
                current.get(name) in (receipt["before"].get(name), receipt["after"].get(name))
                for name in receipt["after"]
            )
            if receipt["root"] != str(root) or not recoverable:
                raise ValueError("Rollback conflict: active files changed after this revision")
            if not args.apply:
                print(json.dumps({"rollback": args.rollback, "changes": receipt["changes"], "apply": False}))
                return
            for name in reversed(receipt["changes"]):
                destination = root / name
                if name in receipt["before"]:
                    old = revision / "before" / name
                    stat = old.stat()
                    atomic(destination, old.read_bytes(), stat.st_mode & 0o777, receipt["uid"], receipt["gid"])
                else:
                    destination.unlink(missing_ok=True)
            if inventory(root) != receipt["before"]:
                raise ValueError("Rollback readback failed")
            print(json.dumps({"rolledBack": args.rollback, "verified": True}))
            return
        if not args.source:
            raise ValueError("--source is required")
        source = real_directory(args.source)
        if source == root or root in source.parents or source in root.parents:
            raise ValueError("Source bundle must be separate")
        before, proposed = inventory(root), inventory(source)
        if not proposed or len(proposed) > 128 or any(
            not name.endswith(".md") or pathlib.Path(name).name == "PERMISSIONS.md"
            for name in proposed
        ):
            raise ValueError("Bundle must contain 1-128 Markdown documents, never permissions")
        fingerprint = digest(encoded({"root": str(root), "before": before, "proposed": proposed}))
        changes = [name for name, value in proposed.items() if before.get(name) != value]
        plan = {"fingerprint": fingerprint, "changes": changes, "preserved": len(before) - sum(name in before for name in changes)}
        if not args.apply:
            print(json.dumps(plan))
            return
        if args.expected != fingerprint:
            raise ValueError("Plan conflict: obtain and review a fresh dry-run")
        if not changes:
            print(json.dumps({**plan, "verified": True, "unchanged": True}))
            return
        name = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
        revision = revisions / name
        revision.mkdir(mode=0o700)
        shutil.copytree(root, revision / "before")
        owner = root.stat()
        expected_after = {**before, **proposed}
        receipt = {"root": str(root), "before": before, "after": expected_after, "changes": changes,
                   "uid": owner.st_uid, "gid": owner.st_gid, "plan": fingerprint}
        (revision / "receipt.json").write_bytes(encoded(receipt))
        # Recheck after backup and before any write. Interrupted updates retain
        # their receipt and original files for operator recovery; never hide it.
        if inventory(revision / "before") != before:
            raise ValueError("Backup integrity failed before publication")
        if inventory(root) != before or inventory(source) != proposed:
            raise ValueError("Source or destination changed during preparation")
        for relative in changes:
            destination = root / relative
            current = digest(destination.read_bytes()) if destination.exists() else None
            if current != before.get(relative):
                raise ValueError("Concurrent content change; preserved backup requires operator recovery")
            data = (source / relative).read_bytes()
            if digest(data) != proposed[relative]:
                raise ValueError("Source changed during publication")
            parent = destination.parent
            while parent != root:
                parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if os.geteuid() == 0:
                    os.chown(parent, owner.st_uid, owner.st_gid)
                parent = parent.parent
            mode = destination.stat().st_mode & 0o777 if destination.exists() else 0o400
            atomic(destination, data, mode, owner.st_uid, owner.st_gid)
        if inventory(root) != expected_after:
            raise ValueError("Publication readback failed; preserve revision for operator recovery")
        (revision / "verified.json").write_bytes(encoded({"verified": True, "plan": fingerprint}))
        print(json.dumps({**plan, "revision": name, "verified": True}))


if __name__ == "__main__":
    main()
