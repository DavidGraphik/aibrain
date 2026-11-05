"""Recovery and scope boundaries for the Windows mirror, without a Windows server."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

INFRA = Path(__file__).resolve().parents[2] / "infra/hetzner"


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, INFRA / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


sync = module("rdp_sync", "rdp-sync.py")
extract = module("rdp_extract", "rdp-extract.py")


class SyncTests(unittest.TestCase):
    def test_busy_operator_does_not_consume_document_retry_attempts(self):
        from unittest.mock import MagicMock
        child=MagicMock()
        child.communicate.return_value=(b"",b"AIBRAIN_RDP_ACCESS_FAILED: [Errno 11] Resource temporarily unavailable")
        child.returncode=1
        with patch.object(sync.subprocess,"Popen",return_value=child) as start:
            with self.assertRaises(BlockingIOError):
                sync.rdp_call({"connectionConfig":"/private/config","accessManifest":"/private/access"},"copy",r"Y:\Approved\file.pdf")
            self.assertEqual(start.call_count,1)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.imports = self.root / "imports"
        self.imports.mkdir()
        self.manifest = {"sourceRoots": [r"Y:\Approved"], "maxDepth": 3, "maxFiles": 10,
                         "maxFileBytes": 100000, "maxTotalBytes": 1000000, "state": self.state,
                         "importsRoot": self.imports, "publications": [], "connectionId": "test",
                         "installationId": "test", "appUid": os.getuid(), "appGid": os.getgid(),
                         "dataRootHost": str(self.root / "data")}
        self.copies = []
        self.fail_second = False
        self.private = patch.object(sync.rdp, "private_file", side_effect=Path)
        self.private.start()
        self.addCleanup(self.private.stop)

    def call(self, manifest, operation, source):
        if operation == "list":
            return {"truncated": False, "entries": [{"name": name, "directory": False, "bytes": 4,
                                                       "modifiedUtc": "2026-09-02T00:00:00Z"}
                                                      for name in ["first.txt", "second.txt"]]}
        if self.fail_second and source.endswith("second.txt"):
            raise ValueError("CONNECTION_INTERRUPTED")
        self.copies.append(source)
        file = self.imports / (str(len(self.copies)) + ".txt")
        file.write_bytes(b"test")
        digest = hashlib.sha256(b"test").hexdigest()
        return {"destination": str(file), "bytes": 4, "sha256": digest, "verifiedSha256": digest,
                "modifiedUtc": "2026-09-02T00:00:00Z", "recordedAt": "2026-09-02T01:00:00Z", "receipt": str(file) + ".json"}

    def extractor(self, source, suffix):
        return {"ok": True, "text": "Text del document"}

    def test_interrupted_run_resumes_verified_files_without_publishing_partial_inventory(self):
        self.fail_second = True
        with self.assertRaisesRegex(ValueError, "CONNECTION_INTERRUPTED"):
            sync.sync(self.manifest, self.call, self.extractor)
        self.assertEqual(len(self.copies), 1)
        self.assertFalse((self.state / "snapshot.json").exists())
        self.assertEqual(json.loads((self.state / "status.json").read_text())["state"], "failed")
        self.fail_second = False
        result = sync.sync(self.manifest, self.call, self.extractor)
        self.assertEqual(result["copied"], 1)
        self.assertEqual(result["reused"], 1)
        self.assertEqual(len(self.copies), 2)
        self.assertEqual(result["consecutiveFailures"], 0)

    def test_incomplete_inventory_keeps_previous_snapshot(self):
        sync.sync(self.manifest, self.call, self.extractor)
        old = (self.state / "snapshot.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "INCOMPLETE_INVENTORY"):
            sync.sync(self.manifest, lambda *_: {"truncated": True, "entries": []}, self.extractor)
        self.assertEqual((self.state / "snapshot.json").read_bytes(), old)
        self.assertEqual(len(self.copies), 2)

    def test_source_contention_preserves_snapshot_and_does_not_count_as_failure(self):
        previous=sync.sync(self.manifest,self.call,self.extractor)
        snapshot=(self.state/'snapshot.json').read_bytes()
        cache=(self.state/'cache.json').read_bytes()
        def busy(*args):raise BlockingIOError('RDP_OPERATOR_BUSY')
        with patch.object(sync,'refresh_public_status') as publication:
            result=sync.sync(self.manifest,busy,self.extractor)
        self.assertEqual(result['state'],'deferred')
        self.assertEqual(result['error'],'RDP_OPERATOR_BUSY')
        self.assertEqual(result['lastSuccess'],previous['lastSuccess'])
        self.assertEqual(result['consecutiveFailures'],previous['consecutiveFailures'])
        self.assertEqual((self.state/'snapshot.json').read_bytes(),snapshot)
        self.assertEqual((self.state/'cache.json').read_bytes(),cache)
        publication.assert_not_called()

    def test_contention_after_one_copy_retains_resumable_cache_without_partial_publication(self):
        def call(manifest,operation,source):
            if operation=='copy' and source.endswith('second.txt'):raise BlockingIOError('RDP_OPERATOR_BUSY')
            return self.call(manifest,operation,source)
        result=sync.sync(self.manifest,call,self.extractor)
        self.assertEqual(result['state'],'deferred')
        self.assertNotIn('lastSuccess',result)
        self.assertFalse((self.state/'snapshot.json').exists())
        self.assertEqual(len(json.loads((self.state/'cache.json').read_text())),1)
        result=sync.sync(self.manifest,self.call,self.extractor)
        self.assertEqual(result['reused'],1)
        self.assertEqual(result['copied'],1)

    def test_unchanged_run_does_not_copy_again(self):
        sync.sync(self.manifest, self.call, self.extractor)
        result = sync.sync(self.manifest, self.call, self.extractor)
        self.assertEqual(result["copied"], 0)
        self.assertEqual(result["reused"], 2)
        self.assertEqual(len(self.copies), 2)

    def test_corrupted_cached_original_is_recopied(self):
        sync.sync(self.manifest, self.call, self.extractor)
        next((self.state / "objects").glob("*/original")).write_bytes(b"evil")
        with self.assertRaisesRegex(ValueError, "CACHE_HASH_MISMATCH"):
            sync.sync(self.manifest, self.call, self.extractor)

    def test_audience_marker_must_match_installation_and_user(self):
        user = "00000000-0000-4000-8000-000000000001"
        audience = {"scope": "private", "scopeId": user}
        directory = Path(self.manifest["dataRootHost"]) / "enterprise-documents/users" / user / "private"
        directory.mkdir(parents=True, mode=0o700)
        marker = directory / ".aibrain-document-scope.json"
        marker.write_text(json.dumps({"schemaVersion": 1, "installationId": "other", "scope": "private", "userId": user}))
        with self.assertRaisesRegex(ValueError, "SCOPE_BINDING_MISMATCH"):
            sync.scope_directory(self.manifest, audience)
        marker.write_text(json.dumps({"schemaVersion": 1, "installationId": "test", "scope": "private", "userId": user}))
        self.assertEqual(sync.scope_directory(self.manifest, audience), directory)
        marker.unlink()
        marker.symlink_to(self.root / "outside")
        with self.assertRaisesRegex(ValueError, "SCOPE_NOT_PROVISIONED"):
            sync.scope_directory(self.manifest, audience)

    def test_chunks_preserve_unicode_and_content(self):
        text = "Àvia 👩‍💻 i informació\n" * 20000
        chunks = list(sync.text_chunks(text))
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(len(c.encode()) <= sync.CHUNK_BYTES for c in chunks))

    def test_published_text_contains_provenance_without_host_paths(self):
        sync.sync(self.manifest, self.call, self.extractor)
        snapshot = json.loads((self.state / "snapshot.json").read_text())
        content = sync.snapshot_files(self.manifest, snapshot["files"], [], snapshot["directories"], "now")
        text = content["Approved/first.txt/part-001.txt"]
        self.assertIn("SHA-256 original:", text)
        self.assertIn("Text del document", text)
        self.assertNotIn(str(self.root), text)

    def test_source_change_during_copy_is_rejected(self):
        def changed(*args):
            value = self.call(*args)
            if args[1] == "copy":
                value["modifiedUtc"] = "2026-09-03T00:00:00Z"
            return value
        with self.assertRaisesRegex(ValueError, "SOURCE_CHANGED_DURING_SYNC"):
            sync.sync(self.manifest, changed, self.extractor)
        self.assertFalse((self.state / "snapshot.json").exists())


class ExtractionTests(unittest.TestCase):
    def test_docx_preserves_paragraphs_and_rejects_entities(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "document.docx"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Primer</w:t></w:r></w:p><w:p><w:r><w:t>Segon</w:t></w:r></w:p></w:document>')
            self.assertEqual(extract.extract(source, ".docx"), "Primer\nSegon")
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("word/document.xml", '<!DOCTYPE root [<!ENTITY x "boom">]><root>&x;</root>')
            with self.assertRaisesRegex(ValueError, "XML_ENTITY_REJECTED"):
                extract.extract(source, ".docx")

    def test_credentials_and_binary_content_are_not_published(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "document.txt"
            for raw in [b"password=abcdefghijklmnopqrstuv", b"hello\x00world"]:
                source.write_bytes(raw)
                with self.assertRaises(ValueError):
                    extract.extract(source, ".txt")


if __name__ == "__main__":
    unittest.main()
