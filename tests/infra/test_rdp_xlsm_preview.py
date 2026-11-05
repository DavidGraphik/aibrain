"""CI-discovered macro-enabled fixtures: only OOXML data is read; no macro runner exists."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

INFRA = Path(__file__).resolve().parents[2] / "infra/hetzner"
def module(name, file):
    spec = importlib.util.spec_from_file_location(name, INFRA / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result
extract = module("preview_extract", "rdp-extract.py")
server = module("preview_server", "rdp-server-files.py")
NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

def workbook(source, cells=None, external=False, date1904=False):
    if cells is None:
        cells = '<c r="A1" t="inlineStr"><is><t>Nom</t></is></c><c r="C3" s="1"><v>0.375</v></c><c r="D3"><f>UNKNOWN()</f></c><c r="E3"><f>1+1</f><v>2</v></c>'
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("xl/workbook.xml", f'<workbook xmlns="{NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="{int(date1904)}"/><sheets><sheet name="S’Agaró" sheetId="1" r:id="r1"/><sheet name="Torre" sheetId="2" r:id="r2" state="hidden"/></sheets></workbook>')
        target = 'TargetMode="External" Target="https://invalid.test/private.xml"' if external else 'Target="worksheets/sheet1.xml"'
        archive.writestr("xl/_rels/workbook.xml.rels", f'<Relationships><Relationship Id="r1" {target}/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>')
        archive.writestr("xl/styles.xml", f'<styleSheet xmlns="{NS}"><cellXfs><xf numFmtId="0"/><xf numFmtId="20"/><xf numFmtId="14"/></cellXfs></styleSheet>')
        archive.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="{NS}"><sheetData><row>{cells}</row></sheetData></worksheet>')
        archive.writestr("xl/worksheets/sheet2.xml", f'<worksheet xmlns="{NS}"><sheetData/></worksheet>')
        archive.writestr("xl/vbaProject.bin", b"TEST MACRO PAYLOAD MUST NEVER BE READ")

class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "horaris.xlsm"

    def test_xlsm_and_xlsx_read_values_names_sparse_coordinates_and_hours_without_macros(self):
        workbook(self.source)
        original = self.source.read_bytes()
        for suffix in [".xlsm", ".xlsx"]:
            preview = {}
            with patch.object(extract.subprocess, "run", side_effect=AssertionError("No external execution")):
                text = extract.extract(self.source, suffix, preview)
            self.assertIn("C3: 09:00", text)
            self.assertIn("Fórmula sin valor guardado", text)
            self.assertIn("E3: 2", text)
            self.assertEqual(preview["sheets"][0]["name"], "S’Agaró")
            self.assertTrue(preview["sheets"][1]["hidden"])
            self.assertFalse(preview["truncated"])
            self.assertNotIn("PAYLOAD", text)
            self.assertEqual(self.source.read_bytes(), original)

    def test_dates_respect_workbook_epoch(self):
        for epoch, expected in [(False, "1900-01-01"), (True, "1904-01-02")]:
            workbook(self.source, '<c r="A1" s="2"><v>1</v></c>', date1904=epoch)
            self.assertIn(expected, extract.extract(self.source, ".xlsm"))

    def test_preview_is_bounded_but_text_remains_readable(self):
        workbook(self.source, ''.join(f'<c r="A{i}" t="inlineStr"><is><t>{"x"*100}</t></is></c>' for i in range(1, 1001)))
        preview = {}
        text = extract.extract(self.source, ".xlsm", preview)
        self.assertTrue(preview["truncated"])
        self.assertLess(len(json.dumps(preview).encode()), 80000)
        self.assertIn("A1000:", text)

    def test_style_only_cells_do_not_reject_a_realistic_large_workbook(self):
        workbook(self.source, ''.join(f'<c r="A{i}" s="0"/>' for i in range(1, 100002)) +
                 '<c r="B1" t="inlineStr"><is><t>Horari</t></is></c>')
        preview = {}
        text = extract.extract(self.source, ".xlsm", preview)
        self.assertIn("B1: Horari", text)
        self.assertEqual(preview["sheets"][0]["cells"], [{"address": "B1", "value": "Horari"}])

    def test_hidden_template_cannot_starve_visible_sheets(self):
        workbook(self.source, ''.join(f'<c r="A{i}" t="inlineStr"><is><t>{"x"*100}</t></is></c>' for i in range(1, 1001)))
        with zipfile.ZipFile(self.source) as archive:
            entries = {item.filename: archive.read(item) for item in archive.infolist()}
        entries['xl/workbook.xml'] = entries['xl/workbook.xml'].replace(b'r:id="r1"', b'r:id="r1" state="hidden"').replace(b'r:id="r2" state="hidden"', b'r:id="r2"')
        entries['xl/worksheets/sheet2.xml'] = f'<worksheet xmlns="{NS}"><sheetData><row><c r="A1" t="inlineStr"><is><t>Actual</t></is></c></row></sheetData></worksheet>'.encode()
        with zipfile.ZipFile(self.source, 'w') as archive:
            for name, data in entries.items(): archive.writestr(name, data)
        preview = {}
        extract.extract(self.source, '.xlsm', preview)
        self.assertTrue(preview['truncated'])
        self.assertEqual(preview['sheets'][1]['cells'], [{'address': 'A1', 'value': 'Actual'}])

    def test_external_sheet_relationship_and_credentials_are_rejected(self):
        workbook(self.source, external=True)
        with self.assertRaisesRegex(ValueError, "INVALID_SHEET_TARGET"):
            extract.extract(self.source, ".xlsm")
        workbook(self.source, '<c r="A1" t="inlineStr"><is><t>password=abcdefghijklmnopqrstuv</t></is></c>')
        with self.assertRaisesRegex(ValueError, "CREDENTIAL_SHAPED_CONTENT"):
            extract.extract(self.source, ".xlsm")

    def test_server_first_part_carries_preview_and_verified_provenance(self):
        workbook(self.source)
        digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        manifest = {"connectionId": "arnall", "sourceRoots": ["Y:\\"], "importsRoot": self.root, "maxFileBytes": 16000000}
        receipt = {"destination": str(self.source), "sha256": digest, "verifiedSha256": digest,
                   "bytes": self.source.stat().st_size, "recordedAt": "2026-09-03T12:00:00Z", "modifiedUtc": "2026-09-03T10:00:00Z"}
        def read(source, suffix):
            preview = {}
            text = extract.extract(source, suffix, preview)
            return {"ok": True, "text": text, "preview": preview}
        result = server.read(manifest, "server-arnall/Y/horaris.xlsm", lambda *a, **kw: receipt, read)
        self.assertEqual(result["sha256"], digest)
        self.assertEqual(result["preview"]["sheets"][0]["cells"][1], {"address": "C3", "value": "09:00"})

if __name__ == "__main__":
    unittest.main()
