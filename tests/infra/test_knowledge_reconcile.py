import base64
import datetime as dt
import importlib.util
from pathlib import Path
import tempfile
import unittest

INFRA=Path(__file__).resolve().parents[2]/'infra/hetzner'
def load(name):
    spec=importlib.util.spec_from_file_location(name,INFRA/(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
    return value

r=load('knowledge-reconcile')
retrieval=load('knowledge-retrieval')
COMPANY={'scope':'company','scopeId':None}


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name).resolve()
        self.store=r.catalogue.Catalogue(self.root/'operator','test','operator')
        self.source='Y:\\contract.txt'
        scan=self.store.start_scan(['Y:\\'])
        self.store.record_page(scan,'Y:\\',0,[{'source':self.source,'directory':False,'bytes':20,'modifiedUtc':'2026-09-02T00:00:00Z'}],None)
        self.store.finish_scan(scan)
        row=self.store.document(self.source)
        self.store.index_document(self.source,row['fingerprint'],'a'*64,[{'locator':'line:1','content':'Contrato aprobado de ejemplo'}])
        self.bindings={'schemaVersion':1,'installationId':'test','rules':[{'sourceRoot':'Y:\\','audience':COMPANY}]}
        r.publication.publish(self.root,'test',self.bindings,lambda _:None)
        self.reader=retrieval.Retrieval(self.root,'test','arnall',self.bindings,lambda a:a==COMPANY)
        self.path=self.reader.search(COMPANY,'contrato')['results'][0]['path']
        self.manifest={'installationId':'test','sourceRoots':['Y:\\']}

    def tearDown(self):
        self.store.close();self.temp.cleanup()

    def receipt(self,state='present',digest='a'*64):
        return {'source':self.source,'state':state,'bytes':20,'modifiedUtc':'2026-09-02T00:00:00Z','sha256':digest}

    def test_hash_change_with_same_metadata_invalidates_before_publication(self):
        self.store.record_source_check(self.store.document(self.source),self.receipt(digest='b'*64))
        self.assertEqual(self.store.document(self.source)['state'],'pending')
        self.assertEqual(self.store.search('contrato'),[])
        self.assertEqual(self.reader.search(COMPANY,'contrato')['results'],[])
        with self.assertRaisesRegex(ValueError,'SOURCE_VERSION_OR_CHECK_UNAVAILABLE'):
            self.reader.read(COMPANY,self.path)

    def test_confirmed_denial_or_missing_withdraws_but_outage_does_not(self):
        self.store.record_source_check(self.store.document(self.source),self.receipt('unavailable'))
        self.assertEqual(self.store.document(self.source)['state'],'indexed')
        self.assertTrue(self.reader.read(COMPANY,self.path)['available'])
        self.store.record_source_check(self.store.document(self.source),self.receipt('denied'))
        self.assertIsNone(self.store.document(self.source))
        self.assertEqual(self.reader.search(COMPANY,'contrato')['results'],[])
        expected=dict(self.store.db.execute('SELECT * FROM documents').fetchone())
        self.store.record_source_check(expected,self.receipt())
        self.assertEqual(self.store.document(self.source)['state'],'pending')
        self.store.record_source_check(self.store.document(self.source),self.receipt('missing'))
        self.assertEqual(self.store.db.execute('SELECT reason FROM documents').fetchone()[0],'SOURCE_DELETED')

    def test_expired_verification_hides_read_search_and_calculation_without_erasing_history(self):
        old=(dt.datetime.now(dt.timezone.utc)-dt.timedelta(days=2)).isoformat()
        with self.store.write():
            self.store.db.execute('UPDATE documents SET indexed_at=?',(old,))
        self.assertEqual(self.reader.search(COMPANY,'contrato')['freshnessOmitted'],1)
        with self.assertRaisesRegex(ValueError,'SOURCE_VERSION_OR_CHECK_UNAVAILABLE'):
            self.reader.read(COMPANY,self.path)
        with self.assertRaisesRegex(ValueError,'SOURCE_VERSION_OR_CHECK_UNAVAILABLE'):
            self.reader.calculate(COMPANY,self.path,0,{'rows':[1],'column':1},'sum','es')
        self.assertEqual(len(self.store.search('contrato')),1)
        self.store.record_source_check(self.store.document(self.source),self.receipt())
        self.assertTrue(self.reader.read(COMPANY,self.path)['available'])

    def test_busy_source_yields_and_policy_denial_stops_without_withdrawing(self):
        with self.store.write():
            self.store.db.execute("UPDATE documents SET indexed_at='2000-01-01T00:00:00Z'")
        def busy(*_): raise BlockingIOError()
        self.assertEqual(r.batch(self.store,self.manifest,self.bindings,check=busy)['paused'],'SOURCE_BUSY')
        def denied(*_): raise ValueError('RDP_DRIVE_REDIRECTION_DISABLED')
        with self.assertRaisesRegex(ValueError,'RDP_DRIVE_REDIRECTION_DISABLED'):
            r.batch(self.store,self.manifest,self.bindings,check=denied)
        self.assertEqual(self.store.document(self.source)['state'],'indexed')

    def test_stale_check_cannot_withdraw_a_newer_local_revision(self):
        expected=self.store.document(self.source)
        with self.store.write(): self.store.db.execute("UPDATE documents SET fingerprint='changed'")
        with self.assertRaisesRegex(ValueError,'SOURCE_VERSION_CHANGED'):
            self.store.record_source_check(expected,self.receipt('missing'))
        self.assertEqual(self.store.document(self.source)['state'],'indexed')

    def test_fixed_program_encodes_filename_and_performs_no_source_writes(self):
        command=r.source.command("Y:\\O'Brien invoice.txt",'Y:\\','a'*32,16*1024*1024)
        self.assertLessEqual(len(command),7800)
        script=base64.b64decode(command.split()[-1]).decode('utf-16le')
        self.assertNotIn("O'Brien",script)
        self.assertIn('[IO.FileAccess]::Read',script)
        self.assertNotIn('[IO.FileAccess]::Write',script)
        self.assertIn("$c=[IO.Path]::GetDirectoryName($p)",script)


if __name__=='__main__': unittest.main()
