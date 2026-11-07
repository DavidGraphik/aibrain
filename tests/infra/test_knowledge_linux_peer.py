"""Real Linux Unix-peer authentication using only a temporary fictional socket."""
import importlib.util
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest

spec=importlib.util.spec_from_file_location("broker",Path(__file__).resolve().parents[2]/"infra/hetzner/knowledge-broker.py")
broker=importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


@unittest.skipUnless(sys.platform=='linux',"SO_PEERCRED requires Linux")
class LinuxPeerTests(unittest.TestCase):
    def test_kernel_peer_identity_is_required_and_cannot_be_forged_in_request(self):
        with tempfile.TemporaryDirectory(prefix="aibrain-peer-") as directory:
            root=Path(directory)
            manifest={"appUid":os.geteuid()}
            # No listener thread, host manifest, real partition or persistent
            # service. The test exercises kernel credentials on an accepted fd.
            with broker.Server(root/"test.sock",manifest,root/"unused.json",root) as server:
                with socket.socket(socket.AF_UNIX) as client:
                    client.connect(str(root/"test.sock"))
                    connection,address=server.get_request()
                    with connection:
                        self.assertTrue(server.verify_request(connection,address))
                        manifest["appUid"]=os.geteuid()+1
                        client.sendall(b'{"appUid":0,"audiences":[{"scope":"company","scopeId":null}]}\n')
                        self.assertFalse(server.verify_request(connection,address))


if __name__=='__main__':
    unittest.main()
