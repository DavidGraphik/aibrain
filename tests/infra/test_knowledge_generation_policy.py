import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import test_knowledge_retrieval as fixtures
import test_knowledge_summary_worker as worker_fixtures

spec=importlib.util.spec_from_file_location('generation_policy',Path(__file__).resolve().parents[2]/'infra/hetzner/knowledge-generation-policy.py')
policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy)


class GenerationPolicyTests(unittest.TestCase):
    def setUp(self):
        fixtures.RetrievalTests.setUp(self)
        self.manifest={'installationId':'test','connectionId':'arnall'}
        self.policy_file=self.root/'generation.json';self.bindings_file=self.root/'bindings.json'
        store=policy.catalogue.Catalogue(self.root/'partitions'/policy.publication.partition_id(fixtures.COMPANY),'test','company')
        try:self.plan=policy.worker.summary.Summary(store).prepare('Y:\\report.txt')
        finally:store.close()
        self.job=self.plan['jobId']
        self.value={'schemaVersion':1,'installationId':'test','connectionId':'arnall','enabled':True,'modelKey':'fixture-model-v1','expiresAt':'2099-01-01T00:00:00Z',
            'grants':[{'jobId':self.job,'source':'Y:\\report.txt','sha256':'a'*64,'audience':fixtures.COMPANY}]}
        self.write();self.adapter=worker_fixtures.Adapter();self.adapter.model_key='fixture-model-v1'
        self.engine=policy.GenerationPolicy(self.root,self.manifest,self.bindings_file,self.policy_file)
        # Only the root-owned file and deployed-volume marker are substituted:
        # all config parsing, fresh reads, gates, stores and operator checks run.
        self.private=patch.object(policy.files.rdp,'private_file',side_effect=lambda p:Path(p));self.private.start()
        self.scope=patch.object(policy.files.sync,'scope_directory',return_value=None);self.scope.start()

    def tearDown(self):
        self.private.stop();self.scope.stop();fixtures.RetrievalTests.tearDown(self)

    def write(self):
        self.policy_file.write_text(json.dumps(self.value));self.policy_file.chmod(0o600)
        self.bindings_file.write_text(json.dumps(self.bindings));self.bindings_file.chmod(0o600)

    def test_actual_policy_adapter_completes_fictional_unconfirmed_summary(self):
        self.assertEqual(self.engine.run_step(self.job,self.adapter)['state'],'ready')
        self.assertEqual(self.engine.run_step(self.job,self.adapter)['state'],'complete')
        self.assertEqual(len(self.adapter.calls),2)

    def test_ungranted_job_is_denied_before_partition_access(self):
        with patch.object(policy.retrieval,'Retrieval') as reader:
            with self.assertRaisesRegex(ValueError,'GENERATION_JOB_NOT_GRANTED'):
                self.engine.run_step('0'*64,self.adapter)
            reader.assert_not_called()
        self.assertEqual(self.adapter.calls,[])

    def test_disabled_expired_or_foreign_policy_denies_before_store_access(self):
        for field,value in [('enabled',False),('expiresAt','2000-01-01T00:00:00Z'),('installationId','other')]:
            original=self.value[field];self.value[field]=value;self.write()
            with patch.object(policy.retrieval,'Retrieval') as reader:
                with self.assertRaises(ValueError):self.engine.run_step(self.job,self.adapter)
                reader.assert_not_called()
            self.value[field]=original

    def test_restore_gate_blocks_before_database_open(self):
        (self.root/'restore-requires-reconciliation.json').write_text('{}')
        with patch.object(policy.catalogue,'Catalogue') as store:
            with self.assertRaisesRegex(ValueError,'RESTORE_RECONCILIATION_REQUIRED'):
                self.engine.run_step(self.job,self.adapter)
            store.assert_not_called()

    def test_publication_rebinding_and_scope_marker_revoke_generation(self):
        self.bindings['rules'][0]['audience']=fixtures.PRIVATE;self.write()
        with patch.object(policy.retrieval,'Retrieval') as reader:
            with self.assertRaisesRegex(ValueError,'GENERATION_SOURCE_NOT_PUBLISHED'):
                self.engine.run_step(self.job,self.adapter)
            reader.assert_not_called()
        self.bindings['rules'][0]['audience']=fixtures.COMPANY;self.write()
        with patch.object(policy.files.sync,'scope_directory',side_effect=ValueError('SCOPE_DENIED')):
            with self.assertRaisesRegex(ValueError,'SCOPE_DENIED'):self.engine.run_step(self.job,self.adapter)
        self.assertEqual(self.adapter.calls,[])

    def test_stale_partition_cannot_override_operator_revocation(self):
        store=policy.catalogue.Catalogue(self.root/'operator','test','operator')
        try:store.withdraw('Y:\\report.txt','ACCESS_REVOKED')
        finally:store.close()
        with self.assertRaisesRegex(ValueError,'GENERATION_SOURCE_UNAVAILABLE'):
            self.engine.run_step(self.job,self.adapter)
        self.assertEqual(self.adapter.calls,[])

    def test_fresh_policy_revocation_during_generation_discards_result(self):
        original=self.adapter.generate
        def generate(*args):
            result=original(*args);self.value['enabled']=False;self.write();return result
        self.adapter.generate=generate
        self.assertEqual(self.engine.run_step(self.job,self.adapter)['state'],'blocked')
        store=policy.catalogue.Catalogue(self.root/'partitions'/policy.publication.partition_id(fixtures.COMPANY),'test','company',readonly=True)
        try:self.assertEqual(store.db.execute('SELECT drafts FROM summary_jobs').fetchone()[0],'{}')
        finally:store.close()

    def test_retargeted_grant_or_adapter_cannot_change_job_destination(self):
        binding=self.engine.permission(self.job)
        self.value['modelKey']='other-model';self.write()
        with self.assertRaisesRegex(ValueError,'GENERATION_GRANT_CHANGED'):self.engine.permission(self.job,binding)
        with self.assertRaisesRegex(ValueError,'GENERATION_ADAPTER_MISMATCH'):self.engine.run_step(self.job,self.adapter)
        self.assertEqual(self.adapter.calls,[])

    def test_granted_job_must_match_database_source_and_version(self):
        self.value['grants'][0]['jobId']='0'*64;self.write()
        with self.assertRaisesRegex(ValueError,'GENERATION_JOB_VERSION_MISMATCH'):
            self.engine.run_step('0'*64,self.adapter)
        self.value['grants'][0]['jobId']=self.job;self.value['grants'][0]['sha256']='b'*64;self.write()
        with self.assertRaisesRegex(ValueError,'INDEXED_VERSION_UNAVAILABLE'):
            self.engine.run_step(self.job,self.adapter)

    def test_strict_config_and_canonical_path_validation(self):
        for change in [{'actorId':'model'},{'expiresAt':'2099-01-01'},{'schemaVersion':True},{'grants':self.value['grants']*2}]:
            with self.assertRaises(ValueError):policy.validate({**self.value,**change},self.manifest)
        with self.assertRaisesRegex(ValueError,'CANONICAL_GENERATION_ROOT_REQUIRED'):
            policy.GenerationPolicy(self.root/'unused'/'..',self.manifest,self.bindings_file,self.policy_file)

    def test_original_root_ownership_guard_remains_required(self):
        self.private.stop()
        try:
            import os
            if os.geteuid()==0:self.skipTest('Requires real unprivileged ownership')
            with self.assertRaisesRegex(ValueError,'root-owned'):
                self.engine.permission(self.job)
        finally:self.private.start()


if __name__=='__main__':unittest.main()
