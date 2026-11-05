import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2] / "infra/hetzner"
spec = importlib.util.spec_from_file_location("extractor", ROOT / "knowledge-extract.py")
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


class KnowledgeExtractionTests(unittest.TestCase):
    def test_windows_text_encoding_is_explicit_and_binary_still_rejected(self):
        self.source.write_bytes("Información de catálogo".encode("cp1252"))
        result=extractor.extract(self.source,".txt")
        self.assertEqual(result["segments"][0]["content"],"Información de catálogo")
        self.assertEqual(result["warnings"],[{"code":"ASSUMED_WINDOWS_1252_ENCODING"}])
        self.source.write_bytes(b"\x00bad\xff")
        with self.assertRaisesRegex(ValueError,"BINARY_CONTENT"):
            extractor.extract(self.source,".txt")

    def test_utf16_and_semicolon_csv_preserve_values(self):
        self.source.write_bytes("Articulo;Importe\nEjemplo;12,50\n".encode("utf-16"))
        result=extractor.extract(self.source,".csv")
        self.assertEqual(result["tables"][0]["rows"][1],["Ejemplo","12,50"])

    def test_bomless_utf16_csv_preserves_cells_and_declares_encoding(self):
        for encoding in ('utf-16-le','utf-16-be'):
            with self.subTest(encoding=encoding):
                self.source.write_bytes('Artículo;Importe\nEjemplo;12,50\n'.encode(encoding))
                result=extractor.extract(self.source,'.csv')
                self.assertEqual(result['tables'][0]['rows'],[['Artículo','Importe'],['Ejemplo','12,50']])
                self.assertEqual(result['segments'][1]['locator'],'row:2')
                self.assertIn({'code':'ASSUMED_'+encoding.upper().replace('-','_')+'_WITHOUT_BOM_ENCODING'},result['warnings'])

    def test_bomless_unicode_does_not_relax_binary_or_secret_guards(self):
        for raw in (b'\x00\x00A\x00',b'\x01\x00A\x00',b'A\x00B'):
            self.source.write_bytes(raw)
            with self.assertRaisesRegex(ValueError,'BINARY_CONTENT'):
                extractor.extract(self.source,'.csv')
        self.source.write_bytes('password=abcdefghijklmnopqrstuvwx\n'.encode('utf-16-le'))
        with self.assertRaisesRegex(ValueError,'CREDENTIAL_SHAPED_CONTENT'):
            extractor.extract(self.source,'.txt')

    def test_ragged_semicolon_export_does_not_split_decimal_commas(self):
        self.source.write_bytes('Article;Import;Nota\nExemple;12,50;Text;\n'.encode('utf-16-le'))
        result=extractor.extract(self.source,'.csv')
        self.assertEqual(result['tables'][0]['rows'],[['Article','Import','Nota'],['Exemple','12,50','Text','']])
        self.assertIn({'code':'CSV_DELIMITER_INFERRED_FROM_ROWS','delimiter':';'},result['warnings'])
        self.assertIn({'code':'CSV_RAGGED_ROWS'},result['warnings'])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.source = Path(self.temp.name) / "input"

    def tearDown(self):
        self.temp.cleanup()

    def test_csv_preserves_quoted_cells_and_row_provenance(self):
        self.source.write_text('Cliente,Importe,Nota\nArnall,120.50,"Uno, dos"\n',encoding="utf-8")
        result = extractor.extract(self.source,".csv")
        self.assertEqual(result["tables"][0]["rows"][1],["Arnall","120.50","Uno, dos"])
        self.assertEqual(result["segments"][1]["locator"],"row:2")

    def test_docx_preserves_paragraph_and_table_structure(self):
        with zipfile.ZipFile(self.source,"w") as archive:
            archive.writestr("word/document.xml",'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Responsable de compras</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Departamento</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Operaciones</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
        result = extractor.extract(self.source,".docx")
        self.assertEqual(result["segments"][0]["locator"],"paragraph:1")
        self.assertEqual(result["tables"][0]["rows"],[["Departamento","Operaciones"]])

    def spreadsheet(self, target="worksheets/sheet1.xml", formula="SUM(A1:A2)"):
        with zipfile.ZipFile(self.source,"w") as archive:
            archive.writestr("xl/workbook.xml",'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Ventas" sheetId="1" r:id="rId1"/></sheets></workbook>')
            archive.writestr("xl/_rels/workbook.xml.rels",f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="{target}"/></Relationships>')
            archive.writestr("xl/worksheets/sheet1.xml",f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>12.50</v></c><c r="B1"><f>{formula}</f><v>25</v></c></row></sheetData></worksheet>')

    def test_xlsx_preserves_named_sheet_cells_and_cached_formula_values(self):
        self.spreadsheet()
        result = extractor.extract(self.source,".xlsx")
        self.assertEqual(result["segments"][1],{"locator":"sheet:Ventas!B1","content":"25"})
        cell = result["tables"][0]["cells"][1]
        self.assertEqual(cell["formula"],"SUM(A1:A2)")
        self.assertEqual(cell["value"],"25")
        self.assertIn("NOT_RECALCULATED",result["warnings"][0]["code"])

    def test_xlsx_rejects_external_or_traversal_relationships(self):
        self.spreadsheet(target="../../etc/passwd")
        with self.assertRaisesRegex(ValueError,"INVALID_SHEET_TARGET"):
            extractor.extract(self.source,".xlsx")

    def test_xml_entities_rejected(self):
        with zipfile.ZipFile(self.source,"w") as archive:
            archive.writestr("word/document.xml",'<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><x>&secret;</x>')
        with self.assertRaisesRegex(ValueError,"XML_ENTITY_REJECTED"):
            extractor.extract(self.source,".docx")

    def test_pdf_page_boundaries_and_ocr_are_explicit(self):
        self.source.write_bytes(b"test PDF fixture; commands simulated")
        commands = []
        def run(args,**kwargs):
            commands.append(args)
            if args[0].endswith("pdftotext"):
                Path(args[-1]).write_text("Texto página uno\f\f",encoding="utf-8")
            elif args[0].endswith("pdftoppm"):
                Path(args[-1]+".png").write_bytes(b"image")
            else:
                Path(args[2]+".txt").write_text("Página escaneada",encoding="utf-8")
        result = extractor.extract(self.source,".pdf",run=run)
        self.assertEqual([s["locator"] for s in result["segments"]],["page:1","page:2"])
        self.assertEqual(result["warnings"][0]["code"],"OCR_TEXT_REQUIRES_VERIFICATION")
        self.assertIn("spa+cat+eng",commands[-1])

    def test_secret_content_and_oversized_input_rejected(self):
        self.source.write_text("password=abcdefghijklmnopqrstuvwx")
        with self.assertRaisesRegex(ValueError,"CREDENTIAL_SHAPED_CONTENT"):
            extractor.extract(self.source,".txt")
        with self.source.open("wb") as source:
            source.truncate(17*1024*1024)
        with self.assertRaisesRegex(ValueError,"FORMAT_OR_SIZE_REJECTED"):
            extractor.extract(self.source,".txt")


if __name__ == "__main__":
    unittest.main()
