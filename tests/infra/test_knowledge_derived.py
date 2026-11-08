import importlib.util
from pathlib import Path
import tempfile
import sqlite3
import unittest

ROOT=Path(__file__).resolve().parents[2]/"infra/hetzner"
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/file)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
derived=load("derived","knowledge-derived.py")
insights=load("insights","knowledge-insights.py")
ACTOR="12345678-1234-4234-9234-123456789abc"


class DerivedTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=derived.catalogue.Catalogue(Path(self.temp.name).resolve()/"scope","test","company")
        scan=self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[{"source":"Y:\\roles.txt","directory":False,"bytes":100,"modifiedUtc":"2026-09-02T00:00:00Z"}],None)
        self.store.finish_scan(scan)
        self.document=self.store.document("Y:\\roles.txt")
        self.segments=[{"locator":"line:1","content":"Ana is the engineering lead."},{"locator":"line:2","content":"Ana is the operations lead."}]
        self.payload={"ok":True,"segments":self.segments,"tables":[{"locator":"csv","rows":[["Item","Amount"],["A","1.234,50"],["B","2,50"]]}],"warnings":[]}
        self.store.index_document(self.document["source"],self.document["fingerprint"],"a"*64,self.segments,structured=self.payload)
        self.memory=derived.DerivedKnowledge(self.store)
        self.entity={"type":"employee","key":"employee-demo-1","label":"Ana (fictional)"}

    def tearDown(self):
        self.store.close();self.temp.cleanup()

    def propose(self,line=0,key="one"):
        segment=self.segments[line]
        return self.memory.propose("fact",self.entity,"role",segment["content"],[{"source":self.document["source"],"sha256":"a"*64,"locator":segment["locator"],"quote":segment["content"]}],key)

    def test_proposals_require_real_quote_at_exact_location(self):
        record=self.propose()
        self.assertEqual(record["status"],"proposed")
        self.assertEqual(record["certainty"],"unverified-proposal")
        with self.assertRaisesRegex(ValueError,"QUOTE_NOT_IN_CITED_LOCATION"):
            self.memory.propose("fact",self.entity,"role","CEO",[{"source":self.document["source"],"sha256":"a"*64,"locator":"line:1","quote":self.segments[1]["content"]}],"bad")

    def test_conflicts_are_visible_and_confirmation_is_authorized(self):
        first=self.propose();second=self.propose(1,"two")
        self.assertEqual(second["conflicts"],[first["id"]])
        with self.assertRaisesRegex(ValueError,"REVIEWER_REQUIRED"):
            self.memory.review(first["id"],1,"confirm",ACTOR,lambda _:False)
        reviewed=self.memory.review(first["id"],1,"confirm",ACTOR,lambda _:True)
        self.assertEqual(reviewed["revision"],2)
        self.memory.review(second["id"],1,"confirm",ACTOR,lambda _:True)
        self.assertEqual(self.memory.get(first["id"],True)["status"],"superseded")

    def test_idempotency_rejection_and_revision_guards(self):
        record=self.propose()
        self.assertEqual(self.propose()["id"],record["id"])
        with self.assertRaisesRegex(ValueError,"REVISION_CONFLICT"):
            self.memory.review(record["id"],9,"confirm",ACTOR,lambda _:True)
        self.memory.review(record["id"],1,"reject",ACTOR,lambda _:True)
        self.assertEqual(self.propose()["status"],"rejected")
        with self.assertRaisesRegex(ValueError,"REJECTED_PROPOSAL_TOMBSTONE"):
            self.propose(key="new-transport")

    def test_source_change_invalidates_reviewed_fact_and_summary(self):
        record=self.propose()
        self.memory.review(record["id"],1,"confirm",ACTOR,lambda _:True)
        summary=self.memory.summarize_document(self.document["source"])
        self.store.withdraw(self.document["source"],"ACCESS_REVOKED")
        self.assertIsNone(self.memory.get(record["id"]))
        self.assertIsNone(self.memory.get(summary["id"]))
        self.assertEqual(self.memory.get(record["id"],True)["status"],"stale")
        self.assertEqual(self.memory.list(),[])

    def test_reindexing_identical_data_preserves_review(self):
        record=self.propose()
        self.memory.review(record["id"],1,"confirm",ACTOR,lambda _:True)
        self.store.index_document(self.document["source"],self.document["fingerprint"],"a"*64,self.segments,structured=self.payload)
        self.assertEqual(self.memory.get(record["id"])["status"],"confirmed")

    def test_correction_preserves_previous_record_citations_and_reviewer_reason(self):
        first=self.propose()
        self.memory.review(first['id'],1,'confirm',ACTOR,lambda _:True)
        corrected=self.memory.correct(first['id'],2,'Ana leads engineering; this source does not establish a company-wide role.',
            'Clarify the scope of the quoted role.',ACTOR,lambda _:True)
        self.assertNotEqual(corrected['id'],first['id'])
        self.assertEqual((corrected['status'],corrected['revision']),('confirmed',1))
        self.assertEqual(corrected['citations'],first['citations'])
        previous=self.memory.get(first['id'],True)
        self.assertEqual((previous['status'],previous['content']),('superseded',first['content']))
        link=self.store.db.execute('SELECT * FROM knowledge_corrections').fetchone()
        self.assertEqual((link['previous'],link['previous_revision'],link['actor']),(first['id'],2,ACTOR))
        self.assertIn('Clarify',link['reason'])
        with self.assertRaisesRegex(ValueError,'REVISION_CONFLICT'):
            self.memory.correct(first['id'],2,'Stale overwrite','Wrong browser version',ACTOR,lambda _:True)
        self.assertEqual(len(self.memory.list()),1)
        with self.assertRaisesRegex(ValueError,'CORRECTED_PROPOSAL_TOMBSTONE'):
            self.propose(key='another-model-run')

    def test_correction_denial_invalid_content_and_expired_source_do_not_mutate(self):
        first=self.propose()
        for content,reason,allowed,code in [('Changed','Reason',False,'REVIEWER_REQUIRED'),
                (first['content'],'Reason',True,'CORRECTION_UNCHANGED'),('Changed',' ',True,'INVALID_KNOWLEDGE_TEXT')]:
            with self.subTest(code=code),self.assertRaisesRegex(ValueError,code):
                self.memory.correct(first['id'],1,content,reason,ACTOR,lambda _:allowed)
        self.assertEqual(self.memory.get(first['id'])['revision'],1)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM knowledge_corrections').fetchone()[0],0)
        self.store.withdraw(self.document['source'],'ACCESS_REVOKED')
        with self.assertRaisesRegex(ValueError,'RECORD_NOT_REVIEWABLE'):
            self.memory.correct(first['id'],2,'Changed','Reason',ACTOR,lambda _:True)

    def test_failed_correction_rolls_back_replacement_and_previous_status(self):
        first=self.propose()
        self.store.db.execute("CREATE TRIGGER abort_correction BEFORE INSERT ON knowledge_corrections BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.memory.correct(first['id'],1,'Qualified role','Clarification',ACTOR,lambda _:True)
        self.assertEqual(self.memory.get(first['id'])['status'],'proposed')
        self.assertEqual(self.memory.get(first['id'])['revision'],1)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM knowledge_records').fetchone()[0],1)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM knowledge_events').fetchone()[0],1)

    def test_shorter_quotes_cannot_revive_correction_but_new_source_versions_can(self):
        first=self.propose()
        self.memory.correct(first['id'],1,'Qualified role','Clarification',ACTOR,lambda _:True)
        citation={**first['citations'][0],'quote':'engineering lead'}
        with self.assertRaisesRegex(ValueError,'CORRECTED_PROPOSAL_TOMBSTONE'):
            self.memory.propose('fact',self.entity,'role',first['content'],[citation],'shorter-quote')
        self.store.index_document(self.document['source'],self.document['fingerprint'],'b'*64,self.segments,structured=self.payload)
        next_proposal=self.memory.propose('fact',self.entity,'role',first['content'],[{**citation,'sha256':'b'*64}],'new-version')
        self.assertEqual(next_proposal['status'],'proposed')

    def test_correction_chain_supersedes_competing_confirmation_and_invalidates_with_source(self):
        first=self.propose()
        other=self.propose(1,'other')
        self.memory.review(other['id'],1,'confirm',ACTOR,lambda _:True)
        corrected=self.memory.correct(first['id'],1,'Qualified role','Human clarification',ACTOR,lambda _:True)
        self.assertEqual(self.memory.get(other['id'],True)['status'],'superseded')
        next_record=self.memory.correct(corrected['id'],1,'Further qualified role','Additional nuance',ACTOR,lambda _:True)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM knowledge_corrections').fetchone()[0],2)
        self.store.withdraw(self.document['source'],'SOURCE_DELETED')
        self.assertIsNone(self.memory.get(next_record['id']))
        self.assertEqual(self.memory.get(next_record['id'],True)['status'],'stale')

    def test_decimal_insight_is_explicit_reproducible_and_strict(self):
        result=insights.calculate(self.store,self.document["source"],"a"*64,0,{"rows":[2,3],"column":2},"sum","es")
        self.assertEqual(result["result"],"1237.00")
        self.assertEqual(result["selectedCells"],2)
        with self.assertRaisesRegex(ValueError,"DUPLICATE_ROW_SELECTION"):
            insights.calculate(self.store,self.document["source"],"a"*64,0,{"rows":[2,2],"column":2},"sum","es")
        with self.assertRaisesRegex(ValueError,"AMBIGUOUS_OR_NON_NUMERIC_CELL"):
            insights.calculate(self.store,self.document["source"],"a"*64,0,{"rows":[1,2],"column":2},"sum","es")
        with self.assertRaisesRegex(ValueError,"INDEXED_VERSION_UNAVAILABLE"):
            insights.calculate(self.store,self.document["source"],"b"*64,0,{"rows":[2],"column":2},"sum","es")


if __name__=="__main__":unittest.main()
