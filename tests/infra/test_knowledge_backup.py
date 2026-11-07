import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location("backup",Path(__file__).resolve().parents[2]/"infra/hetzner/knowledge-backup.py")
backup=importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
COMPANY={"scope":"company","scopeId":None}


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.parent=Path(self.temp.name).resolve()
        self.root=backup.private_directory(self.parent/"live",create=True)
        self.backups=backup.private_directory(self.parent/"snapshots",create=True)
        self.store=backup.catalogue.Catalogue(self.root/"operator","test","operator")
        scan=self.store.start_scan(["Y:\\"])
        self.source="Y:\\report.txt"
        text=b"Contrato ficticio con referencias conservadas."
        self.sha=hashlib.sha256(text).hexdigest()
        self.store.record_page(scan,"Y:\\",0,[{"source":self.source,"directory":False,"bytes":len(text),"modifiedUtc":"2026-09-02T00:00:00Z"}],None)
        self.store.finish_scan(scan)
        self.store.index_document(self.source,self.store.document(self.source)["fingerprint"],self.sha,[{"locator":"line:1","content":text.decode()}])
        original=self.root/"operator"/"objects"/self.sha/"original"
        original.parent.mkdir(mode=0o700,parents=True)
        original.write_bytes(text)
        original.chmod(0o600)
        self.bindings={"schemaVersion":1,"installationId":"test","rules":[{"sourceRoot":"Y:\\","audience":COMPANY}]}
        backup.publication.publish(self.root,"test",self.bindings,lambda _:None)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_snapshot_restores_index_versions_and_original_into_gated_new_tree(self):
        result=backup.create(self.root,"test",self.backups,self.bindings)
        snapshot=Path(result["snapshot"])
        self.assertTrue(backup.verify(snapshot,"test"))
        self.store.withdraw(self.source,"ACCESS_REVOKED")
        destination=self.parent/"restored"
        restored=backup.restore(snapshot,"test",destination,self.root)
        self.assertFalse(restored["employeeAccessEnabled"])
        store=backup.catalogue.Catalogue(destination/"operator","test","operator",readonly=True)
        try:
            self.assertEqual(len(store.search("contrato")),1)
        finally:
            store.close()
        self.assertEqual(self.store.search("contrato"),[])
        spec=importlib.util.spec_from_file_location("retrieval",Path(backup.__file__).with_name("knowledge-retrieval.py"))
        retrieval=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(retrieval)
        reader=retrieval.Retrieval(destination,"test","arnall",self.bindings,lambda _:True)
        with self.assertRaisesRegex(ValueError,"RESTORE_RECONCILIATION_REQUIRED"):
            reader.search(COMPANY,"contrato")

    def test_correction_and_previous_statement_survive_verified_backup_restore(self):
        spec=importlib.util.spec_from_file_location('derived_backup_test',Path(backup.__file__).with_name('knowledge-derived.py'))
        derived=importlib.util.module_from_spec(spec);spec.loader.exec_module(derived)
        directory=self.root/'partitions'/backup.publication.partition_id(COMPANY)
        store=backup.catalogue.Catalogue(directory,'test','company')
        try:
            memory=derived.DerivedKnowledge(store)
            old=memory.propose('fact',{'type':'document','key':'fixture','label':'Fictional'},'Scope','Contract applies broadly',
                [{'source':self.source,'sha256':self.sha,'locator':'line:1','quote':'Contrato ficticio con referencias conservadas.'}],'fixture-correction')
            new=memory.correct(old['id'],1,'Contract applies to this cited fixture.','Avoid a broader interpretation.',
                '12345678-1234-4234-9234-123456789abc',lambda _:True)
        finally: store.close()
        snapshot=Path(backup.create(self.root,'test',self.backups,self.bindings)['snapshot'])
        destination=self.parent/'corrected-restore'
        backup.restore(snapshot,'test',destination,self.root)
        store=backup.catalogue.Catalogue(destination/'partitions'/backup.publication.partition_id(COMPANY),'test','company',readonly=True)
        try:
            memory=derived.DerivedKnowledge(store)
            self.assertEqual(memory.get(new['id'])['content'],new['content'])
            self.assertEqual(memory.get(old['id'],True)['content'],old['content'])
            self.assertEqual(memory.get(old['id'],True)['status'],'superseded')
            self.assertEqual(store.db.execute('SELECT reason FROM knowledge_corrections').fetchone()[0],'Avoid a broader interpretation.')
            self.assertFalse(store.db.execute('PRAGMA foreign_key_check').fetchall())
        finally: store.close()
        self.assertTrue((destination/'restore-requires-reconciliation.json').is_file())

    def test_tampered_snapshot_and_live_restore_are_rejected(self):
        snapshot=Path(backup.create(self.root,"test",self.backups,self.bindings)["snapshot"])
        with self.assertRaisesRegex(ValueError,"RESTORE_DESTINATION_EXISTS"):
            backup.restore(snapshot,"test",self.root,self.root)
        with self.assertRaisesRegex(ValueError,"INVALID_BACKUP_MANIFEST"):
            backup.verify(snapshot,"foreign")
        original=snapshot/"operator"/"objects"/self.sha/"original"
        original.write_text("tampered")
        with self.assertRaisesRegex(ValueError,"BACKUP_CHECKSUM_MISMATCH"):
            backup.verify(snapshot,"test")
        self.assertTrue(self.store.search("contrato"))

    def test_missing_original_fails_without_promoting_a_snapshot(self):
        (self.root/"operator"/"objects"/self.sha/"original").unlink()
        with self.assertRaises(OSError):
            backup.create(self.root,"test",self.backups,self.bindings)
        self.assertFalse(any(not p.name.startswith('.pending-') for p in self.backups.iterdir()))

    def test_all_created_backup_directories_are_private_with_permissive_umask(self):
        previous=os.umask(0o022)
        try:
            snapshot=Path(backup.create(self.root,'test',self.backups,self.bindings)['snapshot'])
        finally:
            os.umask(previous)
        self.assertTrue(all(p.stat().st_mode&0o777==0o700 for p in snapshot.rglob('*') if p.is_dir()))


if __name__=='__main__':
    unittest.main()
