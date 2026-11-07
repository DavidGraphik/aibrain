#!/usr/bin/env python3
"""Root-owned fixed public source fetch -> the current immutable G03 app operator.

No login/cookies, no sharing changes, no customer/operator credentials. Read the
same reviewed, private source config as the application. Never accepts a URL.
"""
import datetime
import json
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 10 * 1024 * 1024
CONFIG = pathlib.Path('/var/lib/docker/volumes/aibrain-g03-production-data/_data/g03-products/source-sync/config.json')
MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


def approved_url(value):
    url = urllib.parse.urlsplit(value)
    return (url.scheme == 'https' and not url.username and not url.password and not url.port
            and (url.hostname == 'docs.google.com'
                 or re.fullmatch(r'doc-[a-z0-9-]+-sheets\.googleusercontent\.com', url.hostname or '')))


class GoogleRedirects(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        self.redirects = 0

    def redirect_request(self, request, response, code, message, headers, new_url):
        self.redirects += 1
        if self.redirects > 4 or not approved_url(new_url):
            raise RuntimeError('G03_SOURCE_REDIRECT_DENIED')
        return super().redirect_request(request, response, code, message, headers, new_url)


def fetch_export(file_id):
    if not isinstance(file_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{10,150}', file_id):
        raise RuntimeError('G03_SOURCE_ID_INVALID')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), GoogleRedirects())
    url = f'https://docs.google.com/spreadsheets/d/{file_id}/export?format=xlsx'
    request = urllib.request.Request(url, headers={'Accept': MIME})
    with opener.open(request, timeout=30) as response:
        if response.status != 200 or response.headers.get_content_type() != MIME:
            raise RuntimeError('G03_SOURCE_CONNECTION_REQUIRED')
        announced = response.headers.get('Content-Length')
        if announced and (not announced.isdigit() or int(announced) > MAX_BYTES):
            raise RuntimeError('G03_SOURCE_DOWNLOAD_TOO_LARGE')
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise RuntimeError('G03_SOURCE_DOWNLOAD_TOO_LARGE')
        if not data.startswith(b'PK\x03\x04'):
            raise RuntimeError('G03_SOURCE_WORKBOOK_INVALID')
    header = {'schemaVersion': 1, 'fileId': file_id,
              'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    return json.dumps(header, separators=(',', ':')).encode() + b'\n' + data


def main():
    metadata = CONFIG.lstat()
    if CONFIG.is_symlink() or not CONFIG.is_file() or metadata.st_nlink != 1 or metadata.st_mode & 0o077 or metadata.st_size > 65536:
        raise RuntimeError('G03_SOURCE_CONFIG_INVALID')
    config = json.loads(CONFIG.read_text())
    if config.get('installationId') != 'g03-production':
        raise RuntimeError('G03_SOURCE_INSTALLATION_DENIED')
    try:
        exported = fetch_export(config.get('fileId'))
    except Exception as error:
        code = str(error) if str(error) in ['G03_SOURCE_CONNECTION_REQUIRED', 'G03_SOURCE_DOWNLOAD_TOO_LARGE', 'G03_SOURCE_REDIRECT_DENIED'] else 'G03_SOURCE_DOWNLOAD_FAILED'
        if isinstance(error, urllib.error.HTTPError) and error.code in [401, 403, 404]:
            code = 'G03_SOURCE_CONNECTION_REQUIRED'
        # Deliver failure through the same bound operator so stale "current"
        # status cannot survive a lost/privatized source or network failure.
        exported = json.dumps({'schemaVersion': 1, 'fileId': config.get('fileId'), 'errorCode': code,
                               'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}).encode() + b'\n'
    result = subprocess.run([
        '/usr/bin/docker', 'exec', '-i', '--user', 'aibrain',
        'aibrain-g03-production-app-1', '/usr/local/bin/node',
        '/usr/local/share/aibrain/g03-source-sync-operator.mjs', '--config',
        '/var/lib/aibrain/data/g03-products/source-sync/config.json', '--stdin-export',
    ], input=exported, timeout=180, check=False)
    return result.returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        code = str(error) if re.fullmatch(r'G03_SOURCE_[A-Z_]+', str(error)) else 'G03_SOURCE_HOST_REFRESH_FAILED'
        print(code, file=sys.stderr)
        sys.exit(1)
