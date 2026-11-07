#!/usr/bin/env python3
"""Hold an exclusive OS lock throughout the exact release subprocess."""
import errno
import fcntl
import os
import signal
import stat
import subprocess
import sys


def main():
    if len(sys.argv) < 4:
        return 64
    descriptor = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
                or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077):
            return 77
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno in (errno.EACCES, errno.EAGAIN):
                return 75
            raise
        child = subprocess.Popen(sys.argv[2:])

        def forward(number, _frame):
            if child.poll() is None:
                child.send_signal(number)

        signal.signal(signal.SIGTERM, forward)
        signal.signal(signal.SIGINT, forward)
        result = child.wait()
        return result if result >= 0 else 128 - result
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    sys.exit(main())
