import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("broker", Path(__file__).resolve().parents[2] / "infra/hetzner/rdp-sync-broker.py")
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.manifest = {"installationId": "test", "connectionId": "arnall", "state": Path(self.temp.name)}
        patcher = patch.object(broker.sync.rdp, "private_file", side_effect=Path)
        patcher.start()
        self.addCleanup(patcher.stop)

    def coordinator(self, run, **kwargs):
        value = broker.Coordinator(self.manifest, run=run, **kwargs)
        self.addCleanup(value.executor.shutdown)
        return value

    def test_request_cannot_select_another_installation_path_or_command(self):
        valid = {"schemaVersion": 1, "operation": "refresh", "requestId": "00000000-0000-4000-8000-000000000001",
                 "installationId": "test", "connectionId": "arnall"}
        self.assertTrue(broker.validate_request(valid, self.manifest))
        for changed in [dict(valid, installationId="other"), dict(valid, connectionId="other"),
                        dict(valid, path=r"C:\Secrets"), dict(valid, operation="powershell"), dict(valid, requestId="invalid")]:
            self.assertFalse(broker.validate_request(changed, self.manifest))

    def test_concurrent_requests_share_one_job_and_get_independent_results(self):
        started, release = threading.Event(), threading.Event()
        calls = []
        def run():
            calls.append(1)
            started.set()
            release.wait(2)
            return {"state": "failed", "checkedAt": None}
        coordinator = self.coordinator(run)
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(coordinator.refresh)
            self.assertTrue(started.wait(1))
            second = pool.submit(coordinator.refresh)
            release.set()
            a, b = first.result(), second.result()
        self.assertEqual(len(calls), 1)
        a["requestId"] = "one"
        self.assertNotIn("requestId", b)
        self.assertEqual(coordinator.refresh()["state"], "failed")
        self.assertEqual(len(calls), 1)

    def test_recent_success_is_reused_but_stale_success_runs_again(self):
        status = self.manifest["state"] / "status.json"
        status.write_text(json.dumps({"state": "ready", "lastSuccess": dt.datetime.now(dt.timezone.utc).isoformat(), "documents": 6}))
        calls = []
        coordinator = self.coordinator(lambda: calls.append(1) or {"state": "current", "checkedAt": "now"})
        self.assertEqual(coordinator.refresh()["documents"], 6)
        self.assertEqual(calls, [])
        status.write_text(json.dumps({"state": "ready", "lastSuccess": "2000-01-01T00:00:00+00:00"}))
        coordinator.refresh()
        self.assertEqual(calls, [1])

    def test_wait_timeout_does_not_cancel_ongoing_sync(self):
        release = threading.Event()
        def run():
            release.wait(2)
            return {"state": "failed", "checkedAt": None}
        coordinator = self.coordinator(run, wait_seconds=0.01)
        try:
            self.assertEqual(coordinator.refresh()["state"], "pending")
            self.assertFalse(coordinator.future.cancelled())
        finally:
            release.set()


if __name__ == "__main__":
    unittest.main()
