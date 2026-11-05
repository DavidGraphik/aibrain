import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import test_knowledge_backup as fixture

spec=importlib.util.spec_from_file_location('recovery',Path(__file__).resolve().parents[2]/'infra/hetzner/knowledge-recovery.py')
recovery=importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        fixture.BackupTests.setUp(self)
        self.config=self.parent/'connection.json'
        self.access=self.parent/'access.json'
        self.binding_file=self.parent/'bindings.json'
        for file,value in ((self.config,{'fixture':True}),(self.access,{'readOnly':True}),(self.binding_file,self.bindings)):
            file.write_text(json.dumps(value)); file.chmod(0o600)
        self.manifest={'installationId':'test','sourceRoots':['Y:\\'],'maxFileBytes':self.store.max_file_bytes,
            'connectionConfig':str(self.config),'accessManifest':str(self.access),'recoveryBindingsFile':str(self.binding_file)}
        # Supply only fictional host configuration under the test user's owner.
        # Production's root-only loader is separately tested without this seam.
        def fictional_private(path):
            path=Path(path)
            recovery.backup.regular(path)
            return path
        self.loader=patch.object(recovery.files.rdp,'private_file',side_effect=fictional_private)
        self.loader.start()
        self.restore()

    def tearDown(self):
        self.loader.stop()
        fixture.BackupTests.tearDown(self)

    def restore(self):
        snapshot=Path(fixture.backup.create(self.root,'test',self.backups,self.bindings)['snapshot'])
        self.destination=Path(tempfile.mktemp(prefix='restored-',dir=self.parent))
        fixture.backup.restore(snapshot,'test',self.destination,self.root)

    def restored_store(self):
        return recovery.catalogue.Catalogue(self.destination/'operator','test','operator')

    def present(self,manifest,source):
        row=self.store.document(source)
        return {'source':source,'state':'present','bytes':row['bytes'],'modifiedUtc':row['modified'],'sha256':row['sha256']}

    def run_batch(self,**kwargs):
        return recovery.batch(self.destination,self.root,self.manifest,self.bindings,lambda _:None,**kwargs)

    def finish(self,check_scope=lambda _:None):
        return recovery.finalize(self.destination,self.root,self.manifest,self.bindings,check_scope)

    def gate_exists(self):
        return (self.destination/recovery.GATE).is_file()

    def reader(self):
        module=recovery.module('restored_retrieval','knowledge-retrieval.py')
        return module.Retrieval(self.destination,'test','arnall',self.bindings,lambda _:True)

    def test_old_leases_never_open_gate_and_real_recheck_allows_isolated_reads(self):
        with self.assertRaisesRegex(ValueError,'RECOVERY_SOURCE_CHECKS_PENDING'):
            self.finish()
        self.assertTrue(self.gate_exists())
        result=self.run_batch(check=self.present)
        self.assertEqual((result['checked'],result['pendingSourceChecks']),(1,0))
        with self.assertRaisesRegex(ValueError,'RESTORE_RECONCILIATION_REQUIRED'):
            self.reader().search(fixture.COMPANY,'contrato')
        receipt=self.finish()
        self.assertTrue(receipt['readerGateOpened'])
        self.assertFalse(receipt['liveRootChanged'])
        self.assertFalse(self.gate_exists())
        self.assertTrue(self.reader().search(fixture.COMPANY,'contrato')['results'])
        self.assertEqual(self.store.document(self.source)['state'],'indexed')

    def test_unavailable_is_not_deletion_and_never_reuses_backup_freshness(self):
        result=self.run_batch(check=lambda _,s:{'source':s,'state':'unavailable'})
        self.assertEqual(result['pendingSourceChecks'],1)
        store=self.restored_store()
        try:
            self.assertEqual(store.document(self.source)['state'],'indexed')
            self.assertFalse(store.source_current(self.source,self.sha))
        finally: store.close()
        with self.assertRaisesRegex(ValueError,'RECOVERY_SOURCE_CHECKS_PENDING'):
            self.finish()
        self.assertTrue(self.gate_exists())
        self.run_batch(check=self.present)
        self.finish()

    def test_changed_deleted_and_denied_sources_cannot_reappear_from_partitions(self):
        for state in ('missing','denied','changed'):
            with self.subTest(state=state):
                self.restore()
                def check(_,source):
                    return {'source':source,'state':state} if state!='changed' else {**self.present(_,source),'sha256':'f'*64}
                self.run_batch(check=check)
                self.finish()
                self.assertEqual(self.reader().search(fixture.COMPANY,'contrato')['results'],[])
                self.assertTrue(self.store.search('contrato'))

    def test_changed_current_binding_withdraws_old_partition_without_source_read(self):
        self.bindings={**self.bindings,'rules':[]}
        self.binding_file.write_text(json.dumps(self.bindings))
        with patch.object(recovery.source,'check') as check:
            self.run_batch(check=check)
            check.assert_not_called()
        self.finish()
        self.assertEqual(self.reader().search(fixture.COMPANY,'contrato')['results'],[])

    def test_config_change_restarts_reconciliation_and_policy_race_keeps_gate(self):
        self.run_batch(check=self.present)
        self.config.write_text('{"fixture":"rotated"}')
        with self.assertRaisesRegex(ValueError,'RECOVERY_SOURCE_CHECKS_PENDING'):
            self.finish()
        self.run_batch(check=self.present)
        original=recovery.publication.publish
        def changed(*args,**kwargs):
            result=original(*args,**kwargs)
            self.access.write_text('{"readOnly":true,"revision":2}')
            return result
        with patch.object(recovery.publication,'publish',side_effect=changed),self.assertRaisesRegex(ValueError,'RECOVERY_POLICY_CHANGED'):
            self.finish()
        self.assertTrue(self.gate_exists())

    def test_current_scope_denial_and_binding_file_race_prevent_opening(self):
        self.run_batch(check=self.present)
        def deny(_): raise ValueError('SCOPE_NOT_PROVISIONED')
        with self.assertRaisesRegex(ValueError,'SCOPE_NOT_PROVISIONED'):
            self.finish(check_scope=deny)
        self.binding_file.write_text(json.dumps({**self.bindings,'rules':[]}))
        with self.assertRaisesRegex(ValueError,'RECOVERY_POLICY_CHANGED'):
            self.finish()
        self.assertTrue(self.gate_exists())

    def test_live_root_overlap_and_symlinked_gate_are_rejected(self):
        with self.assertRaisesRegex(ValueError,'RECOVERY_LIVE_ROOT_OVERLAP'):
            recovery.batch(self.root,self.root,self.manifest,self.bindings,lambda _:None)
        gate=self.destination/recovery.GATE
        gate.unlink(); gate.symlink_to(self.config)
        with self.assertRaisesRegex(ValueError,'UNSAFE_OBJECT'):
            self.run_batch(check=self.present)

    def test_dotdot_alias_cannot_bypass_live_root_boundary(self):
        alias=self.backups/'..'/self.root.name
        with self.assertRaisesRegex(ValueError,'RECOVERY_CANONICAL_ROOT_REQUIRED'):
            recovery.batch(alias,self.root,self.manifest,self.bindings,lambda _:None)

    def test_source_busy_does_not_fabricate_a_source_failure(self):
        def busy(*_): raise BlockingIOError('RDP_OPERATOR_BUSY')
        result=self.run_batch(check=busy)
        self.assertEqual((result['paused'],result['checked'],result['pendingSourceChecks']),('SOURCE_BUSY',0,1))
        self.assertTrue(self.gate_exists())

    def test_corrupt_original_and_source_policy_are_integrity_stops(self):
        def denied(*_): raise ValueError('RDP_DRIVE_REDIRECTION_DISABLED')
        with self.assertRaisesRegex(ValueError,'RDP_DRIVE_REDIRECTION_DISABLED'):
            self.run_batch(check=denied)
        original=self.destination/'operator'/'objects'/self.sha/'original'
        original.write_bytes(b'corrupted')
        with self.assertRaisesRegex(ValueError,'RESTORE_ORIGINAL_HASH_MISMATCH'):
            self.run_batch(check=self.present)
        self.assertTrue(self.gate_exists())

    def test_expired_checks_and_incomplete_publication_keep_gate(self):
        self.run_batch(check=self.present)
        with patch.object(recovery.publication,'publish',return_value={'bounded':True}):
            with self.assertRaisesRegex(ValueError,'RECOVERY_PUBLICATION_PENDING'):
                self.finish()
        store=self.restored_store()
        try:
            with store.write(): store.db.execute("UPDATE source_checks SET verified_at='2000-01-01T00:00:00+00:00'")
        finally: store.close()
        with self.assertRaisesRegex(ValueError,'RECOVERY_SOURCE_CHECKS_PENDING'):
            self.finish()
        self.assertTrue(self.gate_exists())

    def test_partition_directory_sync_failure_keeps_gate_closed(self):
        self.run_batch(check=self.present)
        original=recovery.backup.sync_directory
        def sync(directory):
            if directory==self.destination/'partitions':
                raise OSError('fixture directory sync failure')
            return original(directory)
        with patch.object(recovery.backup,'sync_directory',side_effect=sync),self.assertRaises(OSError):
            self.finish()
        self.assertTrue(self.gate_exists())
        self.assertFalse((self.destination/'recovery-verified.json').exists())

    def test_interrupted_initialization_repeats_invalidation(self):
        with patch.object(recovery.files.sync,'atomic_json',side_effect=OSError('fixture interruption')):
            with self.assertRaises(OSError): self.run_batch(check=self.present)
        self.assertTrue(self.gate_exists())
        self.assertFalse((self.destination/recovery.PROGRESS).exists())
        self.assertEqual(self.run_batch(check=self.present)['pendingSourceChecks'],0)

    def add_second_source(self):
        row=self.store.document(self.source)
        self.second='Y:\\second.txt'
        scan=self.store.start_scan(['Y:\\'])
        self.store.record_page(scan,'Y:\\',0,[{'source':self.second,'directory':False,'bytes':row['bytes'],'modifiedUtc':row['modified']}],None)
        self.store.finish_scan(scan)
        self.store.index_document(self.second,self.store.document(self.second)['fingerprint'],self.sha,
            [{'locator':'line:1','content':'Contrato ficticio con referencias conservadas.'}])
        fixture.backup.publication.publish(self.root,'test',self.bindings,lambda _:None)
        self.restore()

    def test_bounded_batches_resume_without_starving_unchecked_sources(self):
        self.add_second_source()
        calls=[]
        def check(manifest,source):
            calls.append(source)
            return {'source':source,'state':'unavailable'} if source==self.source else self.present(manifest,source)
        self.run_batch(max_files=1,check=check)
        self.run_batch(max_files=1,check=check)
        self.assertEqual(calls,[self.source,self.second])
        self.assertEqual(self.run_batch(check=self.present)['pendingSourceChecks'],0)
        self.finish()

    def test_time_budget_finishes_current_source_without_starting_next(self):
        self.add_second_source()
        elapsed=[0]
        def check(manifest,source):
            elapsed[0]+=130
            return self.present(manifest,source)
        result=self.run_batch(max_files=20,seconds=120,check=check,clock=lambda:elapsed[0])
        self.assertEqual((result['checked'],result['pendingSourceChecks'],result['paused']),(1,1,'BATCH_TIME_LIMIT'))
        self.assertEqual(self.run_batch(check=self.present)['pendingSourceChecks'],0)
        self.finish()

    @unittest.skipIf(os.geteuid()==0,'Needs an actual non-root configuration file')
    def test_production_configuration_loader_still_rejects_non_root_owner(self):
        self.loader.stop()
        with self.assertRaisesRegex(ValueError,'root-owned'):
            recovery.policy_digest(self.manifest,self.bindings)


if __name__=='__main__':
    unittest.main()
