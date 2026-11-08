import importlib.util
import hashlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
def module(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'infra/hetzner'/('knowledge-'+name+'.py'))
    value=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

extractor=module('extract')
ingest=module('ingest')
insights=module('insights')
FIXTURE=Path(__file__).with_name('fixtures')/'knowledge-legacy.xls'
HAS_XLRD=importlib.util.find_spec('xlrd') is not None


@unittest.skipUnless(HAS_XLRD,'Install python3-xlrd / xlrd==2.0.2 to test real BIFF parsing')
class LegacySpreadsheetTests(unittest.TestCase):
    def test_real_biff_cells_types_unicode_and_warnings(self):
        result=extractor.extract(FIXTURE,'.xls')
        self.assertEqual(result['segments'][0],{'locator':'sheet:Operación!A1','content':'Proveedor ficticio'})
        self.assertIn({'locator':'sheet:Personas!A1','content':'Nombre de ejemplo: Núria'},result['segments'])
        sheet=result['tables'][0]
        cells={c['cell']:c for c in sheet['cells']}
        self.assertEqual(cells['B1']['value'],'12.5')
        self.assertEqual(cells['C1']['type'],'d')
        self.assertEqual(cells['C1']['value'],'46267.0')
        self.assertEqual(sheet['dateMode'],0)
        self.assertEqual(cells['D1']['type'],'b')
        self.assertEqual(cells['E1']['value'],'#DIV/0!')
        self.assertEqual(cells['G1']['value'],'0.0000001')
        self.assertFalse(sheet['formulaMetadataAvailable'])
        self.assertTrue(all(c['formula'] is None for c in cells.values()))
        self.assertIn('NOT_RECALCULATED',result['warnings'][0]['code'])

    def test_calculations_use_values_and_reject_dates_booleans_errors(self):
        payload=extractor.extract(FIXTURE,'.xls')
        store=SimpleNamespace(structured_document=lambda *_:payload)
        result=insights.calculate(store,'Y:\\Example.xls','a'*64,0,{'cells':['B1','B2']},'sum')
        self.assertEqual(result['result'],'19.75')
        self.assertEqual(result['citations'],['sheet:Operación!B1','sheet:Operación!B2'])
        self.assertEqual(result['sourceWarnings'],payload['warnings'])
        for address in ('C1','D1','E1','F1'):
            with self.subTest(address=address),self.assertRaisesRegex(ValueError,'NON_NUMERIC_XLSX_CELL'):
                insights.calculate(store,'Y:\\Example.xls','a'*64,0,{'cells':[address]},'sum')

    def test_real_secret_and_corrupt_workbooks_rejected(self):
        with self.assertRaisesRegex(ValueError,'CREDENTIAL_SHAPED_CONTENT'):
            extractor.extract(FIXTURE.with_name('knowledge-legacy-secret.xls'),'.xls')
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'bad.xls';source.write_bytes(b'not an Excel workbook')
            with self.assertRaisesRegex(ValueError,'XLS_INVALID_OR_ENCRYPTED'):
                extractor.extract(source,'.xls')

    def test_verified_legacy_copy_becomes_searchable_with_original_hash(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();imports=root/'imports';imports.mkdir(mode=0o700)
            source=imports/'original';source.write_bytes(FIXTURE.read_bytes());source.chmod(0o600)
            digest=hashlib.sha256(source.read_bytes()).hexdigest()
            store=ingest.catalogue.Catalogue(root/'store','test','operator')
            try:
                scan=store.start_scan(['Y:\\']);modified='2026-09-02T00:00:00Z'
                store.record_page(scan,'Y:\\',0,[{'source':'Y:\\Example.xls','directory':False,
                    'bytes':source.stat().st_size,'modifiedUtc':modified}],None)
                store.finish_scan(scan)
                receipt={'destination':str(source),'bytes':source.stat().st_size,'modifiedUtc':modified,
                    'sha256':digest,'verifiedSha256':digest}
                result=ingest.batch(store,root/'store',{'sourceRoots':['Y:\\'],'importsRoot':imports},
                    copy=lambda *_,**__:receipt,extract=extractor.extract)
                self.assertEqual(result['processed'],1)
                self.assertEqual(store.search('Proveedor')[0]['sha256'],digest)
                self.assertEqual(store.structured_document('Y:\\Example.xls',digest)['tables'][0]['dateMode'],0)
                self.assertEqual((root/'store/objects'/digest/'original').read_bytes(),FIXTURE.read_bytes())
            finally:
                store.close()

    def test_cell_budget_checked_before_iterating_oversized_sheet(self):
        sheet=SimpleNamespace(name='Example',nrows=100001,ncols=1)
        released=[]
        book=SimpleNamespace(nsheets=1,datemode=0,sheet_by_index=lambda _:sheet,release_resources=lambda:released.append(True))
        with patch('xlrd.open_workbook',return_value=book),self.assertRaisesRegex(ValueError,'CELL_LIMIT'):
            extractor.extract(FIXTURE,'.xls')
        self.assertEqual(released,[True])


class LegacyRequeueTests(unittest.TestCase):
    def test_requeue_preserves_denials_failures_oversized_and_other_formats(self):
        with tempfile.TemporaryDirectory() as folder:
            store=ingest.catalogue.Catalogue(Path(folder).resolve()/'store','test','operator')
            try:
                scan=store.start_scan(['Y:\\'])
                names=['good.xls','large.xls','denied.xls','failed.xls','other.doc','other-reason.xls']
                store.record_page(scan,'Y:\\',0,[{'source':'Y:\\'+name,'directory':False,
                    'bytes':17*1024**2 if name=='large.xls' else 50,'modifiedUtc':'2026-09-02T12:00:00Z'} for name in names],None)
                store.finish_scan(scan)
                with store.write():
                    store.db.execute("UPDATE documents SET state='unsupported',reason='FORMAT_OR_SIZE_UNSUPPORTED'")
                    store.db.execute("UPDATE documents SET state='withdrawn',reason='ACCESS_REVOKED' WHERE name='denied.xls'")
                    store.db.execute("UPDATE documents SET state='unreadable',reason='BINARY_CONTENT' WHERE name='failed.xls'")
                    store.db.execute("UPDATE documents SET reason='OTHER' WHERE name='other-reason.xls'")
                self.assertEqual(ingest.requeue_supported(store,['.xls']),1)
                self.assertEqual(ingest.requeue_supported(store,['.xls']),0)
                states=dict(store.db.execute('SELECT name,state FROM documents'))
                self.assertEqual(states,{'good.xls':'pending','large.xls':'unsupported','denied.xls':'withdrawn',
                    'failed.xls':'unreadable','other.doc':'unsupported','other-reason.xls':'unsupported'})
            finally:
                store.close()


if __name__=='__main__':unittest.main()
