import datetime as dt
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import unittest
import uuid
from unittest.mock import patch
import test_knowledge_backup as fixtures

spec=importlib.util.spec_from_file_location('maintenance',Path(__file__).resolve().parents[2]/'infra/hetzner/knowledge-backup-maintain.py')
maintenance=importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.previous_umask=os.umask(0o077)
        self.addCleanup(os.umask,self.previous_umask)
        fixtures.BackupTests.setUp(self)

    tearDown=fixtures.BackupTests.tearDown

    def test_only_verified_old_snapshots_beyond_keep_are_removed(self):
        base=Path(maintenance.backup.create(self.root,'test',self.backups,self.bindings)['snapshot'])
        now=dt.datetime.now(dt.timezone.utc)
        copies=[]
        for age in (20,15,10,1):
            target=self.backups/str(uuid.uuid4())
            shutil.copytree(base,target)
            manifest=json.loads((target/'manifest.json').read_text())
            manifest.update(backupId=target.name,createdAt=(now-dt.timedelta(days=age)).isoformat())
            (target/'manifest.json').write_text(json.dumps(manifest))
            copies.append(target)
        incomplete=self.backups/'.pending-test'
        incomplete.mkdir(mode=0o700)
        result=maintenance.maintain(self.root,'test',self.backups,self.bindings,keep=2,at=now)
        self.assertEqual(result['state'],'completed')
        self.assertFalse(result['replicatedOffHost'])
        self.assertTrue(base.exists() and copies[-1].exists() and incomplete.exists())
        self.assertTrue(all(not p.exists() for p in copies[:-1]))
        self.assertEqual(result['retained'],3) # minimum age preserves recent extra
        self.assertTrue(self.store.search('contrato'))

    def test_corrupt_snapshot_stops_retention_and_new_creation(self):
        snapshot=Path(maintenance.backup.create(self.root,'test',self.backups,self.bindings)['snapshot'])
        (snapshot/'operator'/'objects'/self.sha/'original').write_text('tampered')
        with patch.object(maintenance.backup,'create') as create:
            with self.assertRaisesRegex(ValueError,'BACKUP_CHECKSUM_MISMATCH'):
                maintenance.maintain(self.root,'test',self.backups,self.bindings)
            create.assert_not_called()
        self.assertTrue(snapshot.exists())

    def test_capacity_and_overlap_fail_before_copy(self):
        with patch.object(maintenance.backup,'create') as create:
            with self.assertRaisesRegex(ValueError,'BACKUP_CAPACITY_LIMIT'):
                maintenance.maintain(self.root,'test',self.backups,self.bindings,max_bytes=1024*1024)
            create.assert_not_called()
        with self.assertRaisesRegex(ValueError,'BACKUP_SOURCE_OVERLAP'):
            maintenance.maintain(self.root,'test',self.root,self.bindings)
        self.assertTrue(self.store.search('contrato'))

    def test_busy_maintenance_yields_and_symlink_is_never_followed(self):
        lock=self.backups/'.maintenance.lock'
        fd=os.open(lock,os.O_CREAT|os.O_RDWR,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            self.assertEqual(maintenance.maintain(self.root,'test',self.backups,self.bindings),{'state':'waiting','reason':'BACKUP_BUSY'})
        finally:
            os.close(fd)
        (self.backups/'.pending-symlink').symlink_to(self.root,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'UNSAFE_BACKUP_PATH'):
            maintenance.maintain(self.root,'test',self.backups,self.bindings)
        self.assertTrue(self.store.search('contrato'))


if __name__=='__main__':
    unittest.main()
