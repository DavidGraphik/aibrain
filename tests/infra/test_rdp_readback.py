import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

INFRA = Path(__file__).resolve().parents[2] / 'infra/hetzner'
spec = importlib.util.spec_from_file_location('readback_rdp', INFRA / 'rdp-access.py')
rdp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rdp)


class ReadbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.nonce = 'a' * 32

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, value):
        p = self.root / ('readback-' + self.nonce + '.json')
        p.write_text(json.dumps(value))
        p.chmod(0o600)
        return p

    def test_atomic_frame_matches_only_current_nonce(self):
        self.assertIsNone(rdp.file_readback(self.root, self.nonce))
        self.write({'ok': True, 'nonce': 'b' * 32})
        self.assertIsNone(rdp.file_readback(self.root, self.nonce))
        self.write({'ok': True, 'nonce': self.nonce})
        self.assertTrue(rdp.file_readback(self.root, self.nonce)['ok'])

    def test_unsafe_path_symlink_and_oversize_are_rejected(self):
        with self.assertRaises(ValueError):
            rdp.file_readback(self.root, '../outside')
        p = self.write({'ok': True, 'nonce': self.nonce})
        p.chmod(0o644)
        with self.assertRaises(ValueError):
            rdp.file_readback(self.root, self.nonce)
        p.chmod(0o600)
        p.write_bytes(b'x' * (256 * 1024 + 1))
        with self.assertRaises(ValueError):
            rdp.file_readback(self.root, self.nonce)
        p.unlink()
        target = self.root / 'our-synthetic-target'
        target.write_text('unchanged')
        p.symlink_to(target)
        with self.assertRaises(ValueError):
            rdp.file_readback(self.root, self.nonce)
        self.assertEqual(target.read_text(), 'unchanged')

    def session(self):
        s = rdp.RdpSession({}, {}, 'ts', self.root)
        s.env = {}
        s.key = Mock()
        s.rdp = SimpleNamespace(poll=lambda: None)
        s.run = Mock(side_effect=AssertionError('Clipboard should not be needed'))
        return s

    def test_redirected_result_works_without_clipboard_and_executes_once(self):
        self.write({'ok': True, 'nonce': self.nonce, 'entries': []})
        s = self.session()
        process = SimpleNamespace(stdin=io.BytesIO())
        with patch.object(rdp.subprocess, 'Popen', return_value=process) as publish, patch.object(rdp.time, 'sleep'):
            result = s.execute('fixed command', self.nonce)
        self.assertEqual(result['readbackTransport'], 'redirected-file')
        self.assertEqual([x.args[0] for x in s.key.call_args_list], ['ctrl+v', 'Return'])
        publish.assert_called_once()
        s.run.assert_not_called()

    def test_clipboard_compatibility_when_redirection_is_unavailable(self):
        s = self.session()
        s.run = Mock(return_value=SimpleNamespace(stdout=json.dumps({'ok': True, 'nonce': self.nonce}).encode()))
        with patch.object(rdp.subprocess, 'Popen', return_value=SimpleNamespace(stdin=io.BytesIO())), patch.object(rdp.time, 'sleep'):
            result = s.execute('fixed command', self.nonce)
        self.assertEqual(result['readbackTransport'], 'clipboard')

    def test_clipboard_timeout_does_not_discard_later_file_result(self):
        s = self.session()
        s.run = Mock(side_effect=subprocess.TimeoutExpired('xclip', 5))
        with patch.object(rdp.subprocess, 'Popen', return_value=SimpleNamespace(stdin=io.BytesIO())), patch.object(rdp.time, 'sleep'), patch.object(rdp, 'file_readback', side_effect=[None, {'ok': True, 'nonce': self.nonce}]):
            result = s.execute('fixed command', self.nonce)
        self.assertEqual(result['readbackTransport'], 'redirected-file')
        s.run.assert_called_once()

    def test_generated_program_only_creates_own_nonce_file(self):
        command = rdp.build_command('list', 'C:\\Work', 'C:\\Work', self.nonce, {'maxEntries': 50, 'maxFileBytes': 100})
        program = base64.b64decode(command.split()[-1]).decode('utf-16le')
        self.assertIn('CreateNew', program)
        self.assertIn('readback-' + self.nonce, program)
        self.assertNotIn('Copy-Item', program)
        self.assertLessEqual(len(command), 7800)


if __name__ == '__main__':
    unittest.main()
