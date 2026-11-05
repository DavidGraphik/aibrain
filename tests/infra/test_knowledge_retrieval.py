import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("retrieval",Path(__file__).resolve().parents[2]/"infra/hetzner/knowledge-retrieval.py")
retrieval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retrieval)
COMPANY={"scope":"company","scopeId":None}
PRIVATE={"scope":"private","scopeId":"12345678-1234-4234-9234-123456789abc"}


class RetrievalTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name).resolve()
        store=retrieval.catalogue.Catalogue(self.root/"operator","test","operator")
        scan=store.start_scan(["Y:\\"])
        store.record_page(scan,"Y:\\",0,[{"source":"Y:\\report.txt","directory":False,"bytes":10,"modifiedUtc":"2026-09-02T00:00:00Z"}],None)
        store.finish_scan(scan)
        doc=store.document("Y:\\report.txt")
        segments=[{"locator":"page:1","content":"Resumen contrato"},{"locator":"page:2","content":"Condiciones vigentes"}]
        store.index_document(doc["source"],doc["fingerprint"],"a"*64,segments,
            structured={"ok":True,"segments":segments,"tables":[{"locator":"csv","rows":[["Importe"]]+[["1,25"] for _ in range(205)]}],"warnings":[]})
        store.close()
        self.bindings={"schemaVersion":1,"installationId":"test","rules":[{"sourceRoot":"Y:\\","audience":COMPANY}]}
        retrieval.publication.publish(self.root,"test",self.bindings,lambda _:None)
        self.reader=retrieval.Retrieval(self.root,"test","arnall",self.bindings,lambda a:a==COMPANY)

    def tearDown(self):
        self.temp.cleanup()

    def test_cited_search_reads_matching_version_and_next_part(self):
        result=self.reader.search(COMPANY,"contrato")
        first=self.reader.read(COMPANY,result["results"][0]["path"])
        self.assertEqual(first["locator"],"page:1")
        self.assertFalse(first["freshSourceChecked"])
        self.assertEqual(self.reader.read(COMPANY,first["nextPath"])["locator"],"page:2")

    def test_denied_scope_fails_before_missing_directory_is_checked(self):
        with self.assertRaisesRegex(ValueError,"SCOPE_DENIED"):
            self.reader.search(PRIVATE,"contrato")

    def test_foreign_reference_wrong_version_and_rebinding_are_denied(self):
        path=self.reader.search(COMPANY,"contrato")["results"][0]["path"]
        with self.assertRaisesRegex(ValueError,"FOREIGN_PARTITION_REFERENCE"):
            self.reader.read(PRIVATE,path)
        with self.assertRaisesRegex(ValueError,"INDEXED_VERSION_UNAVAILABLE"):
            self.reader.read(COMPANY,path.replace("a"*64,"b"*64))
        self.bindings["rules"]=[{"sourceRoot":"Y:\\","audience":None}]
        self.assertEqual(self.reader.search(COMPANY,"contrato")["results"],[])
        with self.assertRaisesRegex(ValueError,"SOURCE_SCOPE_REVOKED"):
            self.reader.read(COMPANY,path)

    def test_tables_paginate_and_calculations_bind_to_source_version_and_scope(self):
        path=self.reader.search(COMPANY,"contrato")["results"][0]["path"]
        first=self.reader.read(COMPANY,path)
        page=self.reader.read(COMPANY,first["tables"][0]["path"])
        self.assertEqual(len(page["table"]["rows"]),100)
        self.assertEqual(self.reader.read(COMPANY,page["nextPath"])["table"]["offset"],100)
        result=self.reader.calculate(COMPANY,path,0,{"rows":[2,3],"column":1},"sum","es")
        self.assertEqual(result["result"],"2.50")
        self.assertEqual(result["citations"],["csv:row:2:column:1","csv:row:3:column:1"])
        for bad_path in [path.replace("a"*64,"b"*64)]:
            with self.assertRaisesRegex(ValueError,"INDEXED_VERSION_UNAVAILABLE"):
                self.reader.calculate(COMPANY,bad_path,0,{"rows":[2],"column":1},"sum","es")
        self.bindings["rules"]=[{"sourceRoot":"Y:\\","audience":None}]
        with self.assertRaisesRegex(ValueError,"SOURCE_SCOPE_REVOKED"):
            self.reader.calculate(COMPANY,path,0,{"rows":[2],"column":1},"sum","es")

    def test_wide_table_preview_discloses_shortening_and_stays_bounded(self):
        payload={"tables":[{"locator":"table:1","rows":[["x"*10000]*1000]}]}
        page=retrieval.table_page(payload,0,0)
        self.assertTrue(page["previewTruncated"])
        self.assertLess(len(str(page)),33000)

    def test_memory_search_retains_proposal_status_and_excludes_newly_revoked_sources(self):
        root=self.root/"partitions"/retrieval.publication.partition_id(COMPANY)
        store=retrieval.catalogue.Catalogue(root,"test","company")
        memory=retrieval.derived.DerivedKnowledge(store)
        memory.propose("fact",{"type":"project","key":"contract","label":"Contrato"},"Estado","Condiciones vigentes",
            [{"source":"Y:\\report.txt","sha256":"a"*64,"locator":"page:2","quote":"Condiciones vigentes"}],"test-memory")
        store.close()
        result=self.reader.search(COMPANY,"contrato")
        self.assertEqual(result["knowledgeRecords"][0]["status"],"proposed")
        self.assertIn("knowledge-arnall",result["knowledgeRecords"][0]["citations"][0]["path"])
        self.bindings["rules"]=[{"sourceRoot":"Y:\\report.txt","audience":None}]
        self.assertEqual(self.reader.search(COMPANY,"contrato")["knowledgeRecords"],[])

    def test_completed_summary_search_discloses_extraction_coverage(self):
        spec=importlib.util.spec_from_file_location('summary',Path(retrieval.__file__).with_name('knowledge-summary.py'))
        summary=importlib.util.module_from_spec(spec);spec.loader.exec_module(summary)
        root=self.root/'partitions'/retrieval.publication.partition_id(COMPANY)
        store=retrieval.catalogue.Catalogue(root,'test','company')
        try:
            engine=summary.Summary(store);plan=engine.prepare('Y:\\report.txt')
            for part in plan['parts']:
                unit=part['units'][0]
                engine.save_part(plan['jobId'],part['id'],[{'text':'Resumen de contrato ficticio.','citations':[{'unitId':unit['id'],'quote':unit['content']}]}])
            engine.finalize(plan['jobId'],[{'text':'Resumen de contrato ficticio.','references':[{'partId':'1','claimIndex':0}]}])
        finally:
            store.close()
        record=self.reader.search(COMPANY,'contrato')['knowledgeRecords'][0]
        self.assertEqual(record['summaryCoverage']['processedParts'],len(plan['parts']))
        self.assertEqual(record['summaryCoverage']['extractedUnits'],plan['unitCount'])
        self.assertEqual(record['summaryCoverage']['semanticAccuracy'],'unverified-proposal')
        self.bindings['rules']=[{'sourceRoot':'Y:\\','audience':None}]
        self.assertEqual(self.reader.search(COMPANY,'contrato')['knowledgeRecords'],[])


if __name__=="__main__":
    unittest.main()
