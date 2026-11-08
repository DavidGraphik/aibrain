import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("storage_pressure", Path(__file__).with_name("storage-pressure.py"))
pressure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pressure)


class StoragePressureTests(unittest.TestCase):
    def setUp(self):
        self.reading = {"free_bytes": 20 * pressure.GIB, "free_inode_percent": 80}
        self.measure = patch.object(pressure, "measure", return_value=self.reading).start()
        self.load = patch.object(pressure, "load_state", return_value={}).start()
        self.save = patch.object(pressure, "save_state").start()
        self.busy = patch.object(pressure, "maintenance_busy", return_value=False).start()
        self.run = patch.object(pressure.subprocess, "run", return_value=SimpleNamespace(returncode=0)).start()
        self.addCleanup(patch.stopall)

    def test_no_cleanup_on_healthy_disk(self):
        self.assertEqual(pressure.evaluate(15)["status"], "healthy")
        self.run.assert_not_called()
        self.busy.assert_not_called()

    def test_bytes_pressure_requests_existing_unit_and_reports_recovery(self):
        self.measure.side_effect = [dict(self.reading, free_bytes=2 * pressure.GIB), self.reading]
        report = pressure.evaluate(15)
        self.assertEqual(report["status"], "recovered")
        self.assertEqual(self.run.call_args.args[0], ["systemctl", "start", "--wait", pressure.SERVICE])

    def test_inode_pressure_with_available_bytes(self):
        self.reading["free_inode_percent"] = 1
        self.assertEqual(pressure.evaluate(15)["status"], "insufficient_safe_reclaim")
        self.run.assert_called_once()

    def test_insufficient_reclaim_never_reports_success(self):
        self.reading["free_bytes"] = 3 * pressure.GIB
        self.assertEqual(pressure.evaluate(10)["status"], "insufficient_safe_reclaim")

    def test_active_deployment_is_deferred(self):
        self.reading["free_bytes"] = pressure.GIB
        self.busy.return_value = True
        self.assertEqual(pressure.evaluate(10)["status"], "deferred_storage_lock")
        self.run.assert_not_called()

    def test_unresolved_pressure_is_rate_limited(self):
        self.reading["free_bytes"] = 3 * pressure.GIB
        self.load.return_value = {"last_attempt": pressure.time.time() - 600}
        self.assertEqual(pressure.evaluate(10)["status"], "deferred_cooldown")
        self.run.assert_not_called()

    def test_critical_pressure_can_retry_after_five_minutes(self):
        self.reading["free_bytes"] = pressure.GIB // 2
        self.load.return_value = {"last_attempt": pressure.time.time() - 600}
        self.assertEqual(pressure.evaluate(10)["status"], "insufficient_safe_reclaim")
        self.run.assert_called_once()

    def test_future_or_malformed_attempt_cannot_disable_maintenance(self):
        self.reading["free_bytes"] = 3 * pressure.GIB
        for value in ["bad", pressure.time.time() + 600]:
            with self.subTest(value=value):
                self.load.return_value = {"last_attempt": value}
                self.assertEqual(pressure.evaluate(10)["status"], "insufficient_safe_reclaim")

    def test_check_mode_never_writes_or_requests_cleanup(self):
        self.reading["free_bytes"] = pressure.GIB
        self.assertEqual(pressure.evaluate(10, check_only=True)["status"], "pressure_detected")
        self.run.assert_not_called()
        self.save.assert_not_called()
        self.busy.assert_not_called()

    def test_failed_maintenance_is_visible(self):
        self.reading["free_bytes"] = pressure.GIB
        self.run.return_value = SimpleNamespace(returncode=1)
        self.assertEqual(pressure.evaluate(10)["status"], "maintenance_failed")

    def test_timeout_never_kills_maintenance(self):
        self.reading["free_bytes"] = pressure.GIB
        self.run.side_effect = pressure.subprocess.TimeoutExpired("systemctl", 420)
        self.assertEqual(pressure.evaluate(10)["status"], "maintenance_unavailable")
        self.run.assert_called_once()


if __name__ == "__main__":
    unittest.main()
