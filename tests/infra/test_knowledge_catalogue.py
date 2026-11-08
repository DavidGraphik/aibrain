import importlib.util
import datetime as dt
import os
from pathlib import Path
import tempfile
import subprocess
import unittest

INFRA = Path(__file__).resolve().parents[2] / "infra/hetzner"


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, INFRA / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


catalogue = load("catalogue", "knowledge-catalogue.py")
inventory = load("inventory", "knowledge-inventory.py")
TIME = "2026-09-02T12:00:00Z"


def entry(source, directory=False, size=20, modified=TIME):
    return {"source":source,"directory":directory,"bytes":size,"modifiedUtc":modified}


class CatalogueTests(unittest.TestCase):
    def test_spreading_pages_discovers_other_roots_before_draining_priority_folder(self):
        scan = self.store.start_scan(['C:\\','Y:\\'])
        self.store.record_page(scan,'Y:\\',0,[entry('Y:\\large.pdf')],1)
        self.assertEqual(self.store.next_directory(scan,['Y:\\'])['source'],'Y:\\')
        self.assertEqual(self.store.next_directory(scan,['Y:\\'],spread_pages=True)['source'],'C:\\')
        self.store.close()
        self.store = catalogue.Catalogue(self.root,'arnall','operator')
        self.assertEqual(self.store.next_directory(scan,['Y:\\'],spread_pages=True)['source'],'C:\\')

    def test_rescan_waits_for_finished_scan_and_interval(self):
        at=dt.datetime(2026,9,3,tzinfo=dt.timezone.utc)
        scan={"state":"observed","finished":"2026-09-02T00:00:00Z"}
        self.assertTrue(inventory.rescan_due(scan,86400,at))
        self.assertFalse(inventory.rescan_due(scan,86401,at))
        self.assertFalse(inventory.rescan_due(scan,0,at))
        self.assertFalse(inventory.rescan_due({**scan,"state":"running"},86400,at))
        with self.assertRaisesRegex(ValueError,"INVALID_RESCAN_INTERVAL"):
            inventory.rescan_due(scan,1,at)

    def test_priority_folders_do_not_remove_the_remaining_queue(self):
        scan=self.store.start_scan(["C:\\","Y:\\"])
        self.assertEqual(self.store.next_directory(scan,["Y:\\Business"])["source"],"Y:\\")
        self.store.record_page(scan,"Y:\\",0,[entry("Y:\\Business",True)],None)
        self.assertEqual(self.store.next_directory(scan,["Y:\\Business"])["source"],"Y:\\Business")
        self.store.record_page(scan,"Y:\\Business",0,[],None)
        self.assertEqual(self.store.next_directory(scan,["Y:\\Business"])["source"],"C:\\")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve() / "catalogue"
        self.store = catalogue.Catalogue(self.root,"arnall","operator")

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def add_document(self, text="Contrato de mantenimiento", source="Y:\\report.txt"):
        scan = self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[entry(source)],None)
        self.store.finish_scan(scan)
        doc = self.store.db.execute("SELECT * FROM documents WHERE source_key=?",(catalogue.source_key(source),)).fetchone()
        self.store.index_document(source,doc["fingerprint"],"a"*64,[{"locator":"page:1","content":text}])
        return scan, doc

    def test_restart_keeps_queue_and_rejects_replayed_page(self):
        scan = self.store.start_scan(["Y:\\"])
        first = [entry("Y:\\folder",True),entry("Y:\\a.txt")]
        self.store.record_page(scan,"Y:\\",0,first,2)
        self.store.close()
        self.store = catalogue.Catalogue(self.root,"arnall","operator")
        self.assertEqual(self.store.next_directory(scan)["offset"],2)
        with self.assertRaisesRegex(ValueError,"STALE_DIRECTORY_PAGE"):
            self.store.record_page(scan,"Y:\\",0,first,2)
        self.store.record_page(scan,"Y:\\",2,[entry("Y:\\b.txt")],None)
        self.assertEqual(self.store.next_directory(scan)["source"],"Y:\\folder")
        self.store.record_page(scan,"Y:\\folder",0,[],None)
        coverage = self.store.finish_scan(scan)
        self.assertEqual(coverage["directories"],{"complete":2})
        self.assertEqual(coverage["documents"],{"pending":2})
        self.assertFalse(coverage["snapshot"])

    def test_bad_page_is_atomic_and_cannot_inject_sibling(self):
        scan = self.store.start_scan(["Y:\\allowed"])
        with self.assertRaisesRegex(ValueError,"INVALID_PAGE_PARENT"):
            self.store.record_page(scan,"Y:\\allowed",0,[entry("Y:\\allowed\\good.txt"),entry("Y:\\private\\bad.txt")],None)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM documents").fetchone()[0],0)
        self.assertEqual(self.store.next_directory(scan)["offset"],0)

    def test_scope_identity_and_private_paths(self):
        for installation,audience in [("other","operator"),("arnall","company")]:
            with self.assertRaisesRegex(ValueError,"PARTITION_IDENTITY"):
                catalogue.Catalogue(self.root,installation,audience)
        link = self.root.parent / "symlink"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError,"UNSAFE_STORE_PATH"):
            catalogue.Catalogue(link / "child","arnall","operator")
        os.chmod(self.root,0o755)
        with self.assertRaisesRegex(ValueError,"PRIVATE_STORE_REQUIRED"):
            catalogue.Catalogue(self.root,"arnall","operator")
        os.chmod(self.root,0o700)

    def test_readonly_store_cannot_mutate_and_read_is_version_bound(self):
        self.add_document()
        reader = catalogue.Catalogue(self.root,"arnall","operator",readonly=True)
        try:
            self.assertIn("mantenimiento",reader.read_document("Y:\\report.txt","a"*64)["content"])
            with self.assertRaisesRegex(ValueError,"INDEXED_VERSION_UNAVAILABLE"):
                reader.read_document("Y:\\report.txt","b"*64)
            with self.assertRaises(Exception):
                reader.withdraw("Y:\\report.txt","SOURCE_DELETED")
        finally:
            reader.close()

    def test_content_search_provenance_and_literal_query(self):
        self.add_document("El contrato de mantenimiento vence en diciembre.")
        result = self.store.search("mantenimiento")
        self.assertEqual(len(result),1)
        self.assertEqual(result[0]["sha256"],"a"*64)
        self.assertEqual(result[0]["locator"],"page:1")
        self.assertEqual(self.store.search('" OR * -'),[])
        self.assertEqual(self.store.search("' UNION SELECT password"),[])

    def test_filename_lookup_works_before_extraction_and_excludes_withdrawn(self):
        scan = self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[entry("Y:\\Budget_2026.xlsx")],None)
        self.assertEqual(self.store.find_files("Budget_")[0]["state"],"pending")
        self.assertEqual(self.store.find_files("%"),[])
        self.store.withdraw("Y:\\Budget_2026.xlsx","ACCESS_REVOKED")
        self.assertEqual(self.store.find_files("Budget"),[])

    def test_changed_version_invalidates_search_and_rejects_late_index(self):
        _, old = self.add_document()
        scan = self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[entry("Y:\\report.txt",size=30)],None)
        self.assertEqual(self.store.search("mantenimiento"),[])
        with self.assertRaisesRegex(ValueError,"SOURCE_VERSION_CHANGED"):
            self.store.index_document(old["source"],old["fingerprint"],"b"*64,[{"locator":"page:1","content":"stale content"}])

    def test_failed_scan_does_not_delete_previous_content(self):
        self.add_document()
        scan = self.store.start_scan(["Y:\\"])
        for _ in range(3):
            self.store.directory_failed(scan,"Y:\\","SOURCE_ACCESS_DENIED")
        coverage = self.store.finish_scan(scan)
        self.assertEqual(coverage["scan"]["state"],"incomplete")
        self.assertEqual(coverage["unconfirmedFromPreviousScans"],1)
        self.assertEqual(len(self.store.search("mantenimiento")),1)

    def test_withdrawal_removes_content_without_erasing_version_history(self):
        self.add_document()
        self.store.withdraw("Y:\\report.txt","ACCESS_REVOKED")
        self.assertEqual(self.store.search("mantenimiento"),[])
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM chunks").fetchone()[0],0)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM versions").fetchone()[0],1)
        scan = self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[entry("Y:\\report.txt",size=30)],None)
        row = self.store.db.execute("SELECT * FROM documents").fetchone()
        self.assertEqual((row["state"],row["reason"]),("withdrawn","ACCESS_REVOKED"))

    def test_credentials_rejected_without_replacing_good_index(self):
        _,doc = self.add_document()
        with self.assertRaisesRegex(ValueError,"CREDENTIAL_SHAPED_CONTENT"):
            self.store.index_document(doc["source"],doc["fingerprint"],"b"*64,[{"locator":"page:1","content":"api_key=abcdefghijklmnopqrstuvwx"}])
        self.assertEqual(len(self.store.search("mantenimiento")),1)

    def test_formats_sizes_and_recovered_retry(self):
        scan = self.store.start_scan(["Y:\\"])
        self.store.directory_failed(scan,"Y:\\")
        self.store.record_page(scan,"Y:\\",0,[entry("Y:\\a.exe"),entry("Y:\\huge.pdf",size=20*1024*1024),entry("Y:\\a.pdf")],None)
        result = self.store.finish_scan(scan)
        self.assertEqual(result["scan"]["state"],"observed")
        self.assertEqual(result["documents"],{"pending":1,"unsupported":2})

    def test_cross_page_duplicates_mark_observation_incomplete(self):
        scan = self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[entry("Y:\\a.txt")],1)
        self.store.record_page(scan,"Y:\\",1,[entry("Y:\\a.txt")],None)
        self.assertEqual(self.store.finish_scan(scan)["scan"]["state"],"incomplete")

    def test_worker_resumes_and_does_not_store_secret_paths(self):
        manifest = {"sourceRoots":["Y:\\"]}
        scan = self.store.start_scan(["Y:\\"])
        calls = []
        def browse(_,request):
            calls.append(request["offset"])
            return {"ok":True,"truncated":request["offset"] == 0,"nextOffset":2 if request["offset"] == 0 else None,
                    "entries":[entry("Y:\\good.txt"),entry("Y:\\passwords.txt")] if request["offset"] == 0 else [entry("Y:\\last.txt")]}
        inventory.run_batch(self.store,manifest,scan,max_pages=1,run=browse)
        self.assertEqual(self.store.next_directory(scan)["offset"],2)
        result = inventory.run_batch(self.store,manifest,scan,max_pages=2,run=browse)
        self.assertEqual(calls,[0,2])
        self.assertEqual(result["scan"]["state"],"incomplete")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM documents").fetchone()[0],2)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM documents WHERE name LIKE '%password%'").fetchone()[0],0)

    def test_worker_rejects_broken_cursor_and_stops_on_policy_denial(self):
        scan = self.store.start_scan(["Y:\\"])
        manifest = {"sourceRoots":["Y:\\"]}
        def broken(*_):
            return {"ok":True,"truncated":True,"nextOffset":0,"entries":[]}
        inventory.run_batch(self.store,manifest,scan,run=broken)
        self.assertEqual(self.store.next_directory(scan)["offset"],0)
        self.assertEqual(self.store.next_directory(scan)["attempts"],1)
        def denied(*_):
            raise ValueError("RDP_DRIVE_REDIRECTION_DISABLED")
        with self.assertRaisesRegex(ValueError,"RDP_DRIVE_REDIRECTION_DISABLED"):
            inventory.run_batch(self.store,manifest,scan,run=denied)

    def test_busy_source_yields_without_consuming_retry_budget(self):
        scan = self.store.start_scan(["Y:\\"])
        def busy(*_):
            raise BlockingIOError("operator busy")
        result = inventory.run_batch(self.store,{"sourceRoots":["Y:\\"]},scan,run=busy)
        self.assertEqual(result["paused"],"SOURCE_BUSY")
        self.assertEqual(self.store.next_directory(scan)["attempts"],0)

    def test_source_failures_keep_fixed_diagnostics_and_retry_limit(self):
        cases = [
            (ValueError("WINDOWS_PATH_UNAVAILABLE"), "SOURCE_PATH_UNAVAILABLE"),
            (ValueError("SERVER_QUERY_TOO_LARGE"), "SOURCE_COMMAND_TOO_LARGE"),
            (ValueError("RDP_CONNECTION_LOST"), "SOURCE_CONNECTION_LOST"),
            (ValueError("No matching RDP readback; source access was not confirmed"), "SOURCE_READBACK_UNCONFIRMED"),
            (ValueError("RDP session startup failed"), "SOURCE_CONNECTION_FAILED"),
            (subprocess.TimeoutExpired("secret command", 45), "SOURCE_TIMEOUT"),
            (subprocess.CalledProcessError(1, "secret command", stderr="secret stderr"), "SOURCE_PROCESS_FAILED"),
            (ValueError("secret path"), "INVALID_SOURCE_PAGE"),
            (AttributeError("secret response"), "INVALID_SOURCE_PAGE"),
            (OSError("secret path"), "SOURCE_UNAVAILABLE"),
        ]
        for error, code in cases:
            with self.subTest(code=code):
                scan = self.store.start_scan(["Y:\\"])
                def fail(*_):
                    raise error
                for attempt in range(1, 4):
                    result = inventory.run_batch(self.store, {"sourceRoots":["Y:\\"]}, scan, run=fail, max_pages=1)
                    row = self.store.db.execute("SELECT * FROM directories WHERE scan=?", (scan,)).fetchone()
                    self.assertEqual((row["offset"], row["attempts"], row["reason"]), (0, attempt, code))
                    self.assertEqual(row["state"], "pending" if attempt < 3 else "incomplete")
                    self.assertEqual(result["directoryIssues"], [{"state":row["state"], "reason":code, "directories":1}])
                    self.assertNotIn("secret", str(result))
                self.store.finish_scan(scan)
        codes = [row[0] for row in self.store.db.execute("SELECT code FROM issues")]
        self.assertFalse(any("secret" in code for code in codes))

    def test_unavailable_folder_does_not_starve_accessible_folder_or_repeat(self):
        scan = self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[entry("Y:\\bad",True),entry("Y:\\good",True)],None)
        calls = []
        def browse(_, request):
            calls.append(request["source"])
            if request["source"] == "Y:\\bad":
                raise ValueError("WINDOWS_PATH_UNAVAILABLE")
            return {"ok":True,"entries":[entry("Y:\\good\\report.txt")],"truncated":False,"nextOffset":None}
        result = inventory.run_batch(self.store,{"sourceRoots":["Y:\\"]},scan,run=browse)
        self.assertEqual(calls,["Y:\\bad","Y:\\good"])
        self.assertEqual(result["paused"],"SOURCE_RETRY_PENDING")
        self.assertEqual(result["scan"]["state"],"running")
        self.assertEqual(result["documents"],{"pending":1})
        self.assertEqual(self.store.next_directory(scan)["attempts"],1)
        # A fresh invocation retries once; the third exhausts the original cap.
        inventory.run_batch(self.store,{"sourceRoots":["Y:\\"]},scan,run=browse)
        result = inventory.run_batch(self.store,{"sourceRoots":["Y:\\"]},scan,run=browse)
        self.assertEqual(calls,["Y:\\bad","Y:\\good","Y:\\bad","Y:\\bad"])
        self.assertEqual(result["scan"]["state"],"incomplete")

    def test_failed_requests_count_toward_batch_limit_and_transport_stops(self):
        scan = self.store.start_scan(["Y:\\"])
        self.store.record_page(scan,"Y:\\",0,[entry("Y:\\bad",True),entry("Y:\\good",True)],None)
        calls = []
        def fail(_, request):
            calls.append(request["source"])
            raise ValueError("WINDOWS_PATH_UNAVAILABLE")
        inventory.run_batch(self.store,{"sourceRoots":["Y:\\"]},scan,run=fail,max_pages=1)
        self.assertEqual(calls,["Y:\\bad"])
        def disconnect(_, request):
            calls.append(request["source"])
            raise ValueError("RDP_CONNECTION_LOST")
        inventory.run_batch(self.store,{"sourceRoots":["Y:\\"]},scan,run=disconnect)
        self.assertEqual(calls,["Y:\\bad","Y:\\bad"])
        self.assertEqual(self.store.db.execute("SELECT attempts FROM directories WHERE source=?",("Y:\\good",)).fetchone()[0],0)


if __name__ == "__main__":
    unittest.main()
