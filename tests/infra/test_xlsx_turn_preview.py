"""Synthetic generated-book previews: later sheets must retain an honest bounded view."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from xml.sax.saxutils import escape
from zipfile import ZipFile

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/xlsx-turn-text.py"
spec = importlib.util.spec_from_file_location("xlsx_turn_preview", SCRIPT)
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)
NS = extract.MAIN


def workbook(path, sheets):
    with ZipFile(path, "w") as archive:
        names = ''.join(f'<sheet name="{name}" sheetId="{i}" r:id="r{i}" state="{state}"/>'
                        for i, (name, state, _) in enumerate(sheets, 1))
        archive.writestr("xl/workbook.xml", f'<workbook xmlns="{NS}" xmlns:r="{extract.REL}"><sheets>{names}</sheets></workbook>')
        rels = ''.join(f'<Relationship Id="r{i}" Type="{extract.REL}/worksheet" Target="worksheets/sheet{i}.xml"/>'
                       for i in range(1, len(sheets) + 1))
        archive.writestr("xl/_rels/workbook.xml.rels", f'<Relationships xmlns="{extract.PACKAGE_REL}">{rels}</Relationships>')
        for i, (_, _, cells) in enumerate(sheets, 1):
            rows = ''.join(f'<row r="{extract.CELL_REF.match(address).group(2)}"><c r="{address}" t="inlineStr"><is><t>{escape(value)}</t></is></c></row>'
                           for address, value in cells)
            archive.writestr(f"xl/worksheets/sheet{i}.xml", f'<worksheet xmlns="{NS}"><sheetData>{rows}</sheetData></worksheet>')


class WorkbookPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "synthetic.xlsx"

    def preview(self, sheets):
        workbook(self.path, sheets)
        with ZipFile(self.path) as archive:
            result = extract.workbook_preview(archive)
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode()), 60000)
        return result

    def test_large_first_sheet_cannot_consume_later_summary(self):
        large = [(f"A{i}", "é" * 100) for i in range(1, 1500)]
        summary = [("A1", "Summary"), ("B35", "All sources recorded")]
        result = self.preview([("Large", "visible", large), ("Summary", "visible", summary)])
        self.assertEqual(result["sheets"][1]["cells"], [{"address": a, "value": v} for a, v in summary])
        self.assertTrue(result["sheets"][0]["truncated"])
        self.assertFalse(result["sheets"][1]["truncated"])
        self.assertTrue(result["truncated"])

    def test_hidden_template_and_long_first_cell_do_not_hide_sparse_values(self):
        result = self.preview([("Template", "hidden", [("A1", "x" * 70000), ("ZZ9999", "Sparse")]),
                               ("Current", "visible", [("B2", "Present")]), ("Empty", "visible", [])])
        self.assertEqual(result["sheets"][0]["cells"], [{"address": "ZZ9999", "value": "Sparse"}])
        self.assertTrue(result["sheets"][0]["hidden"])
        self.assertTrue(result["sheets"][0]["truncated"])
        self.assertFalse(result["sheets"][2]["truncated"])

    def test_per_sheet_cell_limit_keeps_later_sheet_and_marks_only_omitted_data(self):
        result = self.preview([("Many", "visible", [(f"A{i}", "x") for i in range(1, 2101)]),
                               ("Last", "visible", [("A1", "Last value")])])
        self.assertLessEqual(len(result["sheets"][0]["cells"]), 2000)
        self.assertTrue(result["sheets"][0]["truncated"])
        self.assertFalse(result["sheets"][1]["truncated"])
        self.assertEqual(result["sheets"][1]["cells"][0]["value"], "Last value")

    def test_hundred_unicode_sheet_names_remain_within_transport_limit(self):
        result = self.preview([("界" * 97 + str(i), "visible", [("A1", "界" * 1000)]) for i in range(100)])
        self.assertEqual(len(result["sheets"]), 100)
        self.assertTrue(result["truncated"])
        self.assertTrue(all(sheet["truncated"] or sheet["cells"] for sheet in result["sheets"]))

    def test_complete_books_stay_complete_and_turn_prompt_is_unchanged(self):
        sheets = [("Small", "visible", [("A1", "00123"), ("C7", "<script>never execute</script>")]),
                  ("Empty", "visible", [])]
        result = self.preview(sheets)
        self.assertFalse(result["truncated"])
        self.assertTrue(all(sheet["truncated"] is False for sheet in result["sheets"]))
        with ZipFile(self.path) as archive:
            text = extract.workbook_text(archive)
        self.assertEqual(text, 'SHEET,Small,visible\nROW,A,B,C\n1,00123,,\n7,,,<script>never execute</script>\n\nSHEET,Empty,visible\nROW,A\n\n')


if __name__ == "__main__":
    unittest.main()
