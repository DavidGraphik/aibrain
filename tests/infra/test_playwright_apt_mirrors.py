import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[2] / "scripts/configure-playwright-apt-mirrors.py"
spec = importlib.util.spec_from_file_location("apt_mirrors", MODULE)
mirrors = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mirrors)


class AptMirrorTests(unittest.TestCase):
    def test_rewrites_both_formats_without_changing_signing_or_other_repositories(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lists = root / "sources.list.d"
            lists.mkdir()
            legacy = root / "sources.list"
            legacy.write_text("deb http://azure.archive.ubuntu.com/ubuntu noble main\n")
            modern = lists / "ubuntu.sources"
            modern.write_text("Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble-updates\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n")
            security = lists / "security.list"
            security.write_text("deb http://security.ubuntu.com/ubuntu noble-security main\n")
            other = lists / "vendor.list"
            original = "deb [signed-by=/vendor.gpg] https://packages.microsoft.com/repos/edge stable main\n"
            other.write_text(original)
            mirror_list = root / "apt-mirrors.txt"
            mirror_list.write_text("http://azure.archive.ubuntu.com/ubuntu/\nhttp://archive.ubuntu.com/ubuntu/\n")
            indirect = lists / "mirror.sources"
            indirect.write_text("URIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble\n")
            mirrors.configure(root)
            self.assertIn("https://archive.ubuntu.com/ubuntu noble main", legacy.read_text())
            self.assertIn("URIs: https://archive.ubuntu.com/ubuntu/", modern.read_text())
            self.assertIn("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg", modern.read_text())
            self.assertIn("https://security.ubuntu.com/ubuntu", security.read_text())
            self.assertEqual(other.read_text(), original)
            self.assertEqual(mirror_list.read_text(), "https://archive.ubuntu.com/ubuntu/\nhttps://archive.ubuntu.com/ubuntu/\n")
            self.assertIn("mirror+file:/etc/apt/apt-mirrors.txt", indirect.read_text())
            first = [p.read_text() for p in [legacy, modern, security, other]]
            mirrors.configure(root)
            self.assertEqual(first, [p.read_text() for p in [legacy, modern, security, other]])


if __name__ == "__main__":
    unittest.main()
