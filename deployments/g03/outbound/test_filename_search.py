"""Offline relay/queue contract tests; no Windows/provider/customer data."""
import copy
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
import urllib.request
import uuid

from relay import HttpServer, Relay, UnixServer, encode, plan, timestamp


ROOT = r'M:\Company'
CONFIG = {'installationId': 'g03-synthetic', 'connectionId': 'g03', 'roots': [ROOT], 'writesEnabled': False}


def request(**overrides):
    args = {'roots': ['server-g03/M/Company/Drawings'], 'needle': '005127134', 'cursor': None,
            'binding': 'a' * 64, 'limit': 2, 'budgetMs': 4000}
    args.update(overrides)
    return {'schemaVersion': 1, 'operation': 'filename_search', 'requestId': str(uuid.uuid4()),
            'installationId': CONFIG['installationId'], 'connectionId': 'g03', 'input': args}


def result(next_cursor=None):
    return {'ok': True, 'checkedAt': timestamp(), 'entries': [{'source': ROOT + r'\Drawings\00512-7134.pdf',
            'name': '00512-7134.pdf', 'kind': 'file', 'size': 12, 'modifiedAt': timestamp()}],
            'nextCursor': next_cursor, 'limited': next_cursor is not None,
            'coverage': {'complete': next_cursor is None, 'snapshot': False,
                         'scannedEntries': 12, 'scannedFolders': 3, 'pendingFolders': int(next_cursor is not None)}}


class FilenameSearchContract(unittest.TestCase):
    def test_actual_unix_disconnect_cancels_queue_with_negotiated_http_poll_and_late_result(self):
        class FixtureUnix(UnixServer):
            def verify_request(self, connection, address):
                return True  # Synthetic socket only; not Linux peer-UID acceptance.
        relay = Relay(CONFIG, deadline=3)
        http = HttpServer(('127.0.0.1', 0), relay, 'synthetic-only')
        def post(body):
            req = urllib.request.Request('http://127.0.0.1:%s/v1/poll' % http.server_port, encode(body),
                {'Authorization': 'Bearer synthetic-only', 'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(req, timeout=1) as response: return json.load(response)
        def poll(capability=False):
            return {'schemaVersion': 2, 'installationId': CONFIG['installationId'], 'connectionId': 'g03',
                'policyHash': relay.policy, 'pollId': uuid.uuid4().hex,
                **({'capabilities': ['filename_search_v1']} if capability else {})}
        with tempfile.TemporaryDirectory(prefix='filename-contract-') as temporary:
            unix = FixtureUnix(Path(temporary) / 'g03.sock', relay)
            threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (http, unix)]
            for thread in threads: thread.start()
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                self.assertIsNone(post(poll(True))['job'])
                client.connect(os.path.join(temporary, 'g03.sock')); client.sendall(encode(request()) + b'\n')
                for _ in range(100):
                    if relay.jobs: break
                    time.sleep(.002)
                self.assertIsNone(post(poll())['job'])
                identity = poll(True); job = post(identity)['job']; self.assertEqual(job['operation'], 'filename_search')
                active = {k: v for k, v in identity.items() if k != 'capabilities'}
                active.update(jobId=job['jobId'], active=True)
                self.assertTrue(post(active)['active'])
                client.close()
                for _ in range(100):
                    if not relay.jobs: break
                    time.sleep(.003)
                self.assertFalse(relay.jobs); self.assertFalse(post(active)['active'])
                late = {k: v for k, v in active.items() if k != 'active'}; late['result'] = result()
                req = urllib.request.Request('http://127.0.0.1:%s/v1/result' % http.server_port, encode(late),
                    {'Authorization': 'Bearer synthetic-only', 'Content-Type': 'application/json'}, method='POST')
                with urllib.request.urlopen(req, timeout=1) as response: self.assertFalse(json.load(response)['accepted'])
            finally:
                client.close()
                for server in (http, unix): server.shutdown(); server.server_close()
                for thread in threads: thread.join(1)

    def test_plan_intersects_scopes_and_carries_literal_data(self):
        task = plan(CONFIG, request(needle='a[0].txt', roots=['server-g03/M/Company']))
        self.assertEqual(task['roots'], [ROOT])
        self.assertEqual(task['needle'], 'a[0].txt')
        self.assertEqual(task['budgetMs'], 4000)

    def test_denies_foreign_scope_traversal_and_unbounded_input(self):
        for values in [{'roots': ['server-g03/M/Other']}, {'roots': ['server-g03/M/Company/%2e%2e/Other']},
                       {'roots': ['server-g03/M/Company/a%2fb']}, {'needle': '../secret'},
                       {'needle': 'a\x00b'}, {'budgetMs': 4001}, {'limit': 51}, {'cursor': 'not-a-cursor'}]:
            with self.subTest(values=values), self.assertRaises(ValueError): plan(CONFIG, request(**values))

    def test_continuation_requires_opaque_cursor_and_binding(self):
        token = str(uuid.uuid4())
        task = plan(CONFIG, request(cursor=token, needle=None))
        self.assertEqual(task['cursor'], token)
        for values in [{'cursor': token}, {'cursor': token, 'needle': None, 'binding': ''}]:
            with self.assertRaises(ValueError): plan(CONFIG, request(**values))

    def test_old_agent_is_unsupported_and_stale_agent_is_offline(self):
        relay = Relay(CONFIG, deadline=.2)
        self.assertEqual(relay.request(request())['error'], 'FILENAME_SEARCH_UNSUPPORTED')
        relay.filename_agent_seen = time.monotonic() - 31
        self.assertEqual(relay.request(request())['error'], 'SEARCH_SOURCE_OFFLINE')

    def test_queue_time_cannot_extend_the_native_execution_deadline(self):
        relay = Relay(CONFIG); nonce = uuid.uuid4().hex
        relay.jobs['synthetic'] = {'state': 'queued', 'expires': time.monotonic() + .5,
                                   'task': plan(CONFIG, request()), 'event': threading.Event()}
        job = relay.poll(2, nonce, ['filename_search_v1'])
        self.assertGreater(job['budgetMs'], 0)
        self.assertLessEqual(job['budgetMs'], 500)

    def test_legacy_poll_never_consumes_filename_search(self):
        relay = Relay(CONFIG, deadline=1)
        nonce = uuid.uuid4().hex
        relay.poll(2, nonce, ['filename_search_v1'])
        output = []
        thread = threading.Thread(target=lambda: output.append(relay.request(request())))
        thread.start()
        for _ in range(100):
            if relay.jobs: break
            time.sleep(.002)
        self.assertIsNone(relay.poll(1))
        self.assertIsNone(relay.poll(2, uuid.uuid4().hex))
        job = relay.poll(2, nonce, ['filename_search_v1'])
        self.assertEqual(job['operation'], 'filename_search')
        relay.submit({'schemaVersion': 2, 'installationId': CONFIG['installationId'], 'connectionId': 'g03',
                      'policyHash': relay.policy, 'jobId': job['jobId'], 'pollId': nonce, 'result': result()})
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertTrue(output[0]['available'])
        self.assertTrue(output[0]['sourceChecked'])

    def test_cancel_frees_queue_and_invalidates_active_job_without_waiting_for_source(self):
        relay = Relay(CONFIG, deadline=5); nonce = uuid.uuid4().hex
        relay.poll(2, nonce, ['filename_search_v1'])
        cancel = threading.Event(); output = []
        thread = threading.Thread(target=lambda: output.append(relay.request(request(), cancelled=cancel.is_set)))
        thread.start()
        for _ in range(100):
            if relay.jobs: break
            time.sleep(.002)
        job = relay.poll(2, nonce, ['filename_search_v1'])
        identity = {'schemaVersion': 2, 'installationId': CONFIG['installationId'], 'connectionId': 'g03',
                    'policyHash': relay.policy, 'jobId': job['jobId'], 'pollId': nonce}
        self.assertTrue(relay.active(identity))
        cancel.set(); thread.join(.3)
        self.assertFalse(thread.is_alive()); self.assertFalse(relay.jobs)
        self.assertFalse(relay.active(identity))
        self.assertEqual(output[0]['error'], 'SEARCH_CANCELLED')
        self.assertFalse(relay.submit({**identity, 'result': result()}))

    def test_busy_has_its_own_error(self):
        relay = Relay(CONFIG); relay.filename_agent_seen = time.monotonic()
        relay.jobs = {str(i): {} for i in range(4)}
        self.assertEqual(relay.request(request())['error'], 'SEARCH_SOURCE_BUSY')
        relay.jobs = {'active': {'state': 'sent'}}
        self.assertEqual(relay.request(request())['error'], 'SEARCH_SOURCE_BUSY')

    def test_conversion_preserves_partial_cursor_and_inaccessible_error(self):
        relay = Relay(CONFIG); task = plan(CONFIG, request()); token = str(uuid.uuid4())
        value = result(token); value['error'] = 'SEARCH_SOURCE_INACCESSIBLE'
        converted = relay.convert(task, request()['input'], value, 2)
        self.assertEqual(converted['nextCursor'], token)
        self.assertFalse(converted['coverage']['complete']); self.assertEqual(converted['error'], value['error'])
        self.assertEqual(relay.convert(task, {}, {'ok': False, 'error': 'SEARCH_CURSOR_EXPIRED_OR_DENIED'}, 2)['error'], 'SEARCH_CURSOR_EXPIRED_OR_DENIED')

    def test_conversion_rejects_bad_metadata_scope_replays_and_false_completeness(self):
        relay = Relay(CONFIG); task = plan(CONFIG, request())
        bad = []
        value = result(); value['entries'][0]['source'] = ROOT + r'\Private\00512-7134.pdf'; bad.append(value)
        value = result(); value['entries'].append(copy.deepcopy(value['entries'][0])); bad.append(value)
        value = result(str(uuid.uuid4())); value['limited'] = False; bad.append(value)
        value = result(); value['coverage']['snapshot'] = True; bad.append(value)
        value = result(); value['entries'][0]['source'] = ROOT + r'\Drawings\..\Private'; bad.append(value)
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ValueError): relay.convert(task, {}, value, 2)


if __name__ == '__main__': unittest.main()
