import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('migration',Path(__file__).resolve().parents[2]/'infra/hetzner/knowledge-migrate.py')
migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name).resolve()/'catalogue'
        store=migration.catalogue.Catalogue(self.root,'test','operator')
        scan=store.start_scan(['Y:\\'])
        store.record_page(scan,'Y:\\',0,[{'source':'Y:\\report.txt','directory':False,'bytes':20,'modifiedUtc':'2026-09-03T00:00:00Z'}],None)
        for name in ['summary_reductions','summary_execution','summary_jobs','knowledge_corrections']:
            store.db.execute('DROP TABLE '+name)
        store.close()

    def tearDown(self):self.temp.cleanup()

    def test_additive_upgrade_preserves_source_and_is_idempotent(self):
        result=migration.migrate_partition(self.root,'test','operator')
        self.assertEqual(set(result['addedTables']),migration.ADDITIONS)
        self.assertTrue(result['existingRowsPreserved'])
        self.assertEqual(migration.migrate_partition(self.root,'test','operator')['addedTables'],[])
        store=migration.catalogue.Catalogue(self.root,'test','operator',readonly=True)
        self.assertEqual(store.document('Y:\\report.txt')['bytes'],20)
        self.assertEqual(store.document('Y:\\report.txt')['state'],'pending')
        store.close()

    def test_wrong_identity_does_not_add_tables(self):
        with self.assertRaisesRegex(ValueError,'PARTITION_IDENTITY_MISMATCH'):
            migration.migrate_partition(self.root,'other','operator')
        store=migration.catalogue.Catalogue(self.root,'test','operator',readonly=True)
        self.assertNotIn(('table','summary_jobs'),migration.schema(store.db));store.close()

    def test_conflicting_existing_schema_is_rejected_before_other_additions(self):
        import sqlite3
        db=sqlite3.connect(self.root/'catalogue.sqlite3')
        db.execute('CREATE TABLE summary_jobs (unexpected TEXT)');db.close()
        with self.assertRaisesRegex(ValueError,'UNEXPECTED_MIGRATION_SCHEMA'):
            migration.migrate_partition(self.root,'test','operator')
        store=migration.catalogue.Catalogue(self.root,'test','operator',readonly=True)
        self.assertNotIn(('table','knowledge_corrections'),migration.schema(store.db));store.close()


if __name__=='__main__':unittest.main()
