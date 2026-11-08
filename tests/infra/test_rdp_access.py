"""Security boundaries for the host-only Windows read/export tool."""
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock

SCRIPT = Path(__file__).resolve().parents[2] / "infra/hetzner/rdp-access.py"
spec = importlib.util.spec_from_file_location("rdp_access", SCRIPT)
rdp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rdp)


class RdpAccessTests(unittest.TestCase):
    def test_desktop_gate_requires_three_consecutive_nonblank_frames(self):
        session = rdp.RdpSession({}, {}, 'ts', Path('/unused'))
        session.rdp = MagicMock(); session.rdp.poll.return_value = None
        clock = [0]
        frames = [False, True, False, True, True, True]
        def sample(*args, **kwargs):
            return MagicMock(returncode=0, stdout=json.dumps({'visible': frames.pop(0)}).encode())
        with patch.object(session, 'run', side_effect=sample) as run, \
             patch.object(session, 'key') as key, \
             patch.object(rdp.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(rdp.time, 'sleep', side_effect=lambda n: clock.__setitem__(0, clock[0]+n)):
            session.wait_for_desktop()
            self.assertEqual(run.call_count, 6)
            key.assert_not_called()

    def test_desktop_gate_times_out_without_sending_keys(self):
        session = rdp.RdpSession({}, {}, 'ts', Path('/unused'))
        session.rdp = MagicMock(); session.rdp.poll.return_value = None
        clock = [0]
        with patch.object(session, 'run', return_value=MagicMock(returncode=1, stdout=b'')), \
             patch.object(session, 'key') as key, \
             patch.object(rdp.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(rdp.time, 'sleep', side_effect=lambda n: clock.__setitem__(0, clock[0]+n)):
            with self.assertRaisesRegex(ValueError, 'RDP_DESKTOP_NOT_READY'):
                session.wait_for_desktop(timeout=2)
            key.assert_not_called()

    def test_native_client_home_is_private_ephemeral_and_parent_env_is_unchanged(self):
        parent = dict(rdp.os.environ)
        homes = []
        for _ in range(2):
            session = rdp.RdpSession({}, {}, 'ts', Path('/unused'))
            def stop_before_native_execution(*args, **kwargs):
                home = Path(session.env['HOME'])
                homes.append(home)
                self.assertEqual(home, session.work)
                self.assertEqual(home.stat().st_mode & 0o777, 0o700)
                for key, name in [('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
                    self.assertEqual(Path(session.env[key]), home / name)
                    self.assertEqual((home / name).stat().st_mode & 0o777, 0o700)
                raise RuntimeError('FICTIONAL_NATIVE_BOUNDARY')
            with patch.object(session, 'run', side_effect=stop_before_native_execution):
                with self.assertRaisesRegex(RuntimeError, 'FICTIONAL_NATIVE_BOUNDARY'):
                    session.__enter__()
            self.assertFalse(homes[-1].exists())
            self.assertEqual(dict(rdp.os.environ), parent)
        self.assertNotEqual(homes[0], homes[1])

    def test_xls_export_uses_same_root_guard_and_other_formats_stay_denied(self):
        access={'inventoryRoots':[r'Y:\Approved'],'readRoots':[r'Y:\Approved'],
            'target':'ts','maxEntries':20,'maxFileBytes':1024}
        cases=[(r'Y:\Approved\Example.XLS',True),(r'Y:\Other\Example.xls',False),
            (r'Y:\Approved\Example.exe',False),(r'Y:\Approved\Example.doc',True),
            (r'Y:\Approved\Example.rtf',True),(r'Y:\Approved\Example.xlsm',True),
            (r'Y:\Other\Example.xlsm',False),
            (r'Y:\Approved\Example.BMP',True),(r'Y:\Other\Example.bmp',False),
            (r'Y:\Approved\Example.png',True),(r'Y:\Approved\Example.jpeg',True),
            (r'Y:\Approved\Example.tiff',False)]
        for source,allowed in cases:
            with self.subTest(source=source),tempfile.TemporaryDirectory() as folder:
                session=MagicMock()
                session.__enter__.side_effect=RuntimeError('FICTIONAL_CONNECTION_BOUNDARY')
                with patch.object(rdp.os,'geteuid',return_value=0),patch.object(rdp.os,'umask'),\
                     patch.object(rdp,'load_config',return_value=({}, {},access,Path(folder))),\
                     patch.object(rdp,'RdpSession',return_value=session) as connection,\
                     patch.object(rdp.signal,'signal'),patch.object(rdp.signal,'alarm'),\
                     patch.object(rdp.sys,'argv',['rdp-access','copy','--path',source,'--config','fake','--access','fake']):
                    with self.assertRaises(RuntimeError if allowed else ValueError):rdp.main()
                    self.assertEqual(connection.call_count,1 if allowed else 0)

    def test_traversal_streams_unc_and_sensitive_paths_are_rejected(self):
        for value in [
            r"Y:\Approved\..\Other\x.txt", r"Y:\Approved\x.txt:stream",
            r"\\server\share\x.txt", r"Y:\Approved\secrets.json",
            r"Y:\Approved\.env", r"Y:\Approved\trailing. ",
            "Y:\\Approved\\x\n.txt", r"Y:\Approved\*.xlsx",
            r"Y:\Approved\\nested\x.txt", r"Y:\Approved\.\x.txt",
            r"Y:\Approved\NUL.txt", r"Y:\Approved\COM1",
        ]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                rdp.windows_path(value)

    def test_root_comparison_is_case_insensitive_and_respects_boundaries(self):
        self.assertEqual(
            rdp.select_root(r"y:\approved\x.txt", [r"Y:\Approved"])[1],
            r"Y:\Approved",
        )
        with self.assertRaises(ValueError):
            rdp.select_root(r"Y:\Approved-secret\x.txt", [r"Y:\Approved"])

    def test_path_is_encoded_data_not_executable_powershell(self):
        source = r"Y:\Approved\quote'; unexpected-command; '.xlsx"
        command = rdp.build_command("copy", source, r"Y:\Approved", "a" * 32,
                                    {"maxEntries": 20, "maxFileBytes": 1024})
        script = base64.b64decode(command.split()[-1]).decode("utf-16le")
        self.assertNotIn("unexpected-command", script)
        self.assertIn(r"'\\tsclient\AiBrain\payload'", script)
        self.assertIn("[IO.FileMode]::CreateNew", script)
        self.assertIn("[IO.FileAccess]::Read,[IO.FileShare]::Read", script)
        self.assertLess(script.index("RDP_DRIVE_REDIRECTION_DISABLED"), script.index("$s=[IO.File]::Open"))
        self.assertLessEqual(len(command), 7800)

    def test_no_arbitrary_operation(self):
        with self.assertRaises(ValueError):
            rdp.build_command("execute", r"Y:\Approved", r"Y:\Approved", "a" * 32,
                              {"maxEntries": 20, "maxFileBytes": 1024})

    def test_copy_requires_matching_source_size_and_hash(self):
        for change in [{"source": r"Y:\Other\x.txt"}, {"bytes": 9}, {"sha256": "0" * 64}]:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                job = Path(directory)
                (job / "payload").write_bytes(b"test")
                result = {"ok": True, "source": r"Y:\Approved\x.txt", "bytes": 4,
                          "sha256": hashlib.sha256(b"test").hexdigest(), **change}
                with self.assertRaises(ValueError):
                    rdp.validate_copy(job, result, r"Y:\Approved\x.txt", 1024)
                self.assertFalse((job / "files").exists())

    def test_copy_keeps_original_filename_without_receipt_collision(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            (job / "payload").write_bytes(b"test")
            result = {"ok": True, "source": r"Y:\Approved\receipt.json", "bytes": 4,
                      "sha256": hashlib.sha256(b"test").hexdigest()}
            receipt = rdp.validate_copy(job, result, result["source"], 1024)
            self.assertEqual(Path(receipt["destination"]).read_bytes(), b"test")
            self.assertEqual(Path(receipt["destination"]).parent, job / "files")
            self.assertFalse((job / "receipt.json").exists())

    def test_copy_rejects_symlink_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            (job / "original").write_bytes(b"test")
            (job / "payload").symlink_to(job / "original")
            with self.assertRaises(ValueError):
                rdp.validate_copy(job, {"ok": True, "source": r"Y:\Approved\x.txt",
                                       "bytes": 4, "sha256": hashlib.sha256(b"test").hexdigest()},
                                  r"Y:\Approved\x.txt", 1024)

    def test_windows_denial_keeps_failure_receipt_and_no_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            access = {"inventoryRoots": [r"Y:\Approved"], "readRoots": [r"Y:\Approved"],
                      "target": "ts", "maxEntries": 20, "maxFileBytes": 1024}
            session = MagicMock()
            session.__enter__.return_value.execute.return_value = {
                "ok": False, "error": "RDP_DRIVE_REDIRECTION_DISABLED"}
            with patch.object(rdp.os, "geteuid", return_value=0), \
                 patch.object(rdp, "load_config", return_value=({}, {}, access, destination)), \
                 patch.object(rdp, "RdpSession", return_value=session), \
                 patch.object(rdp.signal, "signal"), patch.object(rdp.signal, "alarm"), \
                 patch.object(rdp.sys, "stderr", io.StringIO()), \
                 patch.object(rdp.sys, "argv", ["rdp-access", "copy", "--path", r"Y:\Approved\x.txt",
                                               "--config", "/config", "--access", "/access"]), \
                 self.assertRaisesRegex(ValueError, "RDP_DRIVE_REDIRECTION_DISABLED"):
                rdp.main()
            failures = list(destination.glob("*/failure.json"))
            self.assertEqual(len(failures), 1)
            self.assertFalse(json.loads(failures[0].read_text())["ok"])
            self.assertEqual(list(destination.glob("*/payload")), [])


if __name__ == "__main__":
    unittest.main()
