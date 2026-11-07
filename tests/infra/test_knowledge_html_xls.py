import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('extractor',Path(__file__).resolve().parents[2]/'infra/hetzner/knowledge-extract.py')
extractor=importlib.util.module_from_spec(spec);spec.loader.exec_module(extractor)


class HtmlSpreadsheetTests(unittest.TestCase):
    def extract(self,text,encoding='utf-8'):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'input';source.write_bytes(text.encode(encoding))
            return extractor.extract(source,'.xls')

    def test_text_only_export_preserves_order_unicode_and_locators(self):
        result=self.extract('<html><body><h3>Resum fictici</h3><table><tr><td>Núria &amp; Pau</td><td>12,50</td></tr></table></body></html>')
        self.assertEqual(result['segments'],[
            {'locator':'html:block:1','content':'Resum fictici'},
            {'locator':'html:block:2','content':'Núria & Pau'},
            {'locator':'html:block:3','content':'12,50'}])
        self.assertEqual(result['tables'],[])
        self.assertIn('NUMERIC_TYPES_UNVERIFIED',result['warnings'][0]['code'])

    def test_script_styles_metadata_and_fallback_text_are_not_knowledge(self):
        result=self.extract('<html><head><title>Hidden</title><style>Hidden</style><script>Hidden</script></head><body><script>Hidden</script><noscript>Hidden</noscript><template>Hidden</template><p>Visible</p><iframe src="https://example.invalid/private"></iframe></body></html>')
        self.assertEqual([s['content'] for s in result['segments']],['Visible'])
        self.assertIn({'code':'HTML_EXTERNAL_DEPENDENCIES_NOT_FETCHED'},result['warnings'])

    def test_frameset_requires_external_data_and_is_not_indexed_as_complete(self):
        with self.assertRaisesRegex(ValueError,'HTML_EXTERNAL_DEPENDENCIES_UNAVAILABLE'):
            self.extract('<html><head><script>secret</script></head><frameset><frame src="sheet.htm"><noframes>Requires frames</noframes></frameset></html>')

    def test_malformed_layouts_do_not_invent_spreadsheet_coordinates(self):
        result=self.extract('<html><body>'+'<table><h3>Group</h3><tr><td>Value</td></tr>'*467+'</body></html>')
        self.assertEqual(len(result['segments']),934)
        self.assertEqual(result['tables'],[])

    def test_encoding_and_secret_boundaries(self):
        result=self.extract('<html><p>Informació €</p></html>','cp1252')
        self.assertEqual(result['segments'][0]['content'],'Informació €')
        self.assertIn({'code':'ASSUMED_WINDOWS_1252_ENCODING'},result['warnings'])
        with self.assertRaisesRegex(ValueError,'CREDENTIAL_SHAPED_CONTENT'):
            self.extract('<html><p>password=abcdefghijklmnopqrstuvwx</p></html>')
        with self.assertRaisesRegex(ValueError,'BINARY_CONTENT'):
            self.extract('<html><p>bad\x00data</p></html>')

    def test_limits_and_non_html_signature(self):
        with self.assertRaisesRegex(ValueError,'TEXT_TOO_LARGE'):
            self.extract('<html><p>'+'a'*(extractor.MAX_TEXT+1)+'</p></html>')
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'input';source.write_bytes(b'not html')
            self.assertIsNone(extractor.html_spreadsheet(source))


if __name__=='__main__':unittest.main()
