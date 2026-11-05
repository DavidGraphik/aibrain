"""Use the official HTTPS Ubuntu archive for Playwright CI dependencies.

GitHub runner images can retain legacy .list sources alongside deb822 .sources
and mirror+file lists. Changing just ubuntu.sources leaves Azure downloads.
No packages, signing keys, suites or third-party repositories are changed.
"""
import re
import sys
from pathlib import Path


def configure(root: Path):
    sources = [root / "sources.list"]
    sources.extend(sorted(root.glob("*mirrors*.txt")))
    for suffix in ("*.list", "*.sources"):
        sources.extend(sorted((root / "sources.list.d").glob(suffix)))
    changed = 0
    for source in sources:
        if not source.exists():
            continue
        if source.is_symlink() or not source.is_file():
            raise RuntimeError("APT source must be a regular file")
        before = source.read_text()
        after = re.sub(r"https?://(?:azure\.)?archive\.ubuntu\.com/ubuntu(?=/|\s|$)",
                       "https://archive.ubuntu.com/ubuntu", before)
        after = re.sub(r"http://security\.ubuntu\.com/ubuntu(?=/|\s|$)",
                       "https://security.ubuntu.com/ubuntu", after)
        if before != after:
            source.write_text(after)
            changed += 1
        if "azure.archive.ubuntu.com" in after:
            raise RuntimeError("Azure Ubuntu mirror remains configured")
    print(f"Configured HTTPS Ubuntu mirrors in {changed} APT sources")


if __name__ == "__main__":
    configure(Path(sys.argv[1]) if len(sys.argv) == 2 else Path("/etc/apt"))
