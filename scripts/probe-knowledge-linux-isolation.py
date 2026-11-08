#!/usr/bin/env python3
"""Root-only Linux acceptance with fictional data and a loopback model fixture.

Run under the generation service's restrictions plus PrivateNetwork=yes. It
never reads existing authentication, company content or a real model endpoint.
"""
import argparse
import base64
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading


def probe(binary):
    if os.geteuid() != 0:
        raise ValueError('HOST_OPERATOR_REQUIRED')
    spec = importlib.util.spec_from_file_location('linux_probe_adapter', Path(__file__).resolve().parents[1] / 'infra/hetzner/knowledge-codex-adapter.py')
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    with tempfile.TemporaryDirectory(prefix='knowledge-isolation-') as temporary:
        catalog_path = Path(temporary) / 'models.json'
        catalog_path.write_text(json.dumps(adapter.settings.catalog()))
        with open(binary, 'rb') as executable, catalog_path.open('rb') as catalog:
            descriptors = (executable.fileno(), catalog.fileno())
            command = adapter.sandbox_command(*descriptors)
            boundary = command.index('/run/codex', command.index('--setenv') + 1)
            check = (
                "import os,pathlib; assert os.getuid()==65534; "
                "assert not pathlib.Path('/var/lib/aibrain').exists(); "
                "assert not pathlib.Path('/home').exists(); "
                "assert not pathlib.Path('/run/docker.sock').exists(); "
                "assert [p.name for p in pathlib.Path('/proc').iterdir()]==['self']; "
                "assert os.readlink('/proc/self/exe')=='/run/codex'; "
                "pathlib.Path('/run/home/check').write_text('fictional'); "
                "assert not os.environ.get('OPENAI_API_KEY'); print('ISOLATED')"
            )
            result = subprocess.run(command[:boundary] + ['/usr/bin/python3', '-c', check],
                capture_output=True, timeout=15, pass_fds=descriptors)
            if result.returncode or result.stdout.strip() != b'ISOLATED':
                raise ValueError('LINUX_FILESYSTEM_ISOLATION_FAILED')
    expected = {'claims': [{'text': 'The fictional office opens Mondays.',
                           'citations': [{'unitId': 'u1', 'quote': 'Mondays'}]}]}
    captures = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass

        def do_POST(self):
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 1024 * 1024:
                self.send_error(400); return
            value = json.loads(self.rfile.read(size))
            captures.append(self.path == '/v1/responses' and value.get('tools') == []
                            and value.get('model') == adapter.settings.MODEL)
            events = [
                {'type': 'response.created', 'response': {'id': 'fixture-response'}},
                {'type': 'response.output_item.done', 'item': {'type': 'message', 'role': 'assistant', 'id': 'fixture-output',
                    'content': [{'type': 'output_text', 'text': json.dumps(expected)}]}},
                {'type': 'response.completed', 'response': {'id': 'fixture-response', 'usage': {
                    'input_tokens': 0, 'input_tokens_details': None, 'output_tokens': 0, 'output_tokens_details': None, 'total_tokens': 0}}}]
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            for event in events:
                self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
            self.wfile.flush()

    server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    original = adapter.settings.config

    def fixture_config(path):
        values = original(path)
        values['chatgpt_base_url'] = f'http://127.0.0.1:{server.server_port}'
        values['model_providers.knowledge_codex.base_url'] = f'http://127.0.0.1:{server.server_port}/v1'
        return values

    adapter.settings.config = fixture_config
    payload = base64.urlsafe_b64encode(json.dumps({'exp': 4102444800, 'email': 'fixture@example.invalid'}).encode()).decode().rstrip('=')
    login = {'type': 'chatgptAuthTokens', 'accessToken': 'e30.' + payload + '.fictional', 'chatgptAccountId': 'fixture-account'}
    try:
        result = adapter.CodexAdapter(binary, lambda: login).generate({
            'schemaVersion': 1, 'stage': 'part:p1', 'system': 'Summarize only this fictional data as JSON.',
            'data': {'units': [{'id': 'u1', 'text': 'The fictional office opens Mondays.'}]}, 'maxOutputBytes': 65536}, 'a' * 64, 90)
        if result != expected or captures != [True]:
            raise ValueError('LINUX_CODEX_PROTOCOL_FAILED')
        return {'filesystemIsolated': True, 'structuredFixtureAccepted': True,
                'modelRequests': 1, 'modelTools': 0, 'realCredentialsUsed': False, 'semanticAcceptance': False}
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex-bin', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(probe(args.codex_bin)))
    except Exception:
        print(json.dumps({'status': 'failed', 'error': 'LINUX_ISOLATION_PROBE_FAILED'}))
        raise SystemExit(1)
