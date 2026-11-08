import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("publish",Path(__file__).resolve().parents[2]/"infra/hetzner/knowledge-publish.py")
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)
COMPANY = {"scope":"company","scopeId":None}
PRIVATE = {"scope":"private","scopeId":"12345678-1234-4234-9234-123456789abc"}


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.store = publish.catalogue.Catalogue(self.root/"operator","test","operator")
        scan = self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[{"source":"Y:\\"+name,"directory":False,"bytes":10,"modifiedUtc":"2026-09-02T12:00:00Z"} for name in ["general.txt","payroll.txt"]],None)
        self.store.finish_scan(scan)
        for name,text in [("general.txt","Empresa proyecto conocido"),("payroll.txt","Empleado sueldo reservado")]:
            row = self.store.document("Y:\\"+name)
            self.store.index_document(row["source"],row["fingerprint"],("a" if name=="general.txt" else "b")*64,[{"locator":"line:1","content":text}])

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def bindings(self,rules):
        return {"schemaVersion":1,"installationId":"test","rules":rules}

    def read_partition(self,audience):
        return publish.catalogue.Catalogue(self.root/"partitions"/publish.partition_id(audience),"test",publish.audience_key(audience),readonly=True)

    def test_default_is_no_publication_and_nested_exclusion_wins(self):
        empty = publish.publish(self.root,"test",self.bindings([]),lambda _:None)
        self.assertEqual(empty["published"],0)
        rules = [{"sourceRoot":"Y:\\","audience":COMPANY},{"sourceRoot":"Y:\\payroll.txt","audience":None}]
        result = publish.publish(self.root,"test",self.bindings(rules),lambda _:None)
        self.assertEqual(result["published"],1)
        reader = self.read_partition(COMPANY)
        try:
            self.assertEqual(len(reader.search("proyecto")),1)
            self.assertEqual(reader.find_files("payroll"),[])
            self.assertEqual(reader.search("sueldo"),[])
        finally:
            reader.close()

    def test_private_partition_is_separate_and_binding_removal_withdraws(self):
        rules = [{"sourceRoot":"Y:\\","audience":COMPANY},{"sourceRoot":"Y:\\payroll.txt","audience":PRIVATE}]
        publish.publish(self.root,"test",self.bindings(rules),lambda _:None)
        company,private = self.read_partition(COMPANY),self.read_partition(PRIVATE)
        try:
            self.assertEqual(company.search("sueldo"),[])
            self.assertEqual(len(private.search("sueldo")),1)
        finally:
            company.close()
            private.close()
        result = publish.publish(self.root,"test",self.bindings([]),lambda _:None)
        self.assertEqual(result["withdrawn"],2)
        private = self.read_partition(PRIVATE)
        try:
            self.assertEqual(private.search("sueldo"),[])
        finally:
            private.close()

    def test_current_versions_are_idempotent_and_scopes_checked(self):
        bindings = self.bindings([{"sourceRoot":"Y:\\general.txt","audience":COMPANY}])
        calls=[]
        first = publish.publish(self.root,"test",bindings,lambda a:calls.append(a))
        second = publish.publish(self.root,"test",bindings,lambda a:calls.append(a))
        self.assertEqual((first["published"],second["published"]),(1,0))
        self.assertEqual(calls,[COMPANY,COMPANY])
        self.store.withdraw("Y:\\general.txt","ACCESS_REVOKED")
        self.assertEqual(publish.publish(self.root,"test",bindings,lambda _:None)["withdrawn"],1)

    def test_invalid_or_ambiguous_bindings_rejected(self):
        for rules in [[{"sourceRoot":"Y:\\","audience":COMPANY}]*2,
                      [{"sourceRoot":"Y:\\..\\other","audience":COMPANY}],
                      [{"sourceRoot":"Y:\\","audience":{"scope":"private","scopeId":"not-id"}}]]:
            with self.assertRaises(ValueError):
                publish.validate_bindings(self.bindings(rules),"test")
        with self.assertRaisesRegex(ValueError,"INVALID_PUBLICATION_BINDINGS"):
            publish.validate_bindings(self.bindings([]),"other")

    def test_unchanged_document_retains_new_observation_date_without_reindexing(self):
        bindings=self.bindings([{"sourceRoot":"Y:\\general.txt","audience":COMPANY}])
        publish.publish(self.root,"test",bindings,lambda _:None)
        with self.store.write():
            self.store.db.execute("UPDATE documents SET last_seen='2026-09-03T00:00:00Z' WHERE source='Y:\\general.txt'")
        self.assertEqual(publish.publish(self.root,"test",bindings,lambda _:None)["published"],0)
        partition=self.read_partition(COMPANY)
        try:
            self.assertEqual(partition.document("Y:\\general.txt")["last_seen"],"2026-09-03T00:00:00Z")
        finally:
            partition.close()


if __name__ == "__main__":
    unittest.main()
