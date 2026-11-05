import base64
import importlib.util
import hashlib
from pathlib import Path
import string
import tempfile
import threading
import unittest
from unittest.mock import patch

INFRA = Path(__file__).resolve().parents[2] / 'infra/hetzner'
def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, INFRA / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result
files = module('server_files', 'rdp-server-files.py')
broker = module('server_broker', 'rdp-server-files-broker.py')


class ServerFileTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {'connectionId': 'arnall', 'installationId': 'test',
                         'sourceRoots': [c + ':\\' for c in string.ascii_uppercase],
                         'publications': [{'scope': 'company', 'scopeId': None}]}

    def test_browse_bypasses_stale_map_and_observes_external_updates(self):
        from contextlib import nullcontext
        from types import SimpleNamespace
        import uuid
        request = {'schemaVersion': 1, 'operation': 'browse', 'requestId': str(uuid.uuid4()),
                   'installationId': 'test', 'connectionId': 'arnall',
                   'input': {'query': 'server:/Y/', 'limit': 50}}
        self.assertTrue(broker.validate_request(request, self.manifest))
        self.assertFalse(broker.validate_request(dict(request, input={'query': 'invoice', 'limit': 50}), self.manifest))
        with patch.object(broker.sync, 'scope_directory'), patch.object(broker.server_map, 'cached_search') as cached, \
             patch.object(broker, 'folder_module', return_value=SimpleNamespace(interactive_access=lambda _, **kwargs: nullcontext())), \
             patch.object(broker.files, 'search', side_effect=[{'available': True, 'results': ['old']}, {'available': True, 'results': ['external-new']}]) as live:
            self.assertEqual(broker.execute(self.manifest, request)['results'], ['old'])
            result = broker.execute(self.manifest, request)
            self.assertEqual(result['results'], ['external-new'])
            self.assertTrue(result['sourceChecked'])
            self.assertEqual(live.call_count, 2)
            cached.assert_not_called()

    def test_unsupported_reference_rejects_content_without_waiting_for_windows(self):
        import uuid
        request = {'schemaVersion': 1, 'operation': 'read', 'requestId': str(uuid.uuid4()),
                   'installationId': 'test', 'connectionId': 'arnall',
                   'input': {'path': 'server-arnall/C/Arnall/Vendes/PreusVenda.exe'}}
        with patch.object(broker.sync, 'scope_directory') as scope, patch.object(broker, 'folder_module') as folder:
            result = broker.execute(self.manifest, request, cached_only=True)
        self.assertEqual(result['error'], 'SERVER_FORMAT_NOT_READABLE')
        self.assertFalse(result['available'])
        scope.assert_called_once()
        folder.assert_not_called()

    def test_all_drives_and_unlisted_folders_are_addressable(self):
        for source in ['C:\\Users\\Report.docx', 'Y:\\PRESSUPOSTOS\\2026\\Oferta À.pdf', 'Z:\\Other\\Sheet.xlsx']:
            virtual = files.virtual_path('arnall', source)
            self.assertEqual(files.source_path('arnall', virtual), (source, 1))
        self.assertEqual(files.query_request('server:/', 50)['mode'], 'drives')
        self.assertEqual(files.query_request('Y:/PRESSUPOSTOS', 50)['source'], 'Y:\\PRESSUPOSTOS')

    def test_encoded_paths_cannot_escape_or_select_credentials(self):
        for suffix in ['Y/../x', 'Y/%2e%2e/x', 'Y/a%2fb', 'Y/a%5cb', 'Y/secret.key',
                       'Y/.env', 'Y/abc:stream', 'Y/NUL.txt', 'Y/a?command=whoami']:
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                files.source_path('arnall', 'server-arnall/' + suffix)
        with self.assertRaises(ValueError):
            files.source_path('other', 'server-arnall/Y/file.txt')

    def test_queries_are_data_and_fit_windows_command_limit(self):
        term = "quote'; Write-Output unexpected-command; '"
        request = files.query_request(term, 50)
        command = files.command(request, {'readRoots': self.manifest['sourceRoots']}, 'a'*32)
        self.assertLessEqual(len(command), 7800)
        program = base64.b64decode(command.split()[-1]).decode('utf-16le')
        self.assertNotIn(term, program)
        self.assertIn('ReparsePoint', program)
        self.assertIn('tsclient', program)
        self.assertIn('Elapsed.TotalSeconds-lt15', program)
        self.assertNotIn('Set-Content', program)

    def test_live_directory_page_returns_server_paths_and_continuation(self):
        def run(_, request):
            self.assertEqual(request['source'], 'Y:\\PRESSUPOSTOS')
            self.assertEqual(request['offset'], 50)
            return {'ok': True, 'entries': [{'source': 'Y:\\PRESSUPOSTOS\\Oferta.pdf', 'directory': False,
                    'bytes': 42, 'modifiedUtc': '2026-09-02T00:00:00Z'}], 'nextOffset': 100,
                    'truncated': True, 'recordedAt': '2026-09-02T00:00:00Z'}
        result = files.search(self.manifest, 'server:/Y/PRESSUPOSTOS?offset=50', 50, run)
        self.assertEqual(result['results'][0]['path'], 'server-arnall/Y/PRESSUPOSTOS/Oferta.pdf')
        self.assertTrue(result['limited'])
        self.assertEqual(result['nextQuery'], 'server:/Y/PRESSUPOSTOS?offset=100')

    def test_remote_listing_cannot_inject_another_folder_or_sensitive_path(self):
        def run(*_):
            return {'ok': True, 'entries': [
                {'source': 'Y:\\Other\\file.txt', 'directory': False, 'bytes': 1},
                {'source': 'Y:\\PRESSUPOSTOS\\junction', 'directory': True, 'bytes': 0, 'reparse': True},
                {'source': 'Y:\\PRESSUPOSTOS\\passwords.txt', 'directory': False, 'bytes': 1}],
                'truncated': False, 'recordedAt': 'now'}
        result = files.search(self.manifest, 'server:/Y/PRESSUPOSTOS', 50, run)
        self.assertEqual(result['results'], [])
        self.assertTrue(result['limited'])

    def test_denied_folders_mean_incomplete_search_not_global_absence(self):
        result = files.search(self.manifest, 'unknown', 50, lambda *_: {
            'ok': True, 'entries': [], 'denied': 1, 'truncated': False, 'recordedAt': 'now'})
        self.assertTrue(result['limited'])
        self.assertIn('No interpretes', result['warning'])

    def test_read_checks_connection_root_and_format_before_remote_call(self):
        def never(*_, **__):
            self.fail('Remote call was not authorized')
        restricted = {**self.manifest, 'sourceRoots': ['Y:\\Approved']}
        for path in ['server-arnall/Y/Other.txt', 'server-other/Y/Approved/a.txt', 'server-arnall/Y/Approved/a.exe']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                files.read(restricted, path, never)

    def test_read_checks_fresh_bytes_before_extracting_and_returns_parts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            original = root / 'payload'
            original.write_bytes(b'source bytes')
            digest = hashlib.sha256(original.read_bytes()).hexdigest()
            manifest = {**self.manifest, 'importsRoot': root, 'maxFileBytes': 16 * 1024 * 1024}
            receipt = {'destination': str(original), 'sha256': digest, 'verifiedSha256': digest,
                       'bytes': original.stat().st_size, 'recordedAt': '2026-09-02T00:00:00Z',
                       'modifiedUtc': '2026-09-01T00:00:00Z'}
            calls = []
            def copy(_, operation, source, attempts):
                calls.append((operation, source, attempts))
                return receipt
            extract = lambda *_: {'ok': True, 'text': 'x' * (120 * 1024 + 5)}
            target = 'server-arnall/Y/PRESSUPOSTOS/Oferta.pdf'
            first = files.read(manifest, target, copy, extract)
            second = files.read(manifest, first['nextPath'], copy, extract)
            self.assertEqual((first['parts'], second['part']), (2, 2))
            self.assertEqual(first['sha256'], second['sha256'])
            self.assertIsNone(second['nextPath'])
            self.assertEqual(calls, [('copy', 'Y:\\PRESSUPOSTOS\\Oferta.pdf', 1)] * 2)
            original.write_bytes(b'changed bytes')
            with self.assertRaisesRegex(ValueError, 'INVALID_SERVER_COPY'):
                files.read(manifest, target, copy, lambda *_: self.fail('Unverified copy was extracted'))

    def test_broker_validates_actor_binding_and_rejects_arbitrary_operations(self):
        valid = {'schemaVersion': 1, 'operation': 'search', 'requestId': '00000000-0000-4000-8000-000000000001',
                 'installationId': 'test', 'connectionId': 'arnall', 'input': {'query': 'server:/Y/PRESSUPOSTOS', 'limit': 50}}
        self.assertTrue(broker.validate_request(valid, self.manifest))
        for changed in [dict(valid, installationId='other'), dict(valid, connectionId='other'),
                        dict(valid, operation='write'), dict(valid, command='whoami'),
                        dict(valid, input={'query': 'server:/Y/../secret', 'limit': 50})]:
            self.assertFalse(broker.validate_request(changed, self.manifest))
        count = dict(valid, operation='inventory', input={'path': 'server-arnall/Y/Offers', 'offset': 0})
        self.assertTrue(broker.validate_request(count, self.manifest))
        for args in [{'path': 'server-other/Y/Offers', 'offset': 0}, {'path': 'server-arnall/Y/Offers', 'offset': True},
                     {'path': 'server-arnall/Y/Offers?part=1', 'offset': 0}, {'path': 'server-arnall/Y/Offers', 'offset': -1}]:
            self.assertFalse(broker.validate_request(dict(count, input=args), self.manifest))

    def test_source_busy_and_specific_path_rejection_are_not_server_outages(self):
        value = {'schemaVersion': 1, 'operation': 'read', 'requestId': '00000000-0000-4000-8000-000000000001',
                 'installationId': 'test', 'connectionId': 'arnall', 'input': {'path': 'server-arnall/Y/file.pdf'}}
        from contextlib import nullcontext
        from types import SimpleNamespace
        for error, code in [(BlockingIOError(), 'SERVER_FILES_BUSY'), (ValueError('WINDOWS_PATH_UNAVAILABLE'), 'WINDOWS_PATH_UNAVAILABLE')]:
            with patch.object(broker.sync, 'scope_directory'), patch.object(broker.files, 'read', side_effect=error), \
                 patch.object(broker, 'folder_module', return_value=SimpleNamespace(interactive_access=lambda _, **kwargs: nullcontext())):
                result = broker.execute(self.manifest, value)
                self.assertFalse(result['available'])
                self.assertEqual(result['error'], code)

    def test_metadata_queries_run_while_windows_read_remains_serialized(self):
        server = object.__new__(broker.Server)
        server.slot = threading.BoundedSemaphore(1)
        server.lookup_slots = threading.BoundedSemaphore(2)
        entered, release = threading.Event(), threading.Event()
        def run(value, cached_only=False):
            if cached_only:
                return None if value['operation'] == 'read' else {'available': True, 'lookupMode': 'metadata-map'}
            entered.set()
            if not release.wait(2):
                raise RuntimeError('Test did not release source')
            return {'available': True}
        server.run = run
        worker = threading.Thread(target=lambda: server.dispatch({'operation': 'read'}))
        worker.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertTrue(server.dispatch({'operation': 'search'})['available'])
            self.assertTrue(server.dispatch({'operation': 'inventory'})['available'])
            self.assertEqual(server.dispatch({'operation': 'read'})['error'], 'SERVER_FILES_BUSY')
        finally:
            release.set();worker.join(3)
        self.assertFalse(worker.is_alive())

    def test_cached_only_miss_never_contacts_windows(self):
        value = {'schemaVersion': 1, 'operation': 'search', 'requestId': '00000000-0000-4000-8000-000000000001',
                 'installationId': 'test', 'connectionId': 'arnall', 'input': {'query': 'server:/Y/Unknown', 'limit': 50}}
        with patch.object(broker.sync, 'scope_directory'), patch.object(broker.server_map, 'cached_search', return_value=None), \
             patch.object(broker.files, 'search') as live:
            self.assertIsNone(broker.execute(self.manifest, value, cached_only=True))
            live.assert_not_called()

    def test_scope_revalidation_precedes_every_file_operation(self):
        value = {'schemaVersion': 1, 'operation': 'read', 'requestId': '00000000-0000-4000-8000-000000000001',
                 'installationId': 'test', 'connectionId': 'arnall', 'input': {'path': 'server-arnall/Y/file.txt'}}
        with patch.object(broker.sync, 'scope_directory', side_effect=ValueError('SCOPE_BINDING_MISMATCH')), \
             patch.object(broker.files, 'read') as reader, self.assertRaisesRegex(ValueError, 'SCOPE_BINDING_MISMATCH'):
            broker.execute(self.manifest, value)
        reader.assert_not_called()

    def test_read_only_service_does_not_expose_docker_or_windows_credentials(self):
        unit = (INFRA / 'aibrain-arnall-server-files.service').read_text()
        self.assertIn('ProtectSystem=strict', unit)
        self.assertIn('KillMode=control-group', unit)
        self.assertIn('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK', unit)
        self.assertNotIn('docker.sock', unit)
        self.assertNotIn('credentials.env', unit)
        self.assertNotIn('enterprise-documents', unit)

class InteractiveAdmissionTests(unittest.TestCase):
    def test_busy_source_waits_then_executes_windows_exactly_once(self):
        import fcntl
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            access = {'readRoots': ['C:\\'], 'target': 'ts'}
            class FakeSession:
                calls = 0
                def __init__(self, *args): pass
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def execute(self, command, nonce, timeout):
                    self.calls += 1
                    return {'ok': True, 'entries': [], 'nonce': nonce}
            session = FakeSession()
            with patch.object(files.rdp, 'load_config', return_value=({}, {}, access, root)), patch.object(files.rdp, 'RdpSession', return_value=session), patch.object(files.fcntl, 'flock', side_effect=[BlockingIOError(), BlockingIOError(), None]) as acquire, patch.object(files.time, 'sleep'):
                result = files.browse({'connectionConfig': 'x', 'accessManifest': 'y'}, {'mode': 'drives', 'limit': 50}, lock_wait_seconds=1)
            self.assertEqual(acquire.call_count, 3)
            self.assertEqual(session.calls, 1)
            self.assertEqual(result['transportDiagnostic']['phase'], 'complete')

    def test_default_background_admission_stays_nonblocking(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(files.rdp, 'load_config', return_value=({}, {}, {'readRoots': ['C:\\'], 'target': 'ts'}, Path(root))), patch.object(files.fcntl, 'flock', side_effect=BlockingIOError()), patch.object(files.rdp, 'RdpSession') as session:
                with self.assertRaises(BlockingIOError) as error:
                    files.browse({'connectionConfig': 'x', 'accessManifest': 'y'}, {'mode': 'drives', 'limit': 50})
                session.assert_not_called()
                self.assertEqual(error.exception.server_file_diagnostic['phase'], 'source_lock')

    def test_interactive_read_retries_only_refused_admission(self):
        with patch.object(broker.sync, 'rdp_call', side_effect=[BlockingIOError(), {'ok': True}]) as call, patch.object(broker.time, 'sleep'):
            self.assertTrue(broker.interactive_read_call({}, 'copy', 'C:\\Work\\a.txt')['ok'])
            self.assertEqual(call.call_count, 2)
            self.assertEqual(call.call_args.kwargs, {'attempts': 1})
        with patch.object(broker.sync, 'rdp_call', side_effect=ValueError('RDP_OPERATION_FAILED')) as call:
            with self.assertRaises(ValueError):
                broker.interactive_read_call({}, 'copy', 'C:\\Work\\a.txt')
            call.assert_called_once()

    def test_interactive_read_admission_is_bounded(self):
        with patch.object(broker.sync, 'rdp_call', side_effect=BlockingIOError()) as call, patch.object(broker.time, 'monotonic', side_effect=[0, 56]):
            with self.assertRaises(BlockingIOError):
                broker.interactive_read_call({}, 'copy', 'C:\\Work\\a.txt')
            call.assert_called_once()

    def test_disconnected_client_does_not_hide_source_completion(self):
        import io, json, uuid
        from types import SimpleNamespace
        from unittest.mock import Mock
        request = {'schemaVersion': 1, 'operation': 'browse', 'requestId': str(uuid.uuid4()), 'installationId': 'test', 'connectionId': 'arnall', 'input': {'query': 'server:/', 'limit': 50}}
        handler = object.__new__(broker.Handler)
        handler.connection = SimpleNamespace(settimeout=Mock())
        handler.rfile = io.BytesIO((json.dumps(request)+'\n').encode())
        handler.wfile = SimpleNamespace(write=Mock(side_effect=BrokenPipeError()))
        handler.server = SimpleNamespace(manifest={'installationId': 'test', 'connectionId': 'arnall'}, dispatch=Mock(return_value={'available': True, 'results': []}))
        with patch('builtins.print') as log:
            handler.handle()
        event = json.loads(log.call_args.args[0])
        self.assertFalse(event['delivered'])
        self.assertTrue(event['available'])
        self.assertEqual(event['requestId'], request['requestId'])
        handler.server.dispatch.assert_called_once()

    def test_nonce_timeout_has_sanitized_phase_without_command_or_source(self):
        class FakeSession:
            def __init__(self, *args): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def execute(self, *args, **kwargs):
                raise ValueError('No matching RDP readback; source access was not confirmed')
        with tempfile.TemporaryDirectory() as root:
            with patch.object(files.rdp, 'load_config', return_value=({}, {}, {'readRoots': ['C:\\'], 'target': 'ts'}, Path(root))), patch.object(files.rdp, 'RdpSession', FakeSession):
                with self.assertRaises(ValueError) as error:
                    files.browse({'connectionConfig': 'x', 'accessManifest': 'y'}, {'mode': 'drives', 'limit': 50})
            diagnostic = error.exception.server_file_diagnostic
            self.assertEqual(diagnostic['phase'], 'readback')
            self.assertEqual(diagnostic['cause'], 'RDP_READBACK_TIMEOUT')
            self.assertEqual(set(diagnostic), {'phase', 'timingsMs', 'cause'})


class ServerNavigationTests(unittest.TestCase):
    def test_root_config_binds_shortcuts_to_existing_installation_connection_and_roots(self):
        import json
        manifest = {'installationId': 'test', 'connectionId': 'arnall', 'sourceRoots': ['C:\\Arnall']}
        value = {'schemaVersion': 1, 'installationId': 'test', 'connectionId': 'arnall', 'entryPoints': [{'label': 'Compres', 'path': 'server-arnall/C/Arnall/Compres'}]}
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / 'navigation.json'
            with patch.object(broker.files.rdp, 'private_file', return_value=p):
                p.write_text(json.dumps(value))
                self.assertEqual(broker.navigation_entries(p, manifest), value['entryPoints'])
                for bad in [{**value, 'installationId': 'other'}, {**value, 'entryPoints': [{'label': 'Foreign', 'path': 'server-arnall/Y/Other'}]}, {**value, 'entryPoints': value['entryPoints'] * 2}]:
                    p.write_text(json.dumps(bad))
                    with self.assertRaises(ValueError):
                        broker.navigation_entries(p, manifest)
        self.assertEqual(broker.navigation_entries(None, manifest), [])


if __name__ == '__main__':
    unittest.main()
