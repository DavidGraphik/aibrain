import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

INFRA = Path(__file__).resolve().parents[2] / 'infra/hetzner'
spec = importlib.util.spec_from_file_location('layout', INFRA / 'knowledge-memory-layout.py')
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)


class MemoryLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.user = self.root / '00000000-0000-4000-8000-000000000001'
        self.user.mkdir(mode=0o700)
        (self.user / 'memory').mkdir(mode=0o700)
        for name, value in [('user.json', json.dumps({'userId': self.user.name, 'enabled': True})), ('PROFILE.md', 'Private profile'), ('PREFERENCES.md', 'Private preferences')]:
            p = self.user / name; p.write_text(value); p.chmod(0o600)

    def seed(self):
        return layout.seed(self.root, os.getuid(), os.getgid(), 'Fixed organization guide\n')

    def test_guide_is_idempotent_and_preserves_notes(self):
        self.assertEqual(self.seed()['created'], 1)
        self.assertEqual(self.seed()['existing'], 1)
        self.assertEqual((self.user / 'PROFILE.md').read_text(), 'Private profile')
        self.assertEqual((self.user / 'memory/README.md').stat().st_mode & 0o777, 0o600)

    def test_existing_custom_guide_is_not_overwritten(self):
        p = self.user / 'memory/README.md'; p.write_text('My notes'); p.chmod(0o600)
        self.assertEqual(self.seed()['existing'], 1)
        self.assertEqual(p.read_text(), 'My notes')

    def test_symlink_and_foreign_identity_are_rejected(self):
        target = self.root / 'outside'; target.write_text('keep'); target.chmod(0o600)
        (self.user / 'memory/README.md').symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_MEMORY_LAYOUT'):
            self.seed()
        self.assertEqual(target.read_text(), 'keep')
        (self.user / 'memory/README.md').unlink()
        (self.user / 'user.json').write_text(json.dumps({'userId': 'foreign', 'enabled': True}))
        with self.assertRaisesRegex(ValueError, 'USER_IDENTITY_MISMATCH'):
            self.seed()


if __name__ == '__main__':
    unittest.main()
