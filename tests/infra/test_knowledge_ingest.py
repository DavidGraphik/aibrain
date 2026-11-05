import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ingest",Path(__file__).resolve().parents[2]/"infra/hetzner/knowledge-ingest.py")
ingest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ingest)


class IngestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()/"store"
        self.imports = self.root.parent/"imports"
        self.imports.mkdir(mode=0o700)
        self.payload = self.imports/"document"
        self.payload.write_bytes(b"verified source")
        self.payload.chmod(0o600)
        self.digest = hashlib.sha256(self.payload.read_bytes()).hexdigest()
        self.store = ingest.catalogue.Catalogue(self.root,"test","operator")
        scan = self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[{"source":"Y:\\report.txt","directory":False,"bytes":15,"modifiedUtc":"2026-09-02T12:00:00Z"}],None)
        self.store.finish_scan(scan)
        self.document = dict(self.store.db.execute("SELECT * FROM documents").fetchone())
        self.manifest = {"sourceRoots":["Y:\\"],"importsRoot":self.imports}

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def copy(self,*_,**__):
        return {"destination":str(self.payload),"verifiedSha256":self.digest,"sha256":self.digest,
                "bytes":15,"modifiedUtc":self.document["modified"]}

    def extract(self,*_):
        return {"ok":True,"segments":[{"locator":"line:1","content":"Contrato verificado"}],"tables":[],"warnings":[]}

    def test_verified_copy_saved_and_indexed_with_source_locator(self):
        result = ingest.batch(self.store,self.root,self.manifest,copy=self.copy,extract=self.extract)
        self.assertEqual(result["processed"],1)
        original = self.root/"objects"/self.digest/"original"
        self.assertEqual(original.read_bytes(),b"verified source")
        self.assertEqual(os.stat(original).st_mode&0o777,0o600)
        self.assertEqual(self.store.search("Contrato")[0]["sha256"],self.digest)

    def test_empty_and_office_lock_metadata_do_not_open_remote_sessions(self):
        with self.store.write():
            self.store.db.execute("UPDATE documents SET bytes=0")
        with patch.object(ingest.files.sync,'rdp_call',side_effect=AssertionError('unexpected copy')) as remote:
            result=ingest.batch(self.store,self.root,self.manifest,copy=remote)
        self.assertEqual(result['processed'],0)
        self.assertEqual(tuple(self.store.db.execute('SELECT state,reason FROM documents').fetchone()),('unsupported','EMPTY_FILE'))
        with self.store.write():
            self.store.db.execute("UPDATE documents SET state='pending',bytes=165,name='~$report.xlsx',suffix='.xlsx'")
        result=ingest.batch(self.store,self.root,self.manifest,copy=lambda *a,**k:self.fail('unexpected copy'))
        self.assertEqual(result['processed'],0)
        self.assertEqual(tuple(self.store.db.execute('SELECT state,reason FROM documents').fetchone()),('unsupported','OFFICE_LOCK_FILE'))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM documents').fetchone()[0],1)

    def test_changed_source_and_corrupt_transfer_never_index(self):
        def changed(*_,**__):
            return {**self.copy(),"modifiedUtc":"2026-09-03T12:00:00Z"}
        with self.assertRaisesRegex(ValueError,"SOURCE_CHANGED_DURING_COPY"):
            ingest.ingest_document(self.store,self.root,self.manifest,self.document,copy=changed,extract=self.extract)
        self.payload.write_bytes(b"corrupt bytes!!")
        with self.assertRaisesRegex(ValueError,"COPY_HASH_MISMATCH"):
            ingest.ingest_document(self.store,self.root,self.manifest,self.document,copy=self.copy,extract=self.extract)
        self.assertEqual(self.store.search("Contrato"),[])

    def test_table_locators_survive_small_chunk_batching(self):
        rows = [{"locator":f"sheet:Ventas!A{i}","content":str(i)} for i in range(1,10001)]
        chunks = ingest.chunks(rows)
        self.assertLess(len(chunks),100)
        self.assertIn("[sheet:Ventas!A9000] 9000","\n".join(c["content"] for c in chunks))
        self.assertTrue(all(len(c["content"].encode())<120*1024 for c in chunks))

    def test_extraction_failure_records_issue_without_searchable_content(self):
        result = ingest.batch(self.store,self.root,self.manifest,copy=self.copy,extract=lambda *_:{"ok":False,"reason":"EMPTY_TEXT"})
        self.assertEqual(result["errors"],["EMPTY_TEXT"])
        self.assertEqual(tuple(self.store.db.execute("SELECT state,reason FROM documents").fetchone()),("unreadable","EMPTY_TEXT"))
        self.assertEqual(self.store.db.execute("SELECT code FROM issues ORDER BY rowid DESC").fetchone()[0],"EMPTY_TEXT")
        self.assertEqual(self.store.search("Contrato"),[])

    def test_unknown_parser_messages_never_enter_issue_ledger(self):
        for reason in ("Confidential employee text", "UNKNOWN_DOCUMENT_TEXT", ["EMPTY_TEXT"], None):
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(ingest.ExtractionFailure,"^CONTENT_UNREADABLE$"):
                    ingest.require_extraction({"ok":False,"reason":reason})
        result=ingest.batch(self.store,self.root,self.manifest,copy=self.copy,
            extract=lambda *_:{"ok":False,"reason":"Confidential employee text"})
        self.assertEqual(result["errors"],["CONTENT_UNREADABLE"])
        self.assertEqual(self.store.db.execute("SELECT code FROM issues ORDER BY rowid DESC").fetchone()[0],"CONTENT_UNREADABLE")

    def test_resource_and_secret_failures_remain_unreadable(self):
        for code in ("CREDENTIAL_SHAPED_CONTENT","CELL_LIMIT","OCR_PAGE_LIMIT","PARSER_TIMEOUT"):
            with self.subTest(code=code):
                with self.store.write():
                    self.store.db.execute("UPDATE documents SET state='pending',reason=NULL")
                result=ingest.batch(self.store,self.root,self.manifest,copy=self.copy,
                    extract=lambda *_:{"ok":False,"reason":code})
                self.assertEqual(result["errors"],[code])
                self.assertEqual(self.store.search("Contrato"),[])

    def test_sandbox_failure_diagnostics_do_not_disclose_subprocess_output(self):
        for error,code in (
            (ingest.subprocess.TimeoutExpired("private command",180,output=b"private text"),"SANDBOX_TIMEOUT"),
            (ingest.subprocess.CalledProcessError(1,"private command",stderr=b"private text"),"SANDBOX_PROCESS_FAILED"),
        ):
            with self.subTest(code=code), patch.object(ingest.subprocess,"run",side_effect=error):
                with self.assertRaisesRegex(ingest.ExtractionFailure,"^"+code+"$"):
                    ingest.extract_sandboxed(self.payload,".txt")

    def test_malformed_sandbox_response_is_classified(self):
        for output in (b"private non-json text",b'{"ok":1}',b'[]',b'\xff'):
            with self.subTest(output=output), patch.object(ingest.subprocess,"run",
                    return_value=ingest.subprocess.CompletedProcess([],0,stdout=output)):
                with self.assertRaisesRegex(ingest.ExtractionFailure,"^INVALID_EXTRACTION_RESULT$"):
                    ingest.extract_sandboxed(self.payload,".txt")

    def test_symlinked_original_is_rejected(self):
        objects = self.root/"objects"/self.digest
        objects.mkdir(parents=True,mode=0o700)
        (objects/"original").symlink_to(self.payload)
        with self.assertRaisesRegex(ValueError,"UNSAFE_OBJECT"):
            ingest.ingest_document(self.store,self.root,self.manifest,self.document,copy=self.copy,extract=self.extract)

    def test_business_files_are_ingested_before_smaller_system_files(self):
        scan=self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[{"source":"Y:\\small.txt","directory":False,"bytes":1,"modifiedUtc":"2026-09-02T12:00:00Z"}],None)
        self.store.finish_scan(scan)
        calls=[]
        def copy(manifest,operation,source,**kwargs):
            calls.append(source)
            return self.copy()
        result=ingest.batch(self.store,self.root,self.manifest,max_files=1,copy=copy,extract=self.extract,priority_roots=["Y:\\report.txt"])
        self.assertEqual(result["processed"],1)
        self.assertEqual(calls,["Y:\\report.txt"])
        self.assertEqual(self.store.document("Y:\\small.txt")["state"],"pending")

    def more_documents(self,count):
        scan=self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[{"source":f"Y:\\report-{i}.txt","directory":False,
            "bytes":15,"modifiedUtc":self.document["modified"]} for i in range(count)],None)
        self.store.finish_scan(scan)

    def test_older_document_is_not_displaced_by_new_smaller_files(self):
        scan=self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[{"source":f"Y:\\small-{i}.txt","directory":False,
            "bytes":1,"modifiedUtc":self.document["modified"]} for i in range(10)],None)
        self.store.finish_scan(scan)
        calls=[]
        def copy(manifest,operation,source,**kwargs):
            calls.append(source)
            return self.copy()
        result=ingest.batch(self.store,self.root,self.manifest,max_files=1,copy=copy,extract=self.extract)
        self.assertEqual(result["processed"],1)
        self.assertEqual(calls,["Y:\\report.txt"])
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM documents WHERE state='pending'").fetchone()[0],10)

    def test_newer_business_document_keeps_priority_over_older_document(self):
        self.more_documents(1)
        calls=[]
        def copy(manifest,operation,source,**kwargs):
            calls.append(source)
            return self.copy()
        result=ingest.batch(self.store,self.root,self.manifest,max_files=1,copy=copy,extract=self.extract,
            priority_roots=["Y:\\report-0.txt"])
        self.assertEqual(result["processed"],1)
        self.assertEqual(calls,["Y:\\report-0.txt"])
        self.assertEqual(self.store.document("Y:\\report.txt")["state"],"pending")

    def test_document_preference_reserves_other_formats_and_keeps_discovery_order(self):
        scan=self.store.start_scan(['Y:\\'])
        entries=[{'source':f'Y:\\file-{i}{suffix}','directory':False,'bytes':15,'modifiedUtc':self.document['modified']}
                 for suffix in ('.pdf','.txt') for i in range(12)]
        self.store.record_page(scan,'Y:\\',0,entries,None);self.store.finish_scan(scan)
        calls=[]
        def copy(manifest,operation,source,**kwargs):calls.append(source);return self.copy()
        result=ingest.batch(self.store,self.root,self.manifest,max_files=10,prefer_documents=True,copy=copy,extract=self.extract)
        self.assertEqual(result['processed'],10)
        self.assertEqual([p for p in calls if p.endswith('.pdf')],[f'Y:\\file-{i}.pdf' for i in range(8)])
        self.assertEqual([p for p in calls if p.endswith('.txt')],['Y:\\report.txt','Y:\\file-0.txt'])
        self.assertEqual(calls[1],'Y:\\report.txt')
        self.assertEqual(len(set(calls)),10)

    def test_document_preference_fills_slots_when_preferred_queue_is_empty(self):
        self.more_documents(9)
        result=ingest.batch(self.store,self.root,self.manifest,max_files=10,prefer_documents=True,copy=self.copy,extract=self.extract)
        self.assertEqual(result['processed'],10)

    def test_old_file_larger_than_custom_batch_budget_does_not_block_fitting_file(self):
        scan=self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[{"source":"Y:\\small.txt","directory":False,
            "bytes":1,"modifiedUtc":self.document["modified"]}],None)
        self.store.finish_scan(scan)
        self.payload.write_bytes(b"x")
        self.digest=hashlib.sha256(b"x").hexdigest()
        calls=[]
        def copy(manifest,operation,source,**kwargs):
            calls.append(source)
            return {**self.copy(),"bytes":1}
        result=ingest.batch(self.store,self.root,self.manifest,max_bytes=1,max_files=1,copy=copy,extract=self.extract)
        self.assertEqual(result["processed"],1)
        self.assertEqual(calls,["Y:\\small.txt"])
        self.assertEqual(result["transferredBudgetBytes"],1)
        self.assertEqual(self.store.document("Y:\\report.txt")["state"],"pending")

    def test_fast_files_progress_past_two_without_admitting_after_time_budget(self):
        self.more_documents(7)
        elapsed=[0]
        def copy(*args,**kwargs):
            elapsed[0]+=30
            return self.copy()
        result=ingest.batch(self.store,self.root,self.manifest,max_files=10,seconds=120,
            clock=lambda:elapsed[0],copy=copy,extract=self.extract)
        self.assertEqual(result["processed"],4)
        self.assertEqual(result["paused"],"BATCH_TIME_LIMIT")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM documents WHERE state='pending'").fetchone()[0],4)

    def test_slow_file_finishes_and_next_file_stays_pending(self):
        self.more_documents(2)
        elapsed=[0]
        def extract(*args):
            elapsed[0]+=180
            return self.extract()
        result=ingest.batch(self.store,self.root,self.manifest,max_files=10,seconds=120,
            clock=lambda:elapsed[0],copy=self.copy,extract=extract)
        self.assertEqual(result["processed"],1)
        self.assertEqual(result["paused"],"BATCH_TIME_LIMIT")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM documents WHERE state='pending'").fetchone()[0],2)
        self.assertEqual(self.store.search("Contrato")[0]["sha256"],self.digest)

    def test_failed_file_also_consumes_time_budget(self):
        self.more_documents(2)
        elapsed=[0]
        def copy(*args,**kwargs):
            elapsed[0]+=180
            raise ValueError("RDP_OPERATION_FAILED")
        result=ingest.batch(self.store,self.root,self.manifest,max_files=10,seconds=120,
            clock=lambda:elapsed[0],copy=copy,extract=self.extract)
        self.assertEqual(result["processed"],0)
        self.assertEqual(result["errors"],["COPY_UNAVAILABLE"])
        self.assertEqual(result["paused"],"BATCH_TIME_LIMIT")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM documents WHERE state='pending'").fetchone()[0],3)

    def unavailable(self,*_,**__):
        raise ValueError("RDP_OPERATION_FAILED")

    def retry_batch(self,at,**kwargs):
        return ingest.batch(self.store,self.root,self.manifest,wall_clock=lambda:at,
            extract=self.extract,**kwargs)

    def test_retry_delay_survives_reopen_and_exhausts_after_three_attempts(self):
        self.assertEqual(self.retry_batch(1000,copy=self.unavailable)["errors"],["COPY_UNAVAILABLE"])
        self.store.close()
        self.store=ingest.catalogue.Catalogue(self.root,"test","operator")
        with patch.object(ingest,"ingest_document") as call:
            self.assertEqual(self.retry_batch(1299)["processed"],0)
            call.assert_not_called()
        self.retry_batch(1300,copy=self.unavailable)
        self.assertEqual(tuple(self.store.db.execute("SELECT attempts,next_attempt FROM ingestion_retries").fetchone()),(2,3100))
        self.retry_batch(3100,copy=self.unavailable)
        self.assertEqual(self.store.document(self.document["source"])["state"],"unreadable")
        with patch.object(ingest,"ingest_document") as call:
            self.retry_batch(100000)
            call.assert_not_called()
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM issues WHERE code='COPY_UNAVAILABLE'").fetchone()[0],3)
        self.assertEqual(self.store.search("Contrato"),[])

    def test_backoff_does_not_starve_other_pending_documents(self):
        self.retry_batch(1000,copy=self.unavailable)
        self.more_documents(1)
        result=self.retry_batch(1001,max_files=1,copy=self.copy)
        self.assertEqual(result["processed"],1)
        self.assertEqual(self.store.document(self.document["source"])["state"],"pending")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM ingestion_retries").fetchone()[0],1)

    def test_successful_retry_clears_budget_and_preserves_failure_history(self):
        self.retry_batch(1000,copy=self.unavailable)
        self.assertEqual(self.retry_batch(1300,copy=self.copy)["processed"],1)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM ingestion_retries").fetchone()[0],0)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM issues WHERE code='COPY_UNAVAILABLE'").fetchone()[0],1)
        self.assertEqual(len(self.store.search("Contrato")),1)

    def test_new_source_fingerprint_gets_a_fresh_retry_budget(self):
        self.retry_batch(1000,copy=self.unavailable)
        scan=self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[{"source":self.document["source"],"directory":False,
            "bytes":16,"modifiedUtc":"2026-09-03T12:00:00Z"}],None)
        self.store.finish_scan(scan)
        self.retry_batch(1001,copy=self.unavailable)
        retry=self.store.db.execute("SELECT * FROM ingestion_retries").fetchone()
        self.assertEqual((retry["attempts"],retry["next_attempt"]),(1,1301))
        self.assertNotEqual(retry["fingerprint"],self.document["fingerprint"])

    def test_busy_source_does_not_consume_an_attempt(self):
        self.retry_batch(1000,copy=self.unavailable)
        def busy(*_,**__):
            raise BlockingIOError("RDP_OPERATOR_BUSY")
        self.assertEqual(self.retry_batch(1300,copy=busy)["paused"],"SOURCE_BUSY")
        self.assertEqual(self.store.db.execute("SELECT attempts FROM ingestion_retries").fetchone()[0],1)
        self.assertEqual(self.retry_batch(1300,copy=self.copy)["processed"],1)

    def test_generic_local_failure_is_not_a_transport_retry(self):
        def failed(*_):
            raise OSError("private disk diagnostic")
        result=ingest.batch(self.store,self.root,self.manifest,copy=self.copy,extract=failed)
        self.assertEqual(result["errors"],["INGESTION_UNAVAILABLE"])
        self.assertEqual(self.store.document(self.document["source"])["state"],"unreadable")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM ingestion_retries").fetchone()[0],0)

    def test_policy_and_integrity_failures_stop_and_cannot_be_requeued(self):
        for code in ("RDP_DRIVE_REDIRECTION_DISABLED","COPY_HASH_MISMATCH","CACHE_HASH_MISMATCH"):
            with self.subTest(code=code):
                with self.store.write():
                    self.store.db.execute("UPDATE documents SET state='pending',reason=NULL")
                def failure(*_,**__):
                    raise ValueError(code)
                with self.assertRaisesRegex(ValueError,"^"+code+"$"):
                    self.retry_batch(1000,copy=failure)
                self.assertEqual(ingest.requeue_unreadable(self.store),0)
                self.assertEqual(self.store.document(self.document["source"])["state"],"unreadable")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM ingestion_retries").fetchone()[0],0)

    def test_explicit_retry_resets_exhausted_budget_and_respects_format(self):
        for at in (1000,1300,3100):
            self.retry_batch(at,copy=self.unavailable)
        self.assertEqual(ingest.requeue_unreadable(self.store,[".pdf"]),0)
        self.assertEqual(ingest.requeue_unreadable(self.store,[".txt"]),1)
        self.retry_batch(3101,copy=self.unavailable)
        self.assertEqual(tuple(self.store.db.execute("SELECT attempts,next_attempt FROM ingestion_retries").fetchone()),(1,3401))

    def test_source_change_retries_but_never_indexes_mismatched_receipt(self):
        def changed(*_,**__):
            return {**self.copy(),"modifiedUtc":"2026-09-03T12:00:00Z"}
        result=self.retry_batch(1000,copy=changed)
        self.assertEqual(result["errors"],["SOURCE_CHANGED_DURING_COPY"])
        self.assertEqual(self.store.document(self.document["source"])["state"],"pending")
        self.assertEqual(self.store.search("Contrato"),[])

    def test_invalid_time_limit_does_not_start_a_copy(self):
        def copy(*_,**__):
            self.fail("Invalid budget must not open the source")
        for seconds in (0,481,True,1.5):
            with self.subTest(seconds=seconds),self.assertRaisesRegex(ValueError,"INVALID_TIME_LIMIT"):
                ingest.batch(self.store,self.root,self.manifest,seconds=seconds,copy=copy)


if __name__ == "__main__":
    unittest.main()
