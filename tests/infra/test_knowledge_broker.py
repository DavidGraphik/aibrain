import importlib.util
from pathlib import Path
import unittest
import os
import tempfile
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("broker",Path(__file__).resolve().parents[2]/"infra/hetzner/knowledge-broker.py")
broker=importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class BrokerTests(unittest.TestCase):
    def test_socket_directory_retains_app_group_traversal_under_private_umask(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary).resolve()/"knowledge"
            secure=broker.files.sync.secure_dir
            previous=os.umask(0o077)
            try:
                with patch.object(broker.os,'chown'),patch.object(broker.files.sync,'secure_dir',side_effect=lambda p:secure(p,owner=os.geteuid())):
                    broker.prepare_socket_directory(directory,os.getegid())
                self.assertEqual(directory.stat().st_mode&0o777,0o750)
            finally:
                os.umask(previous)

    def setUp(self):
        self.manifest={"installationId":"test","connectionId":"arnall","appUid":10001}
        self.value={"schemaVersion":1,"installationId":"test","connectionId":"arnall","requestId":"12345678-1234-4234-9234-123456789abc",
                    "operation":"search","audiences":[{"scope":"company","scopeId":None}],"input":{"query":"contrato","limit":20}}
        self.bindings={"schemaVersion":1,"installationId":"test","rules":[]}

    def test_protocol_rejects_foreign_installation_injected_operation_and_arguments(self):
        self.assertTrue(broker.validate_request(self.value,self.manifest))
        for value in [{**self.value,"installationId":"other"},{**self.value,"operation":"shell"},
                      {**self.value,"input":{"query":"x","limit":100}},
                      {**self.value,"audiences":[{"scope":"operator","scopeId":None}]},
                      {**self.value,"input":{"query":"x","limit":1,"path":"/etc/passwd"}}]:
            self.assertFalse(broker.validate_request(value,self.manifest))

    def test_unconfigured_scope_is_denied_before_any_storage_or_marker_read(self):
        with patch.object(broker.files.sync,"scope_directory") as scope, patch.object(broker.retrieval,"Retrieval") as storage:
            result=broker.execute(self.value,self.manifest,self.bindings,Path("/missing"))
            self.assertEqual(result["error"],"SCOPE_UNAVAILABLE")
            scope.assert_not_called()
            storage.assert_not_called()

    def test_scope_marker_is_validated_before_index_open(self):
        self.bindings["rules"]=[{"sourceRoot":"Y:\\","audience":self.value["audiences"][0]}]
        with patch.object(broker.files.sync,"scope_directory",side_effect=ValueError("SCOPE_BINDING_MISMATCH")), patch.object(broker.retrieval,"Retrieval") as storage:
            with self.assertRaisesRegex(ValueError,"SCOPE_BINDING_MISMATCH"):
                broker.execute(self.value,self.manifest,self.bindings,Path("/missing"))
            storage.assert_not_called()


if __name__=="__main__":
    unittest.main()
