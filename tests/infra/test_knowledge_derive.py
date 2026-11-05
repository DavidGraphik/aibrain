import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location("derive",Path(__file__).resolve().parents[2]/"infra/hetzner/knowledge-derive.py")
derive=importlib.util.module_from_spec(spec)
spec.loader.exec_module(derive)


class EntityDerivationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=derive.publication.catalogue.Catalogue(Path(self.temp.name).resolve()/"company","test","company")
        self.source="Y:\\employees.csv"
        scan=self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[{"source":self.source,"directory":False,"bytes":100,"modifiedUtc":"2026-09-02T00:00:00Z"}],None)
        self.store.finish_scan(scan)
        self.mapping={"entityType":"employee","entityNamespace":"fictional-roster","headerRow":1,"identityColumn":1,"labelColumn":2,"fields":[{"column":3,"topic":"Cargo"}]}
        self.rows=[["ID","Nombre","Cargo"],["E001","Ana Ejemplo","Compras"],["E002","Nil Fictici",""]]
        self.index(self.rows)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def index(self,rows):
        segments=[{"locator":f"row:{i}","content":" | ".join(row)} for i,row in enumerate(rows,1)]
        document=self.store.document(self.source)
        self.store.index_document(self.source,document["fingerprint"],"a"*64,segments,
            structured={"ok":True,"segments":segments,"tables":[{"locator":"csv","rows":rows}],"warnings":[]})

    def test_mapped_facts_have_exact_identity_header_and_value_citations(self):
        result=derive.derive_table(self.store,self.source,"a"*64,0,self.mapping)
        self.assertEqual(result["proposed"],1)
        memory=derive.derived.DerivedKnowledge(self.store)
        facts=memory.list(query="Ana")
        self.assertEqual(len(facts),1)
        self.assertEqual((facts[0]["content"],facts[0]["status"]),("Compras","proposed"))
        self.assertEqual(len(facts[0]["citations"]),4)
        derive.derive_table(self.store,self.source,"a"*64,0,self.mapping)
        self.assertEqual(len(memory.list()),1)
        self.store.withdraw(self.source,"ACCESS_REVOKED")
        self.assertEqual(memory.list(),[])

    def test_duplicate_identities_and_blank_fields_are_not_guessed(self):
        self.index(self.rows+[["e001","Ana Otra","Gerencia"]])
        result=derive.derive_table(self.store,self.source,"a"*64,0,self.mapping)
        self.assertEqual(result["skippedRows"],2)
        self.assertEqual(derive.derived.DerivedKnowledge(self.store).list(),[])

    def test_mapping_is_explicit_and_paginated_without_merging_unknowns(self):
        page=derive.derive_table(self.store,self.source,"a"*64,0,self.mapping,limit=1)
        self.assertEqual(page["nextOffset"],1)
        self.assertEqual(derive.derive_table(self.store,self.source,"a"*64,0,self.mapping,offset=1)["proposed"],0)
        with self.assertRaisesRegex(ValueError,"COLUMN_KIND_MISMATCH"):
            derive.derive_table(self.store,self.source,"a"*64,0,{**self.mapping,"identityColumn":"A"})


if __name__=='__main__':
    unittest.main()
