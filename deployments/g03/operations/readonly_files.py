"""Read-only source adapter. No network, credentials, mount, copy, or source writes.

Use only an operator-reviewed read-only mount. Allowed folder names come from
the server-side principal, never an employee's request. UTF-8 text only in this
candidate; binary formats return explicit unsupported status.
"""
import hashlib
import os
from pathlib import Path
import stat
import datetime as dt


class SourceDenied(ValueError):
    pass


class ReadOnlyFiles:
    def __init__(self, root, tenant, folders, source_mode="synthetic-fixture"):
        candidate = Path(root)
        if tenant != "g03-rehearsal": raise SourceDenied("TENANT_DENIED")
        if not candidate.is_absolute() or candidate.is_symlink() or not candidate.is_dir(): raise SourceDenied("SOURCE_ROOT_UNSAFE")
        self.root = candidate.resolve()
        if self.root == Path(self.root.anchor) or self.root == Path.home(): raise SourceDenied("SOURCE_ROOT_TOO_BROAD")
        if source_mode not in {"synthetic-fixture", "reviewed-readonly-mount"}: raise SourceDenied("SOURCE_MODE_INVALID")
        if source_mode == "reviewed-readonly-mount" and not (os.statvfs(self.root).f_flag & os.ST_RDONLY): raise SourceDenied("READONLY_MOUNT_REQUIRED")
        self.tenant, self.folders, self.mode = tenant, frozenset(folders), source_mode
        if not self.folders or any(not isinstance(f, str) or "/" in f or "\\" in f or f in {"", ".", ".."} for f in self.folders): raise SourceDenied("FOLDER_SCOPE_INVALID")

    def _parts(self, relative):
        if not isinstance(relative, str) or not relative or "\\" in relative or "\x00" in relative: raise SourceDenied("PATH_DENIED")
        path = Path(relative)
        if path.is_absolute() or ".." in path.parts or path.parts[0] not in self.folders: raise SourceDenied("PATH_DENIED")
        return path.parts

    def read(self, relative, max_bytes=100_000):
        parts = self._parts(relative)
        if Path(relative).suffix.lower() not in {".txt", ".md", ".csv", ".json"}: raise SourceDenied("FORMAT_UNSUPPORTED")
        if not isinstance(max_bytes, int) or not 0 < max_bytes <= 100_000: raise SourceDenied("SIZE_LIMIT_INVALID")
        # Walk open directory descriptors, no symlink follow, including final file.
        # POSIX only: Windows access occurs through a reviewed Linux read-only mount.
        root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        fds = [root_fd]
        try:
            parent = root_fd
            for part in parts[:-1]:
                parent = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                fds.append(parent)
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            fds.append(fd)
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > max_bytes or before.st_nlink > 1: raise SourceDenied("FILE_UNSAFE_OR_TOO_LARGE")
            data = os.read(fd, max_bytes + 1)
            after = os.fstat(fd)
            if len(data) > max_bytes or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns): raise SourceDenied("SOURCE_CHANGED_RETRY")
            content = data.decode("utf-8")
            return {"tenant": self.tenant, "path": relative, "source": self.mode, "content": content, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "writeEnabled": False}
        except (OSError, UnicodeError) as error:
            raise SourceDenied("SOURCE_READ_REJECTED") from error
        finally:
            for fd in reversed(fds): os.close(fd)

    def list(self, folder, limit=100):
        if folder not in self.folders or not isinstance(limit, int) or not 0 < limit <= 100: raise SourceDenied("SCOPE_DENIED")
        rows = []
        root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        folder_fd = None
        truncated = False
        try:
            folder_fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            with os.scandir(folder_fd) as entries:
                for index, entry in enumerate(entries):
                    if index >= 1000 or len(rows) >= limit:
                        truncated = True; break
                    metadata = os.stat(entry.name, dir_fd=folder_fd, follow_symlinks=False)
                    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink > 1: continue
                    rows.append({"path": folder + "/" + entry.name, "bytes": metadata.st_size, "supported": Path(entry.name).suffix.lower() in {".txt", ".md", ".csv", ".json"}, "source": self.mode})
        except OSError as error: raise SourceDenied("SOURCE_READ_REJECTED") from error
        finally:
            if folder_fd is not None: os.close(folder_fd)
            os.close(root_fd)
        return {"tenant": self.tenant, "rows": sorted(rows, key=lambda r: r["path"]), "limit": limit, "truncated": truncated, "recursive": False, "coverage": "ONE_AUTHORIZED_FOLDER", "writeEnabled": False}
