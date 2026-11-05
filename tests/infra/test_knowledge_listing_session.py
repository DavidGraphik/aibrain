import copy
import fcntl
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

INFRA = Path(__file__).resolve().parents[2] / 'infra/hetzner'
spec = importlib.util.spec_from_file_location('listing', INFRA / 'knowledge-listing-session.py')
listing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(listing)


class ListingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = {'sourceRoots': ['Y:\\Allowed'], 'connectionConfig': 'fixture', 'accessManifest': 'fixture'}
        self.binding = ({'host': 'fictional'}, {'credential': 'fictional'}, {'readRoots': ['Y:\\Allowed'], 'target': 'ts'}, self.root)
        self.sessions, self.closed, self.sent = [], [], []
        self.now, self.after_execute, self.failure = 0, None, None
        owner = self
        class FakeSession:
            def __init__(self, *args):
                owner.sessions.append(self)
            def __enter__(self):
                return self
            def __exit__(self, *error):
                owner.closed.append(error[0])
            def execute(self, program, nonce, timeout):
                owner.sent.append((program, timeout))
                if owner.failure:
                    raise owner.failure
                if owner.after_execute:
                    owner.after_execute()
                return {'ok': True, 'entries': [], 'truncated': False, 'nextOffset': None, 'nonce': nonce}
        for target, value in [('load_config', lambda *_: copy.deepcopy(self.binding)), ('RdpSession', FakeSession)]:
            p = patch.object(listing.files.rdp, target, value); p.start(); self.addCleanup(p.stop)
        p = patch.object(listing.files, 'command', lambda request, access, nonce: nonce)
        p.start(); self.addCleanup(p.stop)
        self.transport = listing.ListingSession(self.manifest, clock=lambda: self.now)
        self.addCleanup(self.transport.close)
        self.request = {'mode': 'list', 'source': 'Y:\\Allowed', 'offset': 0, 'limit': 50}

    def ask(self):
        return self.transport(self.manifest, self.request)

    def assert_unlocked(self):
        with (self.root / '.operator.lock').open('a') as f:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_three_requests_share_one_session_and_fourth_rotates(self):
        for _ in range(3): self.ask()
        self.assertEqual(len(self.sessions), 1)
        self.assertEqual(len(list(self.root.glob('*/receipt-*.json'))), 3)
        self.ask()
        self.assertEqual(len(self.sessions), 2)
        self.assertEqual(len(self.closed), 1)
        self.assertEqual(len(set(x[0] for x in self.sent)), 4)
        self.assertTrue(all(x[1] == 45 for x in self.sent))
        self.transport.close(); self.assert_unlocked()

    def test_elapsed_admission_rotates_session(self):
        self.ask(); self.now = 20; self.ask()
        self.assertEqual(len(self.sessions), 2)

    def test_source_lock_contention_opens_no_session(self):
        with (self.root / '.operator.lock').open('a') as f:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): self.ask()
            self.assertFalse(self.sessions)
        self.assert_unlocked()

    def test_revoked_source_closes_existing_session_before_dispatch(self):
        self.ask()
        self.binding[2]['readRoots'] = ['Y:\\Different']
        with self.assertRaises(ValueError): self.ask()
        self.assertEqual(len(self.sent), 1)
        self.assert_unlocked()

    def test_changed_endpoint_reconnects_instead_of_reusing_old_session(self):
        self.ask(); self.binding[0]['host'] = 'new-fictional'; self.ask()
        self.assertEqual(len(self.sessions), 2)

    def test_policy_changed_during_result_discards_page_and_releases_lock(self):
        self.after_execute = lambda: self.binding[2].update(readRoots=['Y:\\Different'])
        with self.assertRaisesRegex(ValueError, 'LISTING_POLICY_CHANGED'): self.ask()
        self.assertFalse(list(self.root.glob('*/receipt-*.json')))
        self.assert_unlocked()

    def test_policy_changed_during_startup_prevents_dispatch(self):
        original = listing.files.rdp.load_config
        count = 0
        def load(*args):
            nonlocal count
            count += 1
            if count == 2: self.binding[2]['readRoots'] = ['Y:\\Different']
            return original(*args)
        with patch.object(listing.files.rdp, 'load_config', load):
            with self.assertRaisesRegex(ValueError, 'LISTING_POLICY_CHANGED'): self.ask()
        self.assertFalse(self.sent); self.assert_unlocked()

    def test_timeout_discards_session_no_automatic_retry(self):
        self.ask(); self.failure = TimeoutError('fictional')
        with self.assertRaises(TimeoutError): self.ask()
        self.assertEqual(len(self.sent), 2); self.assertEqual(self.closed[-1], TimeoutError)
        self.assert_unlocked()
        self.failure = None; self.ask(); self.assertEqual(len(self.sessions), 2)

    def test_wrong_nonce_cannot_be_persisted_or_reused(self):
        self.ask()
        with patch.object(self.sessions[0], 'execute', return_value={'ok': True, 'nonce': 'wrong'}):
            with self.assertRaisesRegex(ValueError, 'INVALID_LISTING_NONCE'): self.ask()
        self.assertEqual(len(list(self.root.glob('*/receipt-*.json'))), 1)
        self.assert_unlocked()

    def test_confirmed_path_failure_can_reuse_session(self):
        self.ask()
        def unavailable(program, nonce, timeout):
            return {'ok': False, 'error': 'WINDOWS_PATH_UNAVAILABLE', 'nonce': nonce}
        with patch.object(self.sessions[0], 'execute', unavailable):
            with self.assertRaisesRegex(ValueError, 'WINDOWS_PATH_UNAVAILABLE'): self.ask()
        self.ask(); self.assertEqual(len(self.sessions), 1)

    def test_copy_search_extra_fields_and_foreign_roots_never_dispatch(self):
        for changes in [{'mode': 'copy'}, {'mode': 'search'}, {'command': 'bad'}, {'source': 'Y:\\Private'}, {'offset': -1}, {'limit': True}]:
            with self.assertRaises(ValueError): self.transport(self.manifest, {**self.request, **changes})
        self.assertFalse(self.sessions)

    def test_startup_failure_releases_lock(self):
        with patch.object(listing.files.rdp.RdpSession, '__enter__', side_effect=RuntimeError('fictional')):
            with self.assertRaises(RuntimeError): self.ask()
        self.assert_unlocked()


if __name__ == '__main__':
    unittest.main()
