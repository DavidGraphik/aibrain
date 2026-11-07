import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import test_knowledge_derived as fixtures

spec=importlib.util.spec_from_file_location('worker',Path(__file__).resolve().parents[2]/'infra/hetzner/knowledge-summary-worker.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)


class Adapter:
    def __init__(self):self.calls=[]
    def generate(self,request,key,timeout):
        self.calls.append((request,key,timeout))
        if request['stage']=='synthesis':
            return {'claims':[{'text':'Resumen ficticio sujeto a revisión.','references':[{'partId':'1','claimIndex':0}]}]}
        unit=request['data']['part']['units'][0]
        return {'claims':[{'text':'Una función indicada en el documento ficticio.','citations':[{'unitId':unit['id'],'quote':unit['content']}]}]}


class WorkerTests(unittest.TestCase):
    def setUp(self):
        fixtures.DerivedTests.setUp(self)
        self.clock=1000;self.permitted=True
        self.plan=worker.summary.Summary(self.store).prepare(self.document['source'])
        self.job=self.plan['jobId'];self.adapter=Adapter()
        self.engine=self.new_worker();self.engine.enqueue(self.job)

    tearDown=fixtures.DerivedTests.tearDown

    def new_worker(self):return worker.Worker(self.store,'fixture-model-v1',lambda _:self.permitted,lambda:self.clock)

    def test_steps_resume_and_complete_exactly_one_unconfirmed_summary(self):
        self.assertEqual(self.engine.step(self.job,self.adapter)['state'],'ready')
        self.engine=self.new_worker()
        self.assertEqual(self.engine.step(self.job,self.adapter)['state'],'complete')
        self.assertEqual(self.engine.step(self.job,self.adapter)['state'],'complete')
        self.assertEqual(len(self.adapter.calls),2)
        self.assertEqual(self.adapter.calls[0][2],90)
        self.assertNotEqual(self.adapter.calls[0][1],self.adapter.calls[1][1])
        self.assertEqual(self.store.db.execute('SELECT status FROM knowledge_records').fetchone()[0],'proposed')

    def test_generation_denial_precedes_content_reads(self):
        self.permitted=False
        with patch.object(self.engine.engine,'load') as load:
            with self.assertRaisesRegex(ValueError,'SUMMARY_GENERATION_DENIED'):
                self.engine.step(self.job,self.adapter)
            load.assert_not_called()
        self.assertEqual(self.adapter.calls,[])

    def test_revocation_after_reservation_stops_before_dispatch(self):
        def authorize(job):
            row=self.store.db.execute('SELECT state FROM summary_execution WHERE job=?',(job,)).fetchone()
            return row['state']!='running'
        self.engine=worker.Worker(self.store,'fixture-model-v1',authorize,lambda:self.clock)
        self.assertEqual(self.engine.step(self.job,self.adapter)['error'],'GENERATION_REVOKED_BEFORE_DISPATCH')
        self.assertEqual(self.adapter.calls,[])

    def test_revocation_during_model_work_discards_result(self):
        original=self.adapter.generate
        def generate(*args):
            result=original(*args);self.permitted=False;return result
        self.adapter.generate=generate
        self.assertEqual(self.engine.step(self.job,self.adapter)['error'],'MODEL_RESULT_NOT_COMMITTED')
        self.assertEqual(self.store.db.execute('SELECT drafts FROM summary_jobs').fetchone()[0],'{}')

    def test_changed_source_discards_result(self):
        original=self.adapter.generate
        def generate(*args):
            result=original(*args);self.store.withdraw(self.document['source'],'ACCESS_REVOKED');return result
        self.adapter.generate=generate
        self.assertEqual(self.engine.step(self.job,self.adapter)['state'],'blocked')
        self.assertEqual(self.store.db.execute('SELECT drafts FROM summary_jobs').fetchone()[0],'{}')

    def test_only_proven_non_dispatch_retries_with_bounded_backoff(self):
        calls=[]
        def generate(request,key,timeout):calls.append(key);raise worker.NotDispatched('not recorded')
        self.adapter.generate=generate
        self.assertEqual(self.engine.step(self.job,self.adapter)['state'],'retry')
        self.engine.step(self.job,self.adapter);self.assertEqual(len(calls),1)
        self.clock+=60;self.engine.step(self.job,self.adapter)
        self.clock+=300;self.assertEqual(self.engine.step(self.job,self.adapter)['state'],'blocked')
        self.clock+=10000;self.engine.step(self.job,self.adapter)
        self.assertEqual(len(calls),3);self.assertEqual(len(set(calls)),1)

    def test_crash_and_expired_lease_never_repeat_uncertain_dispatch(self):
        def generate(*args):raise KeyboardInterrupt()
        self.adapter.generate=generate
        with self.assertRaises(KeyboardInterrupt):self.engine.step(self.job,self.adapter)
        replacement=Adapter();self.engine=self.new_worker()
        self.assertEqual(self.engine.step(self.job,replacement)['state'],'running')
        self.clock+=121
        self.assertEqual(self.engine.step(self.job,replacement)['error'],'MODEL_OUTCOME_UNKNOWN')
        self.assertEqual(replacement.calls,[])

    def test_provider_error_is_private_and_never_blindly_retried(self):
        def generate(*args):raise RuntimeError('private customer content and provider credential')
        self.adapter.generate=generate
        result=self.engine.step(self.job,self.adapter)
        self.assertEqual(result['error'],'MODEL_OUTCOME_UNKNOWN')
        self.assertNotIn('private',str(self.engine.status(self.job)))

    def test_second_worker_yields_while_first_has_live_lease(self):
        original=self.adapter.generate;other=Adapter()
        def generate(*args):
            separate=fixtures.derived.catalogue.Catalogue(Path(self.temp.name).resolve()/'scope','test','company')
            try:
                contender=worker.Worker(separate,'fixture-model-v1',lambda _:True,lambda:self.clock)
                self.assertEqual(contender.step(self.job,other)['state'],'running')
            finally:separate.close()
            return original(*args)
        self.adapter.generate=generate
        self.engine.step(self.job,self.adapter);self.assertEqual(other.calls,[])

    def test_checkpoint_failure_rolls_back_summary_record_and_job(self):
        self.engine.step(self.job,self.adapter)
        self.store.db.execute("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON summary_execution WHEN NEW.state='complete' BEGIN SELECT RAISE(ABORT,'fixture'); END")
        result=self.engine.step(self.job,self.adapter)
        self.assertEqual(result['state'],'blocked')
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM knowledge_records').fetchone()[0],0)
        self.assertIsNone(self.store.db.execute('SELECT record FROM summary_jobs').fetchone()[0])
        self.assertIsNone(self.store.db.execute('SELECT synthesis FROM summary_jobs').fetchone()[0])

    def test_invalid_quote_blocks_without_persisting_claim(self):
        self.adapter.generate=lambda *args:{'claims':[{'text':'Unsupported claim','citations':[{'unitId':'1','quote':'Invented quote'}]}]}
        self.assertEqual(self.engine.step(self.job,self.adapter)['state'],'blocked')
        self.assertEqual(self.store.db.execute('SELECT drafts FROM summary_jobs').fetchone()[0],'{}')

    def test_provider_request_keys_include_installation_and_partition(self):
        other=fixtures.derived.catalogue.Catalogue(Path(self.temp.name).resolve()/'other','other','company')
        try:
            # Identical fictional content/plans in separate installations must
            # never share a provider reconciliation/idempotency key.
            self.store.db.backup(other.db)
            with other.write():other.db.execute("UPDATE identity SET installation='other'")
            adapter=Adapter()
            worker.Worker(other,'fixture-model-v1',lambda _:True,lambda:self.clock).step(self.job,adapter)
            self.engine.step(self.job,self.adapter)
            self.assertNotEqual(adapter.calls[0][1],self.adapter.calls[0][1])
        finally:other.close()

    def test_model_pin_and_large_output_are_enforced(self):
        with self.assertRaisesRegex(ValueError,'SUMMARY_MODEL_CHANGED'):
            worker.Worker(self.store,'other-model',lambda _:True).step(self.job,self.adapter)
        self.adapter.generate=lambda *args:{'claims':['x'*65536]}
        self.assertEqual(self.engine.step(self.job,self.adapter)['state'],'blocked')
        self.assertEqual(self.store.db.execute('SELECT drafts FROM summary_jobs').fetchone()[0],'{}')

    def test_oversized_input_stops_before_provider_dispatch(self):
        self.payload['warnings']=[{'code':'PAGE_WITHOUT_READABLE_TEXT','locator':f'page:{i}'} for i in range(6000)]
        self.store.index_document(self.document['source'],self.document['fingerprint'],'a'*64,self.segments,structured=self.payload)
        plan=self.engine.engine.prepare(self.document['source'])
        self.engine.enqueue(plan['jobId'])
        result=self.engine.step(plan['jobId'],self.adapter)
        self.assertEqual(result['error'],'MODEL_INPUT_TOO_LARGE')
        self.assertEqual(self.adapter.calls,[])


if __name__=='__main__':unittest.main()
