"""Synthetic workbook regression; no customer data, no macros executed."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest.mock import patch

import io
import contextlib
import sys

def archive(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as container:
        for name, value in files.items(): container.writestr(name, value)
    return output.getvalue()

EXTRACTOR = Path(__file__).with_name('g03-spreadsheet-paged.py')
spec = importlib.util.spec_from_file_location('g03_extractor', EXTRACTOR)
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


def workbook(last='D' * 600000):
    cells = ''.join(f'<c r="A{i}" t="inlineStr"><is><t>{v}</t></is></c>'
                    for i, v in enumerate(['A' * 600000, 'B' * 600000, 'C' * 600000, last], 1))
    return archive({
        'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Synthetic" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row>' + cells + '</row></sheetData></worksheet>',
        'xl/vbaProject.bin': b'INERT SYNTHETIC MACRO',
    })


class SpreadsheetPaginationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source = Path(self.directory.name) / 'synthetic.xlsm'
        self.source.write_bytes(workbook())

    def test_large_workbook_returns_exact_bounded_pages_and_full_sheet_preview(self):
        with self.assertRaisesRegex(ValueError, 'TEXT_TOO_LARGE'):
            extractor.extract_result(self.source, '.xlsm')  # old, unpaged contract
        full = extractor.extract(self.source, '.xlsm', text_limit=extractor.MAX_PAGED_SCAN_TEXT)
        self.assertGreater(len(full.encode()), extractor.MAX_TEXT)
        first = extractor.extract_result(self.source, '.xlsm', 1)
        second = extractor.extract_result(self.source, '.xlsm', 2)
        last = extractor.extract_result(self.source, '.xlsm', first['parts'])
        self.assertEqual(first['text'], full[:20000])
        self.assertEqual(second['text'], full[20000:40000])
        self.assertEqual(last['text'], full[(first['parts'] - 1) * 20000:])
        self.assertEqual([s['name'] for s in first['preview']['sheets']], ['Synthetic'])
        with self.assertRaisesRegex(ValueError, 'SERVER_PART_UNAVAILABLE'):
            extractor.extract_result(self.source, '.xlsm', first['parts'] + 1)

    def test_secret_late_in_book_rejects_even_first_page(self):
        self.source.write_bytes(workbook('D' * 500000 + ' sk-' + 'Z' * 24))
        with self.assertRaisesRegex(ValueError, 'CREDENTIAL_SHAPED_CONTENT'):
            extractor.extract_result(self.source, '.xlsm', 1)

    def test_scan_limit_is_enforced_and_invalid_parts_are_rejected(self):
        with patch.object(extractor, 'MAX_PAGED_SCAN_TEXT', 2100000):
            with self.assertRaisesRegex(ValueError, 'TEXT_TOO_LARGE'):
                extractor.extract_result(self.source, '.xlsm', 1)
        for part in (0, 1000, True):
            with self.subTest(part=part), self.assertRaisesRegex(ValueError, 'INVALID_PAGE'):
                extractor.extract_result(self.source, '.xlsm', part)

    def test_archive_and_xml_limits_still_apply_to_paged_reads(self):
        with patch.object(extractor, 'MAX_XML', 1000):
            with self.assertRaisesRegex(ValueError, 'XML_TOO_LARGE'):
                extractor.extract_result(self.source, '.xlsm', 1)
        self.source.write_bytes(archive({f'part-{i}': b'x' for i in range(5001)}))
        with zipfile.ZipFile(self.source) as container:
            with self.assertRaisesRegex(ValueError, 'ARCHIVE_TOO_LARGE'):
                extractor.validate_archive(container)

    def test_cli_retains_the_original_sandbox_resource_bounds(self):
        with patch.object(extractor.resource, 'setrlimit') as limits, \
             patch.object(extractor, 'extract_result', return_value={'ok': True, 'text': 'safe'}), \
             patch.object(extractor.Path, 'read_bytes', return_value=b'synthetic'), \
             patch.object(sys, 'argv', ['reader', '--format', '.xlsm', '--part', '1']), \
             contextlib.redirect_stdout(io.StringIO()):
            extractor.main()
        calls = {call.args[0]: call.args[1] for call in limits.call_args_list}
        self.assertEqual(calls[extractor.resource.RLIMIT_AS], (384 * 1024 * 1024,) * 2)
        self.assertEqual(calls[extractor.resource.RLIMIT_CPU], (25, 25))
        self.assertEqual(calls[extractor.resource.RLIMIT_FSIZE], (extractor.MAX_TEXT + 1,) * 2)
        self.assertEqual(calls[extractor.resource.RLIMIT_NOFILE], (64, 64))


if __name__ == '__main__':
    unittest.main()
