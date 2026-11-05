#!/usr/bin/env python3
"""Synthetic test process only. Never package/install as the Windows connector.

Exercises the real Unix handler -> queue -> HTTP poll/result -> converter.
The Windows filesystem and document extractor are explicit synthetic doubles.
Linux SO_PEERCRED is NOT tested here (Mac local test owner substitutes it).
"""
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import threading
import time
import urllib.request
import uuid

from relay import HttpServer, Relay, UnixServer, encode, timestamp


directory = Path(sys.argv[1])
if len(sys.argv) not in (3, 4) or sys.argv[2] != '--synthetic-test-only' or not directory.is_dir() or 'g03-contract-' not in str(directory):
    raise SystemExit('SYNTHETIC_TEST_DIRECTORY_REQUIRED')
protocol = 2 if len(sys.argv) == 4 and sys.argv[3] == '--clock-skew-v2' else 1
if len(sys.argv) == 4 and protocol != 2:
    raise SystemExit('UNKNOWN_SYNTHETIC_MODE')

def source_timestamp():
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=69.3 if protocol == 2 else 0)).isoformat()


class FixtureUnixServer(UnixServer):
    def verify_request(self, request, address):
        # Test-only substitution. Production class always requires Linux uid.
        return True


cfg = {'schemaVersion': 1, 'installationId': 'g03-contract-test', 'connectionId': 'g03',
       'appUid': max(os.getuid(), 1), 'appGid': max(os.getgid(), 1),
       'socketDirectory': str(directory), 'httpPort': 18443, 'tokenFile': '/synthetic/token',
       'extractorFile': '/synthetic/extractor', 'roots': [r'M:\G03\PRODUCCIO'], 'writesEnabled': True}
relay = Relay(cfg, extractor=lambda data, suffix: {'ok': True, 'text': data.decode()}, deadline=2)
unix = FixtureUnixServer(directory / 'g03.sock', relay)
os.chmod(directory / 'g03.sock', 0o660)
publisher = FixtureUnixServer(directory / 'g03-publish.sock', relay, allow_writes=True)
os.chmod(directory / 'g03-publish.sock', 0o660)
http = HttpServer(('127.0.0.1', 0), relay, 'synthetic-no-customer-token')
stop = threading.Event()
for server in (unix, publisher, http):
    threading.Thread(target=server.serve_forever, daemon=True).start()


def post(action, value):
    req = urllib.request.Request('http://127.0.0.1:%d/v1/%s' % (http.server_port, action),
        encode(value), {'Authorization': 'Bearer synthetic-no-customer-token', 'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=3) as response:
        return json.load(response)


def agent():
    documents = {cfg['roots'][0] + r'\prova.txt': 'Document sintètic G03'.encode()}
    receipts = {}
    identity = {'schemaVersion': protocol, 'installationId': cfg['installationId'], 'connectionId': 'g03', 'policyHash': relay.policy}
    while not stop.is_set():
        poll = {**identity, **({'pollId': uuid.uuid4().hex} if protocol == 2 else {})}
        response = post('poll', poll)
        if protocol == 2 and response['pollId'] != poll['pollId']:
            raise ValueError('POLL_BINDING')
        job = response['job']
        if job is None:
            stop.wait(0.02)
            continue
        if job['operation'] == 'browse' and job['source'] == cfg['roots'][0]:
            result = {'ok': True, 'checkedAt': timestamp(), 'entries': [
                {'source': cfg['roots'][0] + r'\prova.txt', 'name': 'prova.txt', 'kind': 'file', 'size': 23, 'modifiedAt': timestamp()}],
                'nextOffset': None, 'limited': False}
        elif job['operation'] == 'read' and job['source'] in documents:
            data = documents[job['source']]
            result = {'ok': True, 'checkedAt': timestamp(), 'source': job['source'], 'bytes': len(data),
                'sha256': hashlib.sha256(data).hexdigest(), 'modifiedAt': timestamp(), 'base64': base64.b64encode(data).decode()}
        elif job['operation'] == 'snapshot':
            data = documents.get(job['source'])
            result = {'ok': True, 'checkedAt': timestamp(), 'source': job['source'], 'exists': data is not None,
                'size': len(data) if data is not None else None, 'sha256': hashlib.sha256(data).hexdigest() if data is not None else None,
                'modifiedAt': timestamp() if data is not None else None}
        elif job['operation'] in ('create', 'replace'):
            original = documents.get(job['source'])
            previous = hashlib.sha256(original).hexdigest() if original is not None else None
            conflict = previous != job['expectedSha256']
            receipt = {'ok': True, 'checkedAt': timestamp(), 'source': job['source'], 'operationId': job['operationId'],
                'sha256': job['sha256'], 'previousSha256': job['expectedSha256'], 'status': 'rejected' if conflict else 'committed',
                'backupId': job['operationId'] if not conflict and original is not None else None}
            receipts[job['operationId']] = receipt
            if conflict:
                result = {'ok': False, 'error': 'WRITE_CONFLICT'}
            else:
                documents[job['source']] = base64.b64decode(job['base64'])
                result = receipt
        elif job['operation'] == 'receipt' and job['operationId'] in receipts:
            result = {**receipts[job['operationId']], 'checkedAt': timestamp()}
        else:
            result = {'ok': False, 'error': 'WINDOWS_PATH_UNAVAILABLE'}
        # Synthetic Windows wall clock is skewed. Do not change any OS clock.
        if result['ok']:
            result['checkedAt'] = source_timestamp()
            if result.get('modifiedAt') is not None: result['modifiedAt'] = source_timestamp()
            for row in result.get('entries', []): row['modifiedAt'] = source_timestamp()
        post('result', {**poll, 'jobId': job['jobId'], 'result': result})


threading.Thread(target=agent, daemon=True).start()
shutdown_requested = False
def request_shutdown(*_):
    # Python signal handlers run on the main thread: do not acquire an Event's
    # condition lock inside the handler while that same thread is in wait().
    global shutdown_requested
    shutdown_requested = True
for sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, request_shutdown)
print('SYNTHETIC_READY', flush=True)
while not shutdown_requested:
    time.sleep(0.05)
stop.set()
relay.stop()
for server in (unix, publisher, http):
    server.shutdown()
    server.server_close()
