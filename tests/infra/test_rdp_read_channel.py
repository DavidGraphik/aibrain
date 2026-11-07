import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('channel', ROOT / 'infra/hetzner/rdp-read-channel.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class FakeSession:
    instances = []
    error = None
    barrier = None

    def __init__(self, manifest, config):
        self.started = time.monotonic()
        self.failed = False
        self.calls = []
        self.closed = False
        self.instances.append(self)

    def start(self):
        return self

    def request(self, request):
        self.calls.append(request)
        if self.barrier:
            self.barrier.wait(timeout=3)
        if self.error:
            raise ValueError(self.error)
        return {'ok': True, 'entries': [], 'recordedAt': 'now'}

    def close(self):
        self.closed = True


class ProtocolTests(unittest.TestCase):
    def test_authenticated_unicode_round_trip_and_wrong_key(self):
        value = {'source': 'Y:\\Compres\\Oferta À.pdf', 'id': 'a'}
        frame = c.pack(value, b'a' * 32)
        self.assertEqual(c.unpack(frame, b'a' * 32), value)
        with self.assertRaises(ValueError):
            c.unpack(frame, b'b' * 32)

    def test_payload_tampering_oversize_and_invalid_envelope_are_rejected(self):
        raw = json.loads(c.pack({'ok': True}, b'a' * 32))
        raw['payload'] = base64.b64encode(b'{"ok":false}').decode()
        for value in [json.dumps(raw).encode(), b'x' * (256 * 1024 + 1), b'[]', b'{"payload":"?","mac":1}', b'null']:
            with self.subTest(frame=value[:40]), self.assertRaises(ValueError):
                c.unpack(value, b'a' * 32)

    def test_replayed_request_response_id_is_rejected(self):
        session = c.Session({}, ({}, {}, {'maxFileBytes': 10}, Path('/tmp'), 'S-1-5-21-1'))
        with patch.object(session, 'send', return_value='new'), patch.object(session, 'wait', return_value={'id': 'old', 'ok': True}):
            with self.assertRaises(ValueError):
                session.request({'mode': 'drives'})

    def test_bad_copy_hash_never_returns_destination(self):
        with tempfile.TemporaryDirectory() as root:
            session = c.Session({}, ({}, {}, {'maxFileBytes': 10}, Path(root), 'S-1-5-21-1'))
            session.job.mkdir()
            (session.job / 'copy-id').write_bytes(b'fresh')
            response = {'ok': True, 'id': 'id', 'bytes': 5, 'source': 'C:\\Work\\a.txt', 'sha256': '0' * 64}
            with patch.object(session, 'send', return_value='id'), patch.object(session, 'wait', return_value=response):
                with self.assertRaises(ValueError):
                    session.request({'mode': 'copy', 'source': response['source']})

    def test_valid_copy_receipt_is_hash_verified_without_changing_original(self):
        import hashlib
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            original = root / 'original.txt'
            original.write_bytes(b'fresh')
            session = c.Session({}, ({}, {}, {'maxFileBytes': 10}, root, 'S-1-5-21-1'))
            session.job.mkdir()
            (session.job / 'copy-id').write_bytes(original.read_bytes())
            response = {'ok': True, 'id': 'id', 'bytes': 5, 'source': 'C:\\Work\\a.txt', 'sha256': hashlib.sha256(b'fresh').hexdigest()}
            with patch.object(session, 'send', return_value='id'), patch.object(session, 'wait', return_value=response):
                receipt = session.request({'mode': 'copy', 'source': response['source']})
            self.assertEqual(receipt['verifiedSha256'], response['sha256'])
            self.assertEqual(Path(receipt['destination']).read_bytes(), b'fresh')
            self.assertEqual(original.read_bytes(), b'fresh')

    def test_lost_stop_preserves_quarantine_and_closes_local_lock(self):
        session = c.Session({}, ({}, {}, {}, Path('/tmp'), 'S-1-5-21-1'))
        closed = []
        session.lock = SimpleNamespace(close=lambda: closed.append(True))
        session.connection = SimpleNamespace(rdp=SimpleNamespace(poll=lambda: None), temp=True, __exit__=lambda *a: None)
        with patch.object(session, 'send'), patch.object(session, 'wait', side_effect=ValueError('SERVER_FILES_TIMEOUT')), patch.object(c.lease, 'release') as release:
            session.close()
            release.assert_not_called()
            self.assertEqual(closed, [True])

    def test_confirmed_stop_removes_only_own_marker(self):
        session = c.Session({}, ({}, {}, {}, Path('/tmp'), 'S-1-5-21-1'))
        session.connection = SimpleNamespace(rdp=SimpleNamespace(poll=lambda: None), temp=True, __exit__=lambda *a: None)
        with patch.object(session, 'send'), patch.object(session, 'wait', return_value={'state': 'stopped', 'nonce': session.nonce}), patch.object(c.lease, 'release') as release:
            session.close()
            release.assert_called_once_with(session.root, session.job.name, session.nonce)


class ChannelTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {'installationId': 'tenant-one', 'connectionId': 'windows', 'sourceRoots': ['C:\\Work'], 'publications': [{'scope': 'company', 'scopeId': None}]}
        self.validated = ({'host': 'one'}, {'secret': 'not-real'}, {'readRoots': ['C:\\Work']}, Path('/tmp'), 'S-1-5-21-1')
        self.settings = patch.object(c, 'settings', return_value=self.validated).start()
        self.scope = patch.object(c.sync, 'scope_directory').start()
        FakeSession.instances, FakeSession.error, FakeSession.barrier = [], None, None
        self.channel = c.Channel('/not-used', self.manifest, factory=FakeSession)

    def tearDown(self):
        self.channel.close()
        patch.stopall()

    def test_default_connection_is_lazy(self):
        self.assertEqual(FakeSession.instances, [])

    def test_repeated_browse_reads_fresh_and_reuses_only_connection(self):
        request = {'mode': 'list', 'source': 'C:\\Work', 'limit': 50, 'offset': 0}
        self.channel.call(request)
        self.channel.call(request)
        self.assertEqual(len(FakeSession.instances), 1)
        self.assertEqual(len(FakeSession.instances[0].calls), 2)
        self.assertEqual(self.scope.call_count, 2)

    def test_foreign_tenant_foreign_root_and_binary_never_dispatch(self):
        for manifest in [{**self.manifest, 'installationId': 'tenant-two'}, {**self.manifest, 'connectionId': 'other'}]:
            with self.assertRaises(ValueError):
                self.channel.browse(manifest, {'mode': 'drives'})
        for request in [{'mode': 'copy', 'source': 'Y:\\Foreign\\invoice.txt'}, {'mode': 'copy', 'source': 'C:\\Work\\price.exe'}, {'mode': 'execute', 'source': 'C:\\Work\\price.exe'}]:
            with self.assertRaises(ValueError):
                self.channel.call(request)
        self.assertEqual(FakeSession.instances, [])

    def test_policy_change_rejects_before_next_source_read(self):
        self.channel.call({'mode': 'drives'})
        self.settings.return_value = ({'host': 'two'}, *self.validated[1:])
        with self.assertRaisesRegex(ValueError, 'POLICY_CHANGED'):
            self.channel.call({'mode': 'drives'})
        self.assertEqual(len(FakeSession.instances[0].calls), 1)

    def test_four_parallel_requests_use_one_session_fifth_returns_busy(self):
        FakeSession.barrier = threading.Barrier(5)
        errors = []
        def run():
            try:
                self.channel.call({'mode': 'drives'})
            except Exception as error:
                errors.append(str(error))
        threads = [threading.Thread(target=run) for _ in range(4)]
        for thread in threads:
            thread.start()
        until = time.monotonic() + 2
        while self.channel.active != 4 and time.monotonic() < until:
            time.sleep(.01)
        with self.assertRaisesRegex(ValueError, 'BUSY'):
            self.channel.call({'mode': 'drives'})
        FakeSession.barrier.wait(timeout=3)
        for thread in threads:
            thread.join(timeout=3)
        self.assertFalse(errors)
        self.assertEqual(len(FakeSession.instances), 1)

    def test_timeout_no_retry_then_next_request_new_confirmed_session(self):
        FakeSession.error = 'SERVER_FILES_TIMEOUT'
        with self.assertRaises(ValueError):
            self.channel.call({'mode': 'drives'})
        self.assertEqual(len(FakeSession.instances[0].calls), 1)
        self.assertTrue(FakeSession.instances[0].closed)
        FakeSession.error = None
        self.channel.call({'mode': 'drives'})
        self.assertEqual(len(FakeSession.instances), 2)

    def test_path_failure_does_not_poison_other_reads(self):
        FakeSession.error = 'WINDOWS_PATH_UNAVAILABLE'
        with self.assertRaises(ValueError):
            self.channel.call({'mode': 'drives'})
        FakeSession.error = None
        self.channel.call({'mode': 'drives'})
        self.assertEqual(len(FakeSession.instances), 1)

    def test_expired_idle_session_stops_before_replacement(self):
        self.channel.call({'mode': 'drives'})
        FakeSession.instances[0].started -= 60
        self.channel.call({'mode': 'drives'})
        self.assertTrue(FakeSession.instances[0].closed)
        self.assertEqual(len(FakeSession.instances), 2)


class SettingsTests(unittest.TestCase):
    def test_evidence_bound_to_exact_tenant_identity_and_policy(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            manifest = {'installationId': 'a', 'connectionId': 'server', 'connectionConfig': 'config', 'accessManifest': 'access'}
            config, credentials, access = {}, {'username': 'personal-or-technical-is-not-proof'}, {'readRoots': ['C:\\Work']}
            evidence = {'installationId': 'a', 'connectionId': 'server', 'accountSid': 'S-1-5-21-1', 'dedicatedSession': True, 'readOnlyAclVerified': True, 'policyFingerprint': c.fingerprint(config, credentials, access), 'assessmentId': 'verified-admin-assessment'}
            config_path, evidence_path = root / 'config.json', root / 'evidence.json'
            config_path.write_text(json.dumps({'schemaVersion': 1, 'mode': 'rdpdr', 'installationId': 'a', 'connectionId': 'server', 'identityEvidenceFile': str(evidence_path)}))
            with patch.object(c.rdp, 'private_file', side_effect=Path), patch.object(c.rdp, 'load_config', return_value=(config, credentials, access, root)):
                for field, bad in [('installationId', 'other'), ('accountSid', 'user-name'), ('dedicatedSession', False), ('readOnlyAclVerified', False), ('policyFingerprint', '0' * 64)]:
                    evidence_path.write_text(json.dumps({**evidence, field: bad}))
                    with self.subTest(field=field), self.assertRaises(ValueError):
                        c.settings(config_path, manifest)
                evidence_path.write_text(json.dumps(evidence))
                self.assertEqual(c.settings(config_path, manifest)[4], evidence['accountSid'])

    def test_legacy_session_checks_quarantine_before_spawning_any_process(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            marker = root / '.read-channel-lease.json'
            marker.write_text(json.dumps({'job': 'channel-' + 'a' * 32, 'nonce': 'b' * 32}))
            marker.chmod(0o600)
            session = c.rdp.RdpSession({}, {}, 'ts', root / 'legacy-job')
            with patch.object(c.rdp.subprocess, 'Popen') as spawn:
                with self.assertRaisesRegex(ValueError, 'QUARANTINED'):
                    session.__enter__()
                spawn.assert_not_called()

    def test_legacy_channel_guard_denies_other_jobs_and_never_expires_by_time(self):
        with patch.object(c.lease, 'read', return_value={'job': 'channel-' + 'a' * 32, 'nonce': 'b' * 32}):
            with self.assertRaisesRegex(ValueError, 'QUARANTINED'):
                c.lease.check(Path('/tmp/imports/legacy-job'))
            c.lease.check(Path('/tmp/imports/channel-' + 'a' * 32))

class BrokerIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.broker = c.module('rdp-server-files-broker')
        self.manifest = {'installationId': 'tenant-one', 'connectionId': 'windows', 'sourceRoots': ['C:\\Work'], 'publications': [{'scope': 'company', 'scopeId': None}]}
        import uuid
        self.value = {'schemaVersion': 1, 'installationId': 'tenant-one', 'connectionId': 'windows', 'requestId': str(uuid.uuid4()), 'operation': 'browse', 'input': {'query': 'server:/C/Work', 'limit': 50}}

    def test_default_dispatch_stays_on_existing_transport(self):
        server = object.__new__(self.broker.Server)
        server.slot = threading.BoundedSemaphore(1)
        server.channel = None
        with patch.object(server, 'run', return_value={'available': True}) as run:
            self.assertTrue(server.dispatch(self.value)['available'])
            run.assert_called_once_with(self.value)

    def test_opt_in_transport_failure_never_falls_back_to_rdp(self):
        from contextlib import nullcontext
        from unittest.mock import Mock
        server = object.__new__(self.broker.Server)
        server.manifest = self.manifest
        server.slot = threading.BoundedSemaphore(1)
        server.channel_slots = threading.BoundedSemaphore(4)
        server.channel = Mock()
        server.channel.browse.side_effect = ValueError('SERVER_FILES_TIMEOUT')
        with patch.object(server, 'run') as legacy, patch.object(self.broker.sync, 'scope_directory'), patch.object(self.broker, 'folder_module', return_value=SimpleNamespace(interactive_access=lambda *a, **k: nullcontext())):
            result = server.dispatch(self.value)
            self.assertEqual(result['error'], 'SERVER_FILES_TIMEOUT')
            self.assertFalse(result['available'])
            legacy.assert_not_called()
            server.channel.browse.assert_called_once()

    def test_oversized_result_rejected_before_socket_write(self):
        server = object.__new__(self.broker.Server)
        server.manifest = self.manifest
        server.channel = object()
        server.channel_slots = threading.BoundedSemaphore(4)
        with patch.object(self.broker, 'execute', return_value={'available': True, 'content': 'x' * (256 * 1024)}):
            result = server.dispatch(self.value)
            self.assertFalse(result['available'])
            self.assertEqual(result['error'], 'SERVER_FILES_UNAVAILABLE')

    def test_foreign_installation_rejected_before_channel(self):
        from unittest.mock import Mock
        channel = Mock()
        with self.assertRaises(ValueError):
            self.broker.execute(self.manifest, {**self.value, 'installationId': 'other'}, channel=channel)
        channel.browse.assert_not_called()


class RecoveryTests(unittest.TestCase):
    def test_only_valid_signed_done_for_same_session_clears_marker(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            value = {'job': 'channel-' + 'a' * 32, 'nonce': 'b' * 32}
            job = root / value['job']
            job.mkdir()
            key = b'x' * 32
            (job / 'bridge.ps1').write_text("$key=[Convert]::FromBase64String('" + base64.b64encode(key).decode() + "')")
            with patch.object(c.rdp, 'load_config', return_value=({}, {}, {}, root)), patch.object(c.rdp, 'private_file', side_effect=Path), patch.object(c.sync, 'secure_dir'), patch.object(c.lease, 'read', return_value=value), patch.object(c.lease, 'release') as release:
                manifest = {'connectionConfig': 'c', 'accessManifest': 'a'}
                for frame in [b'{}', c.pack({'state': 'stopped', 'nonce': 'foreign'}, key), c.pack({'state': 'ready', 'nonce': value['nonce']}, key)]:
                    (job / 'done.json').write_bytes(frame)
                    with self.assertRaises(ValueError):
                        c.recover_stopped(manifest)
                    release.assert_not_called()
                (job / 'done.json').write_bytes(c.pack({'state': 'stopped', 'nonce': value['nonce']}, key))
                self.assertTrue(c.recover_stopped(manifest))
                release.assert_called_once_with(root, value['job'], value['nonce'])


if __name__ == '__main__':
    unittest.main()
