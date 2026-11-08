import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import Mock

ROOT=Path(__file__).resolve().parents[2]/'infra/hetzner'
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
extractor=load('image_extractor','knowledge-extract.py')
acceptance=load('image_acceptance','knowledge-image-acceptance.py')


class ImageTests(unittest.TestCase):
    def source(self,folder,suffix,width=100,height=50):
        path=Path(folder)/('test'+suffix)
        if suffix=='.png':raw=b'\x89PNG\r\n\x1a\n'+b'\x00\x00\x00\rIHDR'+struct.pack('>II',width,height)
        elif suffix=='.bmp':raw=b'BM'+b'\0'*12+struct.pack('<Iii',40,width,height)+b'\0'*28
        else:raw=b'\xff\xd8\xff\xc0'+struct.pack('>HBHHB',8,8,height,width,1)
        path.write_bytes(raw);return path

    def test_raster_formats_have_source_locators_and_ocr_limitations(self):
        for suffix in extractor.IMAGE_FORMATS:
            with tempfile.TemporaryDirectory() as temporary:
                source=self.source(temporary,suffix)
                def run(command,timeout):
                    self.assertEqual(command[0],'/usr/bin/tesseract');self.assertEqual(timeout,45)
                    Path(command[2]+'.txt').write_text('Texto ficticio reconocido.')
                result=extractor.extract(source,suffix,run=run)
                self.assertEqual(result['segments'],[{'locator':'image:1','content':'Texto ficticio reconocido.'}])
                self.assertEqual(result['tables'],[])
                self.assertEqual(len(result['warnings']),2)

    def test_disguised_file_and_truncated_headers_never_start_decoder(self):
        with tempfile.TemporaryDirectory() as temporary:
            for suffix in extractor.IMAGE_FORMATS:
                path=Path(temporary)/('file'+suffix);path.write_text('/another/source/file.png')
                run=Mock()
                with self.assertRaisesRegex(ValueError,'IMAGE_SIGNATURE_REQUIRED'):extractor.extract(path,suffix,run=run)
                run.assert_not_called()
            path.write_bytes(b'\xff\xd8\xff')
            with self.assertRaisesRegex(ValueError,'IMAGE_SIGNATURE_REQUIRED'):extractor.image_dimensions(path,'.jpg')

    def test_decoded_pixel_budget_precedes_native_decoder(self):
        with tempfile.TemporaryDirectory() as temporary:
            for suffix in extractor.IMAGE_FORMATS:
                source=self.source(temporary,suffix,10000,10000);run=Mock()
                with self.assertRaisesRegex(ValueError,'OCR_PIXEL_LIMIT'):extractor.extract(source,suffix,run=run)
                run.assert_not_called()

    def test_ocr_secret_or_blank_text_is_not_indexable(self):
        with tempfile.TemporaryDirectory() as temporary:
            source=self.source(temporary,'.png')
            for content,code in [('password=abcdefghijklmnopqrstuvwx','CREDENTIAL_SHAPED_CONTENT'),('','EMPTY_TEXT')]:
                def run(command,timeout):Path(command[2]+'.txt').write_text(content)
                with self.assertRaisesRegex(ValueError,code):extractor.extract(source,'.png',run=run)

    @unittest.skipUnless(Path('/usr/bin/pdftoppm').is_file() and Path('/usr/bin/tesseract').is_file(),'Native Linux raster/OCR tools required')
    def test_real_native_ocr_on_generated_png_jpeg_bmp(self):
        self.assertEqual(len(acceptance.verify(extractor.extract)),4)


if __name__=='__main__':unittest.main()
