#!/usr/bin/env python3
"""Opt-in G03 outbound file relay. No Windows connection, installation or shell RPC.

Windows polls loopback HTTP behind an operator-managed HTTPS reverse proxy.
Only the existing AiBrain host Unix socket can enqueue read-only requests.
"""
import argparse
import base64
import datetime as dt
import fcntl
import hashlib
import hmac
import http.server
import json
import ntpath
import os
from pathlib import Path
import re
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.parse
import uuid

MAX_FILE = 16 * 1024 * 1024
MAX_BODY = 23 * 1024 * 1024
MAX_REPLY = 250 * 1024
FORMATS = {'.pptx', '.pdf', '.docx', '.xlsx', '.xltx', '.xlsm', '.xls', '.xlsb', '.txt', '.asc', '.csv', '.md', '.json'}
WRITE_FORMATS = {'.pdf', '.docx', '.xlsx', '.txt', '.csv', '.md'}
ID = re.compile(r'[a-z0-9][a-z0-9-]{0,62}\Z')
SENSITIVE = re.compile(r'(^|[._ -])(secrets?|credentials?|passwords?|passwd|tokens?|private.?key|backups?|c[oò]pies|copias)([._ -]|$)', re.I)


def require(ok, code='INVALID_REQUEST'):
    if not ok:
        raise ValueError(code)


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def iso_time(value):
    require(isinstance(value, str) and len(value) <= 40)
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.tzinfo is not None)
    return parsed.timestamp()


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def decode(raw):
    def unique(pairs):
        result = {}
        for k, v in pairs:
            require(k not in result)
            result[k] = v
        return result
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: require(False))


def _segment_syntax(value):
    require(isinstance(value, str) and 0 < len(value) <= 255)
    require(not value.startswith('.') and not value.endswith(('.', ' ')))
    require(not any(unicodedata.category(c).startswith('C') for c in value))
    require(not any(c in value for c in '\\/:*?<>|"%'))
    require(not re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', value))
    return value


def segment(value):
    _segment_syntax(value)
    require(not SENSITIVE.search(value), 'PATH_DENIED')
    return value


def _windows_path(value, validate_segment):
    require(isinstance(value, str) and len(value) <= 480 and re.match(r'^[A-Za-z]:\\', value))
    require('/' not in value and not value.endswith('\\'))
    parts = value[3:].split('\\')
    for part in parts:
        validate_segment(part)
    return value[0].upper() + ':\\' + '\\'.join(parts)


def windows_path(value):
    return _windows_path(value, segment)


def within(value, root):
    return value.casefold() == root.casefold() or value.casefold().startswith(root.casefold() + '\\')


def path_allowed(value, roots, ancestors=False):
    return any(within(value, root) or ancestors and within(root, value) for root in roots)


def reference(connection, source):
    return 'server-' + connection + '/' + source[0] + '/' + '/'.join(
        urllib.parse.quote(p, safe='') for p in source[3:].split('\\') if p)


def source_reference(connection, value):
    prefix = 'server-' + connection + '/'
    require(isinstance(value, str) and len(value) <= 1024 and value.startswith(prefix))
    raw, _, query = value.partition('?')
    require(not query or re.fullmatch(r'part=[1-9][0-9]{0,2}', query))
    parts = raw[len(prefix):].rstrip('/').split('/')
    require(re.fullmatch(r'[A-Z]', parts[0]))
    names = [segment(urllib.parse.unquote(p, errors='strict')) for p in parts[1:]]
    source = parts[0] + ':\\' + '\\'.join(names)
    require(len(source) <= 480)
    return source, int(query[5:]) if query else 1


def validate_config(config):
    require(isinstance(config, dict) and set(config) - {'extractorDependencies'} == {
        'schemaVersion', 'installationId', 'connectionId', 'appUid', 'appGid',
        'socketDirectory', 'httpPort', 'tokenFile', 'roots', 'extractorFile', 'writesEnabled'}, 'INVALID_CONFIG')
    require(type(config['schemaVersion']) is int and config['schemaVersion'] == 1)
    require(ID.fullmatch(config['installationId']) and config['connectionId'] == 'g03')
    require(config['installationId'].startswith('g03'), 'FOREIGN_INSTALLATION')
    require(type(config['writesEnabled']) is bool)
    for key in ('appUid', 'appGid'):
        require(type(config[key]) is int and config[key] > 0)
    require(type(config['httpPort']) is int and 1024 <= config['httpPort'] <= 65535)
    for key in ('socketDirectory', 'tokenFile', 'extractorFile'):
        require(isinstance(config[key], str) and Path(config[key]).is_absolute())
    if 'extractorDependencies' in config:
        require(isinstance(config['extractorDependencies'], str) and Path(config['extractorDependencies']).is_absolute())
    roots = config['roots']
    require(isinstance(roots, list) and 1 <= len(roots) <= 16)
    require(all(windows_path(r) == r and len(r) > 3 for r in roots))
    require(len(set(r.casefold() for r in roots)) == len(roots))
    for r in roots:
        require(not re.match(r'(?i)C:\\(Windows|Users|ProgramData|Program Files)(\\|$)', r))
        require(not any(within(r, other) for other in roots if r != other), 'OVERLAPPING_ROOTS')
    return config


def policy_hash(config):
    # Windows receives this string, but independently enforces its local roots.
    return hashlib.sha256(encode({'installationId': config['installationId'],
        'connectionId': config['connectionId'], 'roots': config['roots'], 'writesEnabled': config['writesEnabled']})).hexdigest()


def plan(config, value, allow_writes=False):
    require(isinstance(value, dict) and set(value) == {
        'schemaVersion', 'operation', 'requestId', 'installationId', 'connectionId', 'input'})
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1)
    require(value['installationId'] == config['installationId'] and value['connectionId'] == config['connectionId'], 'FOREIGN_INSTALLATION')
    require(isinstance(value['requestId'], str) and str(uuid.UUID(value['requestId'])) == value['requestId'])
    args = value['input']
    require(isinstance(args, dict))
    if value['operation'] == 'snapshot':
        require(allow_writes and config['writesEnabled'], 'WRITES_NOT_ENABLED')
        require(set(args) == {'path'})
        source, part = source_reference(config['connectionId'], args['path'])
        require(part == 1 and '?' not in args['path'] and path_allowed(source, config['roots']), 'PATH_DENIED')
        require(ntpath.splitext(source)[1].lower() in WRITE_FORMATS, 'WRITE_FORMAT_NOT_SUPPORTED')
        return {'operation': 'snapshot', 'source': source}
    if value['operation'] in ('create', 'replace', 'receipt'):
        require(allow_writes and config['writesEnabled'], 'WRITES_NOT_ENABLED')
        receipt = value['operation'] == 'receipt'
        fields = {'path', 'operationId', 'expectedSha256', 'sha256', 'actorId', 'projectId'}
        require(set(args) == fields | ({'writeOperation'} if receipt else {'base64'}))
        operation = args['writeOperation'] if receipt else value['operation']
        require(operation in ('create', 'replace'))
        source, part = source_reference(config['connectionId'], args['path'])
        require(part == 1 and '?' not in args['path'] and path_allowed(source, config['roots']), 'PATH_DENIED')
        require(ntpath.splitext(source)[1].lower() in WRITE_FORMATS, 'WRITE_FORMAT_NOT_SUPPORTED')
        for name in ('operationId', 'actorId', 'projectId'):
            require(str(uuid.UUID(args[name])) == args[name])
        require(isinstance(args['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', args['sha256']))
        require(args['expectedSha256'] is None if operation == 'create' else
                isinstance(args['expectedSha256'], str) and re.fullmatch(r'[a-f0-9]{64}', args['expectedSha256']))
        if receipt:
            return {'operation': 'receipt', 'source': source,
                    **{k: args[k] for k in ('writeOperation', 'operationId', 'expectedSha256', 'sha256', 'actorId', 'projectId')}}
        require(isinstance(args['base64'], str) and len(args['base64']) <= (MAX_FILE + 2) // 3 * 4)
        data = base64.b64decode(args['base64'], validate=True)
        require(0 < len(data) <= MAX_FILE and hashlib.sha256(data).hexdigest() == args['sha256'])
        return {'operation': value['operation'], 'source': source,
                **{k: args[k] for k in ('operationId', 'expectedSha256', 'sha256', 'base64', 'actorId', 'projectId')}}
    if value['operation'] in ('browse', 'search'):
        require(set(args) == {'query', 'limit'} and type(args['limit']) is int and 1 <= args['limit'] <= 50)
        query = args['query']
        require(isinstance(query, str) and len(query) <= 200)
        if re.match(r'^[A-Za-z]:[\\/]', query):
            query = 'server:/' + query[0].upper() + '/' + query[3:].replace('\\', '/')
        require(query.startswith('server:/'), 'SERVER_NAME_SEARCH_NOT_ENABLED')
        raw, _, offset = query[8:].partition('?')
        require(not offset or re.fullmatch(r'offset=[0-9]{1,5}', offset))
        require(bool(raw) or not offset)
        source = ''
        if raw:
            source, part = source_reference(config['connectionId'], 'server-' + config['connectionId'] + '/' + raw)
            require(part == 1 and path_allowed(source.rstrip('\\'), config['roots'], True), 'PATH_DENIED')
        return {'operation': 'browse', 'source': source, 'offset': int(offset[7:]) if offset else 0, 'limit': args['limit']}
    if value['operation'] == 'inventory':
        raise ValueError('SERVER_RECURSIVE_INVENTORY_NOT_ENABLED')
    require(value['operation'] == 'read' and set(args) in ({'path'}, {'path', 'format'}))
    require('format' not in args or args['format'] == 'original')
    source, part = source_reference(config['connectionId'], args['path'])
    require(path_allowed(source, config['roots']), 'PATH_DENIED')
    require(ntpath.splitext(source)[1].lower() in FORMATS or (args.get('format') == 'original' and ntpath.splitext(source)[1].lower() in {'.accdb', '.doc'}), 'SERVER_FORMAT_NOT_READABLE')
    require('format' not in args or part == 1 and '?' not in args['path'])
    return {'operation': 'read', 'source': source, 'part': part}


def failure(code):
    return {'available': False, 'error': code,
        'warning': 'No se ha confirmado la operación. En una escritura incierta, conserva el identificador y comprueba el recibo antes de repetirla. Un error de lectura no significa que la carpeta esté vacía.'}


class Relay:
    def __init__(self, config, extractor=None, deadline=55):
        self.config = config
        self.policy = policy_hash(config)
        self.extractor = extractor or self.extract
        self.deadline = deadline
        self.lock = threading.Lock()
        self.jobs = {}
        self.stopped = False

    def request(self, value, allow_writes=False):
        try:
            task = plan(self.config, value, allow_writes)
        except (ValueError, TypeError, KeyError, AttributeError):
            return failure('SERVER_REQUEST_DENIED')
        with self.lock:
            if self.stopped:
                return failure('CONNECTOR_STOPPED')
            if len(self.jobs) >= 4:
                return failure('SERVER_FILES_BUSY')
            job_id = str(uuid.uuid4())
            event = threading.Event()
            job = {'event': event, 'state': 'queued', 'task': task, 'result': None,
                'expires': time.monotonic() + self.deadline}
            self.jobs[job_id] = job
        try:
            event.wait(self.deadline)
            with self.lock:
                result = job['result']
            if result is None:
                return failure('WRITE_OUTCOME_UNCERTAIN_RETRY_SAME_OPERATION' if task['operation'] in ('create','replace')
                               and job['state'] != 'queued' else 'CONNECTOR_OFFLINE_OR_TIMEOUT')
            return self.convert(task, value['input'], result, job.get('protocol', 1))
        except Exception:
            return failure('WRITE_OUTCOME_UNCERTAIN_RETRY_SAME_OPERATION' if task['operation'] in ('create','replace') else 'SERVER_READBACK_REJECTED')
        finally:
            with self.lock:
                self.jobs.pop(job_id, None)

    def poll(self, protocol=1, poll_id=None):
        require(type(protocol) is int and protocol in (1, 2))
        if protocol == 2:
            require(isinstance(poll_id, str) and re.fullmatch(r'[a-f0-9]{32}', poll_id))
        with self.lock:
            for job_id, job in self.jobs.items():
                if job['state'] != 'queued' or time.monotonic() >= job['expires']:
                    continue
                remaining = min(55, job['expires'] - time.monotonic())
                budget_ms = int(remaining * 1000)
                if budget_ms <= 0:
                    continue
                job.update(state='sent', protocol=protocol, pollId=poll_id)
                timing = ({'budgetMs': budget_ms} if protocol == 2 else
                          {'expiresAt': (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=remaining)).isoformat()})
                return {'schemaVersion': protocol, 'installationId': self.config['installationId'],
                    'connectionId': self.config['connectionId'], 'policyHash': self.policy,
                    'jobId': job_id, **timing, **job['task']}
        return None

    def submit(self, value):
        require(isinstance(value, dict))
        protocol = value.get('schemaVersion')
        require(type(protocol) is int and protocol in (1, 2))
        require(set(value) == {'schemaVersion', 'installationId', 'connectionId', 'policyHash', 'jobId', 'result'} |
                ({'pollId'} if protocol == 2 else set()))
        require(value['installationId'] == self.config['installationId'] and
                value['connectionId'] == self.config['connectionId'] and value['policyHash'] == self.policy)
        require(isinstance(value['jobId'], str) and isinstance(value['result'], dict))
        with self.lock:
            job = self.jobs.get(value['jobId'])
            require(job is not None and job['state'] == 'sent' and time.monotonic() < job['expires'], 'EXPIRED_OR_REPLAYED_RESULT')
            require(job['protocol'] == protocol and (protocol == 1 or value['pollId'] == job['pollId']), 'WRONG_POLL_BINDING')
            job['state'] = 'complete'
            job['result'] = value['result']
            job['event'].set()

    def stop(self):
        with self.lock:
            self.stopped = True
            for job in self.jobs.values():
                job['event'].set()

    def convert(self, task, args, result, protocol=1):
        require(type(result.get('ok')) is bool)
        if not result['ok']:
            allowed = {'WINDOWS_PATH_UNAVAILABLE', 'SERVER_FORMAT_NOT_READABLE', 'SERVER_SOURCE_CHANGED',
                       'SERVER_COPY_LIMIT', 'CONNECTOR_DEADLINE', 'PATH_DENIED', 'DIRECTORY_LIMIT',
                       'WRITE_CONFLICT', 'WRITE_QUARANTINED', 'WRITE_FAILED_RESTORED', 'WRITE_DISABLED',
                       'WRITE_OPERATION_CONFLICT', 'WRITE_SOURCE_BUSY', 'WRITE_CAPACITY', 'WRITE_ATOMIC_UNAVAILABLE'}
            return failure(result.get('error') if result.get('error') in allowed else 'WINDOWS_PATH_UNAVAILABLE')
        source_time = iso_time(result.get('checkedAt'))
        if protocol == 1:
            require(abs(time.time() - source_time) < 120, 'STALE_RESULT')
        # V2 freshness is the authenticated one-shot job/nonce and the unchanged
        # monotonic server deadline in submit(), NOT the remote wall clock.
        # Preserve Windows timestamps verbatim; they are source metadata only.
        require(0 <= source_time <= 253402300799, 'INVALID_SOURCE_CLOCK')
        common = {'available': True, 'checkedAt': timestamp(), 'sourceChecked': True, 'lookupMode': 'live'}
        metadata_now = time.time()
        if protocol == 2:
            metadata_now = source_time
            common['sourceClock'] = {'basis': 'windows-wall-clock', 'checkedAt': result['checkedAt'],
                                     'freshness': 'authenticated-monotonic-job-v2'}
            if abs(time.time() - source_time) >= 120:
                common['warning'] = ('El reloj del servidor de archivos difiere del de AiBrain. '
                    'Las fechas de los documentos se conservan sin corregir; la consulta se ha comprobado en directo.')
        if task['operation'] == 'snapshot':
            require(set(result) == {'ok', 'checkedAt', 'source', 'exists', 'size', 'sha256', 'modifiedAt'})
            require(result['source'] == task['source'] and type(result['exists']) is bool)
            if result['exists']:
                require(type(result['size']) is int and 0 <= result['size'] <= MAX_FILE)
                require(isinstance(result['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', result['sha256']))
                require(0 <= iso_time(result['modifiedAt']) <= metadata_now + 300)
            else:
                require(all(result[k] is None for k in ('size', 'sha256', 'modifiedAt')))
            return {**common, 'path': args['path'], **{k: result[k] for k in ('exists', 'size', 'sha256', 'modifiedAt')}}
        if task['operation'] == 'receipt':
            require(set(result) == {'ok', 'checkedAt', 'operationId', 'source', 'sha256', 'previousSha256', 'backupId', 'status'})
            require(result['operationId'] == task['operationId'] and result['source'] == task['source'] and
                    result['sha256'] == task['sha256'] and result['previousSha256'] == task['expectedSha256'] and
                    result['status'] in ('committed', 'rejected', 'restored', 'not_found'))
            require(result['status'] != 'restored' or task['writeOperation'] == 'replace')
            has_backup = task['writeOperation'] == 'replace' and result['status'] in ('committed', 'restored')
            require(result['backupId'] == task['operationId'] if has_backup else result['backupId'] is None)
            # A durable receipt describes the historical operation. It does not
            # prove that no employee has subsequently edited the live document.
            return {**common, 'sourceChecked': False, 'path': args['path'],
                    **{k: result[k] for k in ('operationId', 'sha256', 'previousSha256', 'backupId', 'status')}}
        if task['operation'] in ('create', 'replace'):
            require(set(result) == {'ok', 'checkedAt', 'operationId', 'source', 'sha256', 'previousSha256', 'backupId', 'status'})
            require(result['operationId'] == task['operationId'] and result['source'] == task['source'] and
                    result['sha256'] == task['sha256'] and result['previousSha256'] == task['expectedSha256'] and
                    result['status'] in ('committed', 'already_committed'))
            require(result['backupId'] == task['operationId'] if task['operation'] == 'replace' else result['backupId'] is None)
            return {**common, 'sourceChecked': result['status'] == 'committed', 'path': args['path'], 'operationId': task['operationId'], 'sha256': result['sha256'],
                    'previousSha256': result['previousSha256'], 'backupId': result['backupId'], 'status': result['status']}
        if task['operation'] == 'browse':
            require(set(result) == {'ok', 'checkedAt', 'entries', 'nextOffset', 'limited'})
            rows = result['entries']
            require(isinstance(rows, list) and len(rows) <= task['limit'] and type(result['limited']) is bool)
            require(result['nextOffset'] is None or type(result['nextOffset']) is int and
                    result['nextOffset'] == task['offset'] + task['limit'] and result['nextOffset'] < 50000)
            output, seen = [], set()
            for item in rows:
                require(isinstance(item, dict) and set(item) == {'source', 'name', 'kind', 'size', 'modifiedAt'})
                source = item['source']
                if re.fullmatch(r'[A-Z]:\\', source or ''):
                    require(not task['source'] and item['name'] == source[0])
                else:
                    # A policy-excluded child must not poison its allowed parent.
                    # Validate the entire row before omitting it; direct requests
                    # still use segment()/windows_path() with the strict policy.
                    _windows_path(source, _segment_syntax)
                    require(item['name'] == ntpath.basename(source))
                    require(ntpath.dirname(source).rstrip('\\').casefold() == task['source'].rstrip('\\').casefold())
                require(path_allowed(source.rstrip('\\'), self.config['roots'], True))
                require(item['kind'] in ('file', 'directory') and type(item['size']) is int and 0 <= item['size'] <= 2**53-1)
                if not path_allowed(source.rstrip('\\'), self.config['roots']):
                    require(item['kind'] == 'directory')
                require(item['modifiedAt'] is None and item['kind'] == 'directory' or
                        0 <= iso_time(item['modifiedAt']) <= metadata_now + 300)
                key = source.casefold()
                require(key not in seen)
                seen.add(key)
                if any(SENSITIVE.search(part) for part in source[3:].split('\\')):
                    continue
                output.append({'scope': 'company', 'path': reference(self.config['connectionId'], source),
                    'kind': item['kind'], 'size': item['size'], 'modifiedAt': item['modifiedAt']})
            query = 'server:/' + (task['source'][0] + '/' + task['source'][3:].replace('\\', '/') if task['source'] else '')
            query = '/'.join(urllib.parse.quote(p, safe=':') for p in query.split('/'))
            return {**common, 'results': output, 'limited': result['limited'],
                'nextQuery': query + '?offset=' + str(result['nextOffset']) if result['nextOffset'] is not None else None}
        require(set(result) == {'ok', 'checkedAt', 'source', 'bytes', 'sha256', 'modifiedAt', 'base64'})
        require(result['source'] == task['source'] and type(result['bytes']) is int and 0 < result['bytes'] <= MAX_FILE)
        require(isinstance(result['base64'], str) and len(result['base64']) <= (MAX_FILE + 2) // 3 * 4)
        data = base64.b64decode(result['base64'], validate=True)
        require(len(data) == result['bytes'] and hashlib.sha256(data).hexdigest() == result['sha256'])
        iso_time(result['modifiedAt'])
        if args.get('format') == 'original':
            return {**common, 'scope': 'company', 'path': args['path'],
                'base64': result['base64'], 'sha256': result['sha256'],
                'size': len(data), 'modifiedAt': result['modifiedAt']}
        extracted = self.extractor(data, ntpath.splitext(task['source'])[1].lower())
        require(extracted.get('ok') is True and isinstance(extracted.get('text'), str), 'SERVER_TEXT_UNAVAILABLE')
        text = extracted['text']
        require(0 < len(text.encode('utf-8')) <= 2 * 1024 * 1024)
        # Character pages also bound UTF-8 bytes for the native socket contract.
        pages = [text[i:i + 20000] for i in range(0, len(text), 20000)]
        require(1 <= task['part'] <= len(pages), 'SERVER_PART_UNAVAILABLE')
        raw_path = args['path'].split('?')[0]
        # The sandbox emits bounded OOXML cell data, never workbook code/macros.
        preview = extracted.get('preview')
        preview_fields = {'preview': preview} if (task['part'] == 1 and
            ntpath.splitext(task['source'])[1].lower() in ('.xlsx', '.xltx', '.xlsm', '.xls', '.xlsb') and
            isinstance(preview, dict) and len(encode(preview)) <= 100000) else {}
        return {**common, 'scope': 'company', 'path': args['path'], 'content': pages[task['part'] - 1],
            'sha256': result['sha256'], 'size': len(data), 'modifiedAt': result['modifiedAt'],
            'nextPath': raw_path + '?part=' + str(task['part'] + 1) if task['part'] < len(pages) else None,
            'truncated': task['part'] < len(pages), 'part': task['part'], 'parts': len(pages), **preview_fields}

    def extract(self, data, suffix):
        # Never parse customer documents inside this privileged relay process.
        require(sys.platform == 'linux', 'LINUX_SANDBOX_REQUIRED')
        script = private_file(Path(self.config['extractorFile']), maximum=256 * 1024, executable=True)
        with tempfile.TemporaryFile() as document, tempfile.TemporaryFile() as code, tempfile.TemporaryFile() as output:
            document.write(data); document.flush(); document.seek(0)
            code.write(script); code.flush(); code.seek(0)
            cmd = sandbox_base(self.config) + [
                   '--perms', '0444', '--ro-bind-data', str(document.fileno()), '/input',
                   '--perms', '0444', '--ro-bind-data', str(code.fileno()), '/extractor.py',
                   '--chdir', '/tmp', '/usr/bin/python3', '-I', '-c', READER_BOOTSTRAP, '--format', suffix]
            subprocess.run(cmd, pass_fds=(document.fileno(), code.fileno()), stdin=subprocess.DEVNULL,
                           stdout=output, stderr=subprocess.DEVNULL, timeout=40, check=True)
            output.seek(0)
            raw = output.read(13 * 1024 * 1024 + 1)
            require(len(raw) <= 13 * 1024 * 1024)
            return decode(raw)


def private_file(file, maximum=65536, executable=False):
    require(file.is_absolute() and file.resolve() == file, 'UNSAFE_CONFIG_PATH')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & (0o022 if executable else 0o077))
        require(info.st_size <= maximum)
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read(maximum + 1)
    finally:
        os.close(fd)


READER_BOOTSTRAP = "import sys,runpy;sys.path.insert(0,'/readers');runpy.run_path('/extractor.py',run_name='__main__')"


def reader_dependency_directory(path):
    """Root-controlled code only, never a user workspace or ambient PYTHONPATH."""
    require(path.is_absolute() and path.resolve() == path, 'UNSAFE_READER_DEPENDENCIES')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'UNSAFE_READER_DEPENDENCIES')
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and
            info.st_mode & 0o005 == 0o005, 'UNSAFE_READER_DEPENDENCIES')
    count, total = 0, 0
    for entry in path.rglob('*'):
        info = entry.lstat()
        count += 1
        require(count <= 1000 and info.st_uid == 0 and not info.st_mode & 0o022 and
                not stat.S_ISLNK(info.st_mode), 'UNSAFE_READER_DEPENDENCIES')
        if stat.S_ISDIR(info.st_mode):
            require(info.st_mode & 0o005 == 0o005, 'UNSAFE_READER_DEPENDENCIES')
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_mode & 0o004 and info.st_size <= 1024 * 1024,
                    'UNSAFE_READER_DEPENDENCIES')
            total += info.st_size
            require(total <= 5 * 1024 * 1024, 'UNSAFE_READER_DEPENDENCIES')
    require((path / 'xlrd' / '__init__.py').is_file() and (path / 'pyxlsb' / '__init__.py').is_file(),
            'LEGACY_SPREADSHEET_READERS_MISSING')
    return str(path)


def sandbox_base(config=None):
    cmd = ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
           '--uid', '65534', '--gid', '65534', '--clearenv', '--setenv', 'PATH', '/usr/bin',
           '--setenv', 'LANG', 'C.UTF-8', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib',
           '--ro-bind', '/lib64', '/lib64', '--dir', '/proc', '--dev', '/dev', '--tmpfs', '/tmp']
    if config and config.get('extractorDependencies'):
        deps = reader_dependency_directory(Path(config['extractorDependencies']))
        cmd += ['--ro-bind', deps, '/readers']
    return cmd


def check_runtime_dependencies(config=None):
    # Dependency imports happen as nobody inside the same networkless sandbox,
    # not inside the privileged relay. No document is opened by preflight.
    for path, code in (('/usr/bin/bwrap', 'EXTRACTION_SANDBOX_MISSING'),
                       ('/usr/bin/python3', 'EXTRACTION_PYTHON_MISSING'),
                       ('/usr/bin/pdftotext', 'PDF_EXTRACTOR_MISSING')):
        require(Path(path).is_file() and os.access(path, os.X_OK), code)
    probe = "import sys;sys.path.insert(0,'/readers');import xlrd,pyxlsb;assert xlrd.__version__=='2.0.2' and pyxlsb.__version__=='1.0.10'"
    try:
        subprocess.run(sandbox_base(config) + ['/usr/bin/python3', '-I', '-c', probe],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       check=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        raise ValueError('LEGACY_SPREADSHEET_READERS_UNAVAILABLE') from None


class BoundedThreads(socketserver.ThreadingMixIn):
    daemon_threads = True
    request_queue_size = 8

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        super().process_request(request, address)

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


class HttpServer(BoundedThreads, http.server.HTTPServer):
    def __init__(self, address, relay, token):
        self.relay, self.token = relay, token
        self.slots = threading.BoundedSemaphore(6)
        super().__init__(address, HttpHandler)


class HttpHandler(http.server.BaseHTTPRequestHandler):
    server_version = 'G03Connector'
    sys_version = ''

    def log_message(self, *_):
        pass  # Never log Authorization, paths, responses or document contents.

    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def reply(self, code, value):
        raw = encode(value)
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        try:
            auth = self.headers.get_all('Authorization') or []
            require(len(auth) == 1 and hmac.compare_digest(auth[0].encode(), ('Bearer ' + self.server.token).encode()), 'UNAUTHORIZED')
            require(self.path in ('/v1/poll', '/v1/result'), 'NOT_FOUND')
            lengths = self.headers.get_all('Content-Length') or []
            require(len(lengths) == 1 and lengths[0].isdigit() and not self.headers.get('Transfer-Encoding'))
            size = int(lengths[0]); require(0 < size <= (4096 if self.path == '/v1/poll' else MAX_BODY))
            require(self.headers.get('Content-Type', '').split(';')[0] == 'application/json')
            raw = self.rfile.read(size); require(len(raw) == size)
            value = decode(raw)
            if self.path == '/v1/poll':
                require(isinstance(value, dict))
                protocol = value.get('schemaVersion')
                require(type(protocol) is int and protocol in (1, 2))
                poll_id = value.get('pollId')
                probe = value.get('probe', False)
                require(type(probe) is bool and (not probe or protocol == 2))
                if protocol == 2:
                    require(isinstance(poll_id, str) and re.fullmatch(r'[a-f0-9]{32}', poll_id))
                require(value == {'schemaVersion': protocol, 'installationId': self.server.relay.config['installationId'],
                    'connectionId': 'g03', 'policyHash': self.server.relay.policy,
                    **({'pollId': poll_id} if protocol == 2 else {}), **({'probe': True} if probe else {})})
                # A setup probe cannot consume an employee's queued operation.
                reply = {'job': None if probe else self.server.relay.poll(protocol, poll_id)}
                if protocol == 2:
                    reply.update(schemaVersion=2, pollId=poll_id)
                if probe:
                    reply['probe'] = True
                self.reply(200, reply)
            else:
                self.server.relay.submit(value)
                self.reply(200, {'accepted': True})
        except Exception as error:
            try:
                self.reply(401 if str(error) == 'UNAUTHORIZED' else 400, {'error': 'REQUEST_REJECTED'})
            except OSError:
                pass


class UnixServer(BoundedThreads, socketserver.UnixStreamServer):
    def __init__(self, address, relay, allow_writes=False):
        self.relay = relay
        self.allow_writes = allow_writes
        self.slots = threading.BoundedSemaphore(4)
        super().__init__(str(address), UnixHandler)

    def verify_request(self, request, _):
        # Fail closed outside Linux in production; tests use Relay directly.
        if sys.platform != 'linux':
            return False
        _, uid, _ = struct.unpack('3i', request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return uid == self.relay.config['appUid']


class UnixHandler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(100)
        try:
            maximum = MAX_BODY if self.server.allow_writes else 8192
            raw = self.rfile.readline(maximum + 1)
            require(len(raw) <= maximum and raw.endswith(b'\n'))
            request = decode(raw)
            response = self.server.relay.request(request, self.server.allow_writes)
            result = encode({**response, 'requestId': request['requestId'],
                'installationId': self.server.relay.config['installationId'], 'connectionId': 'g03'})
            maximum_reply = MAX_BODY if request.get('operation') == 'read' and request.get('input', {}).get('format') == 'original' else MAX_REPLY
            require(len(result) <= maximum_reply)
            self.wfile.write(result + b'\n')
        except Exception:
            pass


class ConnectionLease:
    """Kernel-held lease survives process crashes without a stale PID decision.

    The lock inode is never removed. Only exact, owner-controlled transport
    endpoints in the root-owned directory can be recovered under this lease.
    """
    def __init__(self, directory, descriptor_value, uid, gid):
        self.directory, self.value, self.uid, self.gid = directory, descriptor_value, uid, gid
        self.fd = os.open(directory / '.g03-relay.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(self.fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == uid
                    and not info.st_mode & 0o077, 'UNSAFE_CONNECTION_LEASE')
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError('CONNECTION_ALREADY_RUNNING') from None
            self._recover()
        except BaseException:
            os.close(self.fd)
            raise

    def _recover(self):
        stale = []
        for name in ('g03.json', 'g03.sock', 'g03-publish.sock', '.g03-descriptor.pending'):
            candidate = self.directory / name
            try:
                info = candidate.lstat()
            except FileNotFoundError:
                continue
            require(info.st_uid == self.uid and info.st_gid == self.gid and info.st_nlink == 1
                    and not info.st_mode & 0o007, 'UNSAFE_EXISTING_CONNECTION')
            if name in ('g03.json', '.g03-descriptor.pending'):
                require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o022 and info.st_size <= 8192,
                        'UNSAFE_EXISTING_CONNECTION')
                if name == 'g03.json':
                    require(decode(candidate.read_bytes()) == self.value, 'EXISTING_CONNECTION_MISMATCH')
            else:
                require(stat.S_ISSOCK(info.st_mode), 'UNSAFE_EXISTING_CONNECTION')
                probe = socket.socket(socket.AF_UNIX)
                probe.settimeout(.25)
                try:
                    probe.connect(str(candidate))
                except ConnectionRefusedError:
                    pass
                else:
                    raise ValueError('CONNECTION_ALREADY_RUNNING')
                finally:
                    probe.close()
            stale.append(candidate)
        # Validate the entire set before removing any of our ephemeral endpoints.
        for candidate in stale:
            candidate.unlink()

    def close(self):
        os.close(self.fd)

    def publish_descriptor(self):
        # The final descriptor is always a complete fsynced JSON document. A
        # crash before rename leaves only our reserved private pending file,
        # recoverable under the same kernel lease on the next startup.
        pending = self.directory / '.g03-descriptor.pending'
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
        with os.fdopen(fd, 'wb') as stream:
            os.fchown(stream.fileno(), self.uid, self.gid)
            os.fchmod(stream.fileno(), 0o640)
            stream.write(encode(self.value)); stream.flush(); os.fsync(stream.fileno())
        os.replace(pending, self.directory / 'g03.json')
        parent = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    config = validate_config(decode(private_file(args.config)))
    token = private_file(Path(config['tokenFile']), 1024).decode('ascii').strip()
    require(re.fullmatch(r'[A-Za-z0-9_-]{43,128}', token), 'INVALID_TOKEN')
    private_file(Path(config['extractorFile']), 256 * 1024, executable=True)
    directory = Path(config['socketDirectory'])
    info = directory.lstat()
    require(directory.resolve() == directory and stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
            info.st_gid == config['appGid'] and not info.st_mode & 0o027, 'UNSAFE_SOCKET_DIRECTORY')
    check_runtime_dependencies(config)
    if args.check:
        print(encode({'valid': True, 'installationId': config['installationId'], 'policyHash': policy_hash(config)}).decode())
        return
    require(sys.platform == 'linux' and os.geteuid() == 0, 'LINUX_OPERATOR_SERVICE_REQUIRED')
    relay = Relay(config)
    descriptor = directory / 'g03.json'
    sock = directory / 'g03.sock'
    # G03 employee navigation enters approved folders directly: the virtual parent
    # M:\G03 may be unlistable and is not an employee grant.
    canonical_entries = [
        ('Compartida', r'C:\Compartida'), ('G03-JKV', r'M:\G03-JKV'),
        ('Administració', r'M:\G03\ADMINISTRACIO'), ('G03', r'M:\G03\G03'),
        ('Plànols', r'M:\G03\PLANOLS'), ('Projectes', r'M:\G03\PROJECTES'),
        ('Qualitat', r'M:\G03\QUALITAT'),
    ]
    configured_roots = {ntpath.normcase(ntpath.normpath(r)) for r in config['roots']}
    entries = [{'label': label, 'path': reference('g03', p)} for label, p in canonical_entries
               if ntpath.normcase(ntpath.normpath(p)) in configured_roots]
    require(len(entries) <= 8, 'NAVIGATION_LIMIT')
    descriptor_value = {'schemaVersion': 1, 'installationId': config['installationId'], 'connectionId': 'g03',
                        'scope': 'company', 'mode': 'read-only', 'entryPoints': entries}
    lease = ConnectionLease(directory, descriptor_value, 0, config['appGid'])
    unix = UnixServer(sock, relay)
    os.chown(sock, 0, config['appGid']); os.chmod(sock, 0o660)
    http = HttpServer(('127.0.0.1', config['httpPort']), relay, token)
    publish = None
    publish_sock = directory / 'g03-publish.sock'
    if config['writesEnabled']:
        require(not publish_sock.exists() and not publish_sock.is_symlink(), 'EXISTING_PUBLISHER')
        publish = UnixServer(publish_sock, relay, allow_writes=True)
        os.chown(publish_sock, 0, config['appGid']); os.chmod(publish_sock, 0o660)
    lease.publish_descriptor()
    servers = [unix, http] + ([publish] if publish else [])
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    import signal
    done = [False]
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: done.__setitem__(0, True))
    try:
        # Never take a threading.Event condition lock from a signal handler.
        while not done[0]:
            time.sleep(0.1)
    finally:
        relay.stop()
        for server in reversed(servers):
            server.shutdown(); server.server_close()
        descriptor.unlink(); sock.unlink()
        if publish:
            publish_sock.unlink()
        lease.close()


if __name__ == '__main__':
    main()
