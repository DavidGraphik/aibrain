import importlib.util
import json
import pathlib
import unittest
from email.message import Message
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('g03_source_host', pathlib.Path(__file__).with_name('production-source-sync-host.py'))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class Response:
    status = 200

    def __init__(self, data=b'PK\x03\x04data', mime=host.MIME, length=None):
        self.data = data
        self.headers = Message()
        self.headers['Content-Type'] = mime
        if length is not None:
            self.headers['Content-Length'] = str(length)

    def read(self, limit):
        return self.data[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class SourceHostTests(unittest.TestCase):
    def test_redirects_only_allow_google_owned_sheet_exports(self):
        self.assertTrue(host.approved_url('https://docs.google.com/spreadsheets/d/SYNTHETIC/export'))
        self.assertTrue(host.approved_url('https://doc-08-3o-sheets.googleusercontent.com/export/x'))
        for url in ['http://docs.google.com/x', 'https://accounts.google.com/login', 'https://attacker.invalid/x', 'https://docs.google.com.attacker.invalid/x', 'https://user:secret@docs.google.com/x', 'https://127.0.0.1/x']:
            self.assertFalse(host.approved_url(url))

    def test_bounded_export_is_framed_for_the_exact_configured_sheet(self):
        with patch.object(host.urllib.request, 'build_opener') as build:
            build.return_value.open.return_value = Response()
            data = host.fetch_export('SYNTHETIC_SHEET_ID')
            header, workbook = data.split(b'\n', 1)
            self.assertEqual(json.loads(header)['fileId'], 'SYNTHETIC_SHEET_ID')
            self.assertEqual(workbook, b'PK\x03\x04data')
            self.assertEqual(build.return_value.open.call_args.args[0].full_url,
                             'https://docs.google.com/spreadsheets/d/SYNTHETIC_SHEET_ID/export?format=xlsx')

    def test_login_html_is_never_treated_as_workbook(self):
        with patch.object(host.urllib.request, 'build_opener') as build:
            build.return_value.open.return_value = Response(b'<html>Sign in</html>', 'text/html')
            with self.assertRaisesRegex(RuntimeError, 'CONNECTION_REQUIRED'):
                host.fetch_export('SYNTHETIC_SHEET_ID')

    def test_announced_and_actual_size_are_bounded(self):
        for response in [Response(length=host.MAX_BYTES + 1), Response(b'PK\x03\x04' + b'x' * host.MAX_BYTES)]:
            with patch.object(host.urllib.request, 'build_opener') as build:
                build.return_value.open.return_value = response
                with self.assertRaisesRegex(RuntimeError, 'DOWNLOAD_TOO_LARGE'):
                    host.fetch_export('SYNTHETIC_SHEET_ID')

    def test_file_ids_are_not_urls_or_arbitrary_query_components(self):
        for file_id in ['https://attacker.invalid', '../source', 'short', 'x?secret=one']:
            with self.assertRaisesRegex(RuntimeError, 'ID_INVALID'):
                host.fetch_export(file_id)


if __name__ == '__main__':
    unittest.main()
