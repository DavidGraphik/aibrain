import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import test_knowledge_generation_policy as fixtures

spec = importlib.util.spec_from_file_location('scheduler', Path(__file__).resolve().parents[2] / 'infra/hetzner/knowledge-generation-scheduler.py')
scheduler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scheduler)


class SchedulerTests(unittest.TestCase):
    setUp = fixtures.GenerationPolicyTests.setUp
    tearDown = fixtures.GenerationPolicyTests.tearDown
    write = fixtures.GenerationPolicyTests.write

    def sweep(self, **options):
        return scheduler.sweep(self.engine, self.adapter, **options)

    def test_real_policy_budget_survives_restart_and_resets_only_on_later_day(self):
        self.assertEqual(self.sweep(max_daily_calls=1, day='2026-09-12')['dispatched'], 1)
        self.assertEqual(self.sweep(max_daily_calls=1, day='2026-09-12')['dispatched'], 0)
        self.assertEqual(self.sweep(max_daily_calls=1, day='2026-09-11')['dispatched'], 0)
        result = self.sweep(max_daily_calls=1, day='2026-09-13')
        self.assertEqual((result['dispatched'], result['complete']), (1, 1))

    def test_preview_checks_authorization_without_state_or_dispatch(self):
        result = self.sweep(preview=True)
        self.assertEqual(result['visited'], 1)
        self.assertEqual(self.adapter.calls, [])
        self.assertFalse((self.root / 'generation-runtime').exists())

    def test_disabled_policy_does_not_create_runtime_state(self):
        self.value['enabled'] = False
        self.write()
        with self.assertRaisesRegex(ValueError, 'GENERATION_DISABLED_OR_EXPIRED'):
            self.sweep()
        self.assertFalse((self.root / 'generation-runtime').exists())

    def test_process_loss_consumes_reservation_and_does_not_redispatch(self):
        self.adapter.generate = lambda *args: (_ for _ in ()).throw(KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            self.sweep(max_daily_calls=1)
        self.assertEqual(self.sweep(max_daily_calls=1)['dispatched'], 0)

    def test_second_scheduler_yields_to_the_installation_lock(self):
        original = self.adapter.generate
        def generate(*args):
            self.assertEqual(self.sweep()['status'], 'busy')
            return original(*args)
        self.adapter.generate = generate
        self.assertEqual(self.sweep()['dispatched'], 1)

    def test_foreign_or_symlinked_state_is_rejected(self):
        self.sweep()
        file = self.root / 'generation-runtime/state.json'
        state = json.loads(file.read_text())
        state['installationId'] = 'other'
        file.write_text(json.dumps(state))
        with self.assertRaisesRegex(ValueError, 'INVALID_SCHEDULER_STATE'):
            self.sweep()
        file.unlink()
        file.symlink_to(self.policy_file)
        before = self.policy_file.read_bytes()
        with self.assertRaises(OSError):
            self.sweep()
        self.assertEqual(before, self.policy_file.read_bytes())

    def test_fair_cursor_progresses_past_revoked_job_without_leaking_error(self):
        jobs = ['1' * 64, '2' * 64, '3' * 64]
        snapshot = {**self.value, 'grants': [{'jobId': job} for job in jobs]}
        calls = []
        def run_step(job, adapter):
            calls.append(job)
            if job == jobs[0]:
                raise ValueError('private document and secret-shaped detail')
            return {'state': 'ready'}
        with patch.object(self.engine, 'snapshot', return_value=snapshot), patch.object(self.engine, 'run_step', side_effect=run_step):
            for _ in range(4):
                report = self.sweep(max_steps=1)
                self.assertNotIn('private', str(report))
        self.assertEqual(calls, jobs + [jobs[0]])


if __name__ == '__main__':
    unittest.main()
