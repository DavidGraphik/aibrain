"""No active macros: all carriers contain inert marker bytes and synthetic links."""
import importlib.util
import io
import struct
import unittest
from pathlib import Path
from unittest.mock import patch
import xlrd

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('passive_xls', ROOT / 'scripts/xls-passive-read.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def workbook(file):
    return xlrd.compdoc.CompDoc(file.read_bytes(), logfile=io.StringIO()).get_named_stream('Workbook')


def records(data):
    at = 0
    while at + 4 <= len(data):
        ident, size = struct.unpack_from('<HH', data, at)
        if ident == size == 0 and not any(data[at:]):
            return
        yield at, ident, size
        at += size + 4


def record(ident, body):
    return struct.pack('<HH', ident, len(body)) + body


def add_globals(data, extra):
    """Synthetic records only; move sheet offsets with the inserted globals."""
    data = bytearray(data)
    for at, ident, _ in records(data):
        if ident == 0x85:
            struct.pack_into('<I', data, at + 4, struct.unpack_from('<I', data, at + 4)[0] + len(extra))
        if ident == 0x0a:
            return data[:at] + extra + data[at:]
    raise AssertionError('no global EOF')


class PassiveXlsReadTests(unittest.TestCase):
    def test_varied_workbooks_have_useful_data_without_external_effects(self):
        fixtures = sorted((ROOT / 'tests/fixtures').glob('legacy-autofilter*.xls'))
        self.assertEqual(len(fixtures), 5)
        for file in fixtures:
            with self.subTest(file=file.name), patch('subprocess.Popen', side_effect=AssertionError('No subprocess')), patch('socket.socket', side_effect=AssertionError('No network')):
                result = reader.extract(workbook(file))
                self.assertGreater(result['cellCount'], 0)
                self.assertGreater(result['formulaCount'], 0)
                self.assertEqual(result['missingFormulaCaches'], result['formulaCount'])
                self.assertEqual(result['reader'], 'xlrd-2.0.2')
                self.assertEqual(result['undecodedFormulas'], 0)

    def test_inert_macro_carrier_and_hyperlink_are_not_output_or_executed(self):
        file = ROOT / 'tests/fixtures/legacy-passive-links-macros.xls'
        original = file.read_bytes()
        stream = workbook(file)
        self.assertNotIn(b'INERT_TEST_VBA_PAYLOAD', stream)
        with patch('subprocess.Popen', side_effect=AssertionError('No subprocess')), patch('socket.socket', side_effect=AssertionError('No network')):
            result = reader.extract(stream)
        self.assertGreater(result['cellCount'], 0)
        self.assertGreater(result['linkRecords'], 0)
        self.assertNotIn('do-not-open', repr(result))
        self.assertEqual(file.read_bytes(), original)

    def test_unicode_dates_booleans_errors_and_formula_cache_remain_distinct(self):
        result = reader.extract(workbook(ROOT / 'tests/infra/fixtures/knowledge-legacy.xls'))
        cells = {(r,c):(typ,value,formula) for r,c,typ,value,formula in result['sheets'][0]['cells']}
        self.assertEqual(cells[(0, 1)], ('number', 12.5, False))
        self.assertEqual(cells[(0, 2)][0], 'date')
        self.assertEqual(cells[(0, 3)], ('boolean', True, False))
        self.assertEqual(cells[(0, 4)][0], 'error')
        self.assertEqual(cells[(0, 5)], ('text', '#UNVERIFIED_FORMULA_NO_SAVED_VALUE', True))
        self.assertEqual(result['formulaCount'], 1)

    def test_encryption_truncation_and_inconsistent_lengths_fail_closed(self):
        source = workbook(ROOT / 'tests/fixtures/legacy-autofilter.xls')
        variants = [source[:15]]
        encrypted = bytearray(source)
        struct.pack_into('<H', encrypted, 20, 0x2f)
        variants.append(encrypted)
        length = bytearray(source)
        struct.pack_into('<H', length, 2, 0xffff)
        variants.append(length)
        for data in variants:
            with self.assertRaises(Exception): reader.extract(bytes(data))

    def test_cell_limit_is_enforced_without_returning_partial_data(self):
        with patch.object(reader, 'MAX_CELLS', 2):
            with self.assertRaises(ValueError): reader.extract(workbook(ROOT / 'tests/fixtures/legacy-autofilter.xls'))

    def test_saved_formula_number_is_reported_unverified_without_recalculation(self):
        data = bytearray(workbook(ROOT / 'tests/fixtures/legacy-autofilter.xls'))
        at = 0
        while at + 4 <= len(data):
            ident, size = struct.unpack_from('<HH', data, at)
            if ident == 6:
                struct.pack_into('<d', data, at + 4 + 6, 42.5)
                break
            at += size + 4
        else:
            self.fail('fixture has no formula')
        with patch('subprocess.Popen', side_effect=AssertionError('No subprocess')), patch('socket.socket', side_effect=AssertionError('No network')), patch('builtins.open', side_effect=AssertionError('No file access')):
            result = reader.extract(bytes(data))
        formula = result['sheets'][0]['formulas'][0]
        self.assertEqual(formula[3], 'unverified')
        cell = next(c for c in result['sheets'][0]['cells'] if c[:2] == formula[:2])
        self.assertEqual(cell[2:], ['number', 42.5, True])
        self.assertEqual(result['missingFormulaCaches'], 2)

    def test_macro_sheet_and_auto_open_name_are_omitted_without_running(self):
        data = bytearray(workbook(ROOT / 'tests/fixtures/legacy-autofilter-multi.xls'))
        bounds = [at for at, ident, _ in records(data) if ident == 0x85]
        self.assertEqual(len(bounds), 2)
        macro = struct.unpack_from('<I', data, bounds[1] + 4)[0]
        data[bounds[1] + 9] = 1  # Macro sheet, retaining fictional cell records.
        struct.pack_into('<H', data, macro + 6, 0x40)
        # Built-in Auto_Open macro name with a scalar constant, no commands/code.
        name = struct.pack('<HBBHHH4B', 0x28, 0, 1, 3, 0, 2, 0, 0, 0, 0) + b'\x00\x01\x1e\x01\x00'
        data = add_globals(data, record(0x18, name))
        with patch('subprocess.Popen', side_effect=AssertionError('No subprocess')), patch('socket.socket', side_effect=AssertionError('No network')), patch('builtins.open', side_effect=AssertionError('No file access')):
            result = reader.extract(bytes(data))
        self.assertEqual(result['omittedSheets'], 1)
        self.assertEqual(len(result['sheets']), 1)
        self.assertGreater(result['cellCount'], 0)
        self.assertNotIn('Auto_Open', repr(result))

    def test_external_and_dde_ole_metadata_never_fetches_saved_formula_values(self):
        def string(value):
            return struct.pack('<HB', len(value), 0) + value.encode('ascii')
        for sheet_count in (0, 1):
            with self.subTest(kind='dde-ole' if sheet_count == 0 else 'external-workbook'):
                data = bytearray(workbook(ROOT / 'tests/fixtures/legacy-autofilter.xls'))
                # A non-existent URL/item; no executable application or command.
                supbook = struct.pack('<H', sheet_count) + string('https://example.invalid/never-open')
                if sheet_count:
                    supbook += string('Fictional')
                externname = struct.pack('<HI', 0, 0) + b'\x04\x00Item'
                extra = record(0x1ae, supbook) + record(0x23, externname)
                if sheet_count:
                    extra += record(0x17, struct.pack('<HHHH', 1, 0, 0, 0))
                data = add_globals(data, extra)
                # External references are decoded to inert formula text; cached
                # numbers must stay unchanged even when the target is unavailable.
                for at, ident, size in records(data):
                    if ident == 6:
                        struct.pack_into('<d', data, at + 10, 42.5)
                        if sheet_count:
                            tokens = b'\x3a' + struct.pack('<HHH', 0, 0, 0)
                            body = data[at + 4:at + 26]
                            struct.pack_into('<H', body, 20, len(tokens))
                            data = data[:at] + record(6, body + tokens) + data[at + 4 + size:]
                        break
                with patch('subprocess.Popen', side_effect=AssertionError('No subprocess')), patch('socket.socket', side_effect=AssertionError('No network')), patch('builtins.open', side_effect=AssertionError('No file access')):
                    result = reader.extract(bytes(data))
                self.assertGreater(result['linkRecords'], 0)
                formula = result['sheets'][0]['formulas'][0]
                self.assertEqual(formula[3], 'unverified')
                cell = next(c for c in result['sheets'][0]['cells'] if c[:2] == formula[:2])
                self.assertEqual(cell[2:], ['number', 42.5, True])


if __name__ == '__main__':
    unittest.main()
