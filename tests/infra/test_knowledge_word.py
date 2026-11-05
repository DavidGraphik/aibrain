import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('word',Path(__file__).resolve().parents[2]/'infra/hetzner/knowledge-extract.py')
extractor=importlib.util.module_from_spec(spec);spec.loader.exec_module(extractor)
FIXTURES=Path(__file__).with_name('fixtures')


class LegacyWordTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('catdoc'),'catdoc required for binary DOC acceptance')
    def test_real_doc_preserves_accents_and_text_locators(self):
        result=extractor.extract(FIXTURES/'knowledge-legacy.doc','.doc')
        text=' '.join(s['content'] for s in result['segments'])
        self.assertIn('Información de Núria',text)
        self.assertIn('Segunda línea',text)
        self.assertTrue(all(s['locator'].startswith('line:') for s in result['segments']))
        self.assertIn('NOT_RENDERED_PAGES',result['warnings'][0]['code'])

    @unittest.skipUnless(shutil.which('unrtf'),'unrtf required for RTF acceptance')
    def test_real_rtf_decodes_codepage_unicode_and_omits_converter_header(self):
        result=extractor.extract(FIXTURES/'knowledge-legacy.rtf','.rtf')
        self.assertEqual([s['content'] for s in result['segments']],
            ['Ejemplo ficticio: Información de Núria.','Segunda línea con € y 漢'])
        self.assertEqual(result['tables'],[])

    def test_rtf_table_keeps_row_and_cell_boundaries(self):
        parser=extractor.RtfHtml()
        parser.feed('<html><head><title>Not document content</title></head><body><p>Informe</p>'
            '<table><tr><td>Artículo</td><td>Importe</td></tr><tr><td>A&amp;B</td><td>12,50</td></tr></table></body></html>')
        parser.close();parser.flush()
        self.assertEqual(parser.tables,[{'locator':'table:1','rows':[['Artículo','Importe'],['A&B','12,50']]}])
        self.assertNotIn('Not document content',' '.join(parser.blocks))

    @unittest.skipUnless(shutil.which('unrtf'),'unrtf required for table conversion')
    def test_real_rtf_table_survives_conversion(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'table.rtf'
            source.write_text(r'{\rtf1\ansi\trowd\cellx2000\cellx4000\intbl Articulo\cell Importe\cell\row '
                r'\trowd\cellx2000\cellx4000\intbl Ejemplo\cell 12,50\cell\row}')
            result=extractor.extract(source,'.rtf')
            self.assertEqual(result['tables'][0]['rows'],[['Articulo','Importe'],['Ejemplo','12,50']])

    def test_rtf_unsafe_content_and_unsupported_nested_tables_fail(self):
        with self.assertRaisesRegex(ValueError,'CREDENTIAL_SHAPED_CONTENT'):
            p=extractor.RtfHtml();p.feed('<p>password=abcdefghijklmnopqrstuvwx</p>')
        with self.assertRaisesRegex(ValueError,'RTF_TABLE_STRUCTURE'):
            p=extractor.RtfHtml();p.feed('<table><tr><td><table>')

    def test_wrong_rtf_signature_never_starts_converter(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'fake.rtf';source.write_text('not rich text')
            with patch.object(extractor,'capture_text') as capture,self.assertRaisesRegex(ValueError,'RTF_SIGNATURE_REQUIRED'):
                extractor.extract(source,'.rtf')
            capture.assert_not_called()

    def test_secret_converter_output_never_becomes_indexable(self):
        with patch.object(extractor,'capture_text',return_value='password=abcdefghijklmnopqrstuvwx'):
            with self.assertRaisesRegex(ValueError,'CREDENTIAL_SHAPED_CONTENT'):
                extractor.extract(FIXTURES/'knowledge-legacy.doc','.doc')


if __name__=='__main__':unittest.main()
