import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('pptx_extractor', Path(__file__).parents[2] / 'infra/hetzner/rdp-extract.py')
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)

class PowerPointExtraction(unittest.TestCase):
    def fixture(self, target='slides/slide2.xml', mode='', slide_text='Segona al ZIP; primera al document'):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / 'company.pptx'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="r2"/><p:sldId r:id="r1"/></p:sldIdLst></p:presentation>')
            z.writestr('ppt/_rels/presentation.xml.rels', f'<Relationships><Relationship Id="r2" Target="{target}" {mode}/><Relationship Id="r1" Target="slides/slide1.xml"/></Relationships>')
            for number, text in [(1, 'Darrera diapositiva'), (2, slide_text)]:
                z.writestr(f'ppt/slides/slide{number}.xml', f'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:sld>')
        return path

    def test_uses_presentation_order_and_catalan_text(self):
        text = extractor.extract(self.fixture(), '.pptx')
        self.assertLess(text.index('Segona al ZIP'), text.index('Darrera diapositiva'))
        self.assertIn('Diapositiva 2', text)

    def test_external_slide_is_never_fetched(self):
        with self.assertRaisesRegex(ValueError, 'INVALID_SLIDE_TARGET'):
            extractor.extract(self.fixture(target='https://example.com/slide.xml', mode='TargetMode="External"'), '.pptx')

    def test_slide_traversal_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'INVALID_SLIDE_TARGET'):
            extractor.extract(self.fixture(target='../private.xml'), '.pptx')

    def test_entities_are_rejected(self):
        path = self.fixture()
        with zipfile.ZipFile(path, 'a') as z:
            z.writestr('ppt/slides/slide2.xml', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x/>')
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_ARCHIVE_MEMBER'):
            extractor.extract(path, '.pptx')

if __name__ == '__main__':
    unittest.main()
