import importlib.util
import json
import os
import tempfile
from types import SimpleNamespace
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('knowledge_run_test', ROOT / 'infra/hetzner/knowledge-generation-run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunTests(unittest.TestCase):
    def setUp(self):
        self.config = {'schemaVersion': 1, 'manifest': '/private/manifest', 'bindings': '/private/bindings',
            'policy': '/private/policy', 'codexBinary': '/opt/codex', 'employeeId': 'employee-a',
            'chatgptAccountId': 'selected-account', 'maxSteps': 4, 'maxDailyCalls': 32, 'seconds': 240}
        self.manifest = {'installationId': 'company-a', 'connectionId': 'rdp-a',
                         'dataRootHost': '/var/lib/docker/volumes/company-a/_data', 'appUid': 1001}

    def run_with(self, execute=False):
        with patch.object(runner.os, 'geteuid', return_value=0), \
             patch.object(runner.policy_module, 'GenerationPolicy') as policy_class, \
             patch.object(runner.policy_module, 'private_json', return_value=self.config), \
             patch.object(runner, 'operator_installation_json', return_value={'installationId': 'company-a'}), \
             patch.object(runner.policy_module.files.sync, 'load_manifest', return_value=self.manifest), \
             patch.object(runner.scheduler, 'sweep') as sweep, \
             patch.object(runner.codex, 'access_token', return_value={'fixture': True}) as token:
            runner.run('/private/config', execute)
            token.assert_not_called()
            self.assertEqual(sweep.call_args.kwargs, {'max_steps': 4, 'max_daily_calls': 32, 'seconds': 240, 'preview': not execute})
            policy, adapter = sweep.call_args.args
            self.assertIs(policy, policy_class.return_value)
            policy_class.assert_called_once_with(Path('/var/lib/aibrain/knowledge/company-a'), self.manifest,
                                                  '/private/bindings', '/private/policy')
            adapter.token_supplier()
            token.assert_called_once_with(Path('/var/lib/docker/volumes/company-a/_data/users/employee-a/runtime/codex-home/auth.json'),
                                          'selected-account', 1001)

    def test_default_preview_does_not_read_auth(self): self.run_with()

    def test_execution_preserves_exact_account_installation_and_limits(self): self.run_with(True)

    def test_budgeted_installation_blocks_before_auth_or_model_dispatch(self):
        installation = {'installationId': 'company-a', 'usageLimits': {'weeklyTokens': 7500000, 'timeZone': 'Europe/Madrid'}}
        with patch.object(runner.os, 'geteuid', return_value=0), \
             patch.object(runner.policy_module, 'private_json', return_value=self.config), \
             patch.object(runner, 'operator_installation_json', return_value=installation), \
             patch.object(runner.policy_module.files.sync, 'load_manifest', return_value=self.manifest), \
             patch.object(runner.scheduler, 'sweep') as sweep, \
             patch.object(runner.codex, 'access_token') as token:
            with self.assertRaisesRegex(ValueError, 'GENERATION_WEEKLY_TOKEN_BUDGET_UNSUPPORTED'):
                runner.run('/private/config', True)
            sweep.assert_not_called()
            token.assert_not_called()

    def test_missing_or_foreign_installation_policy_does_not_bypass_budget(self):
        for installation in ({}, {'installationId': 'company-b'}):
            with self.subTest(installation=installation), \
                 patch.object(runner, 'operator_installation_json', return_value=installation):
                with self.assertRaisesRegex(ValueError, 'GENERATION_INSTALLATION_MISMATCH'):
                    runner.assert_no_weekly_token_budget(self.manifest)
        with patch.object(runner, 'operator_installation_json', side_effect=FileNotFoundError):
            with self.assertRaises(FileNotFoundError):
                runner.assert_no_weekly_token_budget(self.manifest)

    def test_arbitrary_auth_path_and_employee_traversal_rejected(self):
        for change in ({'authPath': '/other/auth.json'}, {'employeeId': '../other'}, {'chatgptAccountId': ''}):
            with self.subTest(change=change), patch.dict(self.config, change), \
                 patch.object(runner.os, 'geteuid', return_value=0), \
                 patch.object(runner.policy_module, 'private_json', return_value=self.config), \
                 patch.object(runner.scheduler, 'sweep') as sweep:
                with self.assertRaises(ValueError): runner.run('/private/config', True)
                sweep.assert_not_called()

    def test_non_operator_denied_before_config_read(self):
        with patch.object(runner.os, 'geteuid', return_value=1000), patch.object(runner.policy_module, 'private_json') as read:
            with self.assertRaises(ValueError): runner.run('/private/config')
            read.assert_not_called()


class OperatorConfigTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='aibrain-operator-config-')
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name).resolve() / 'installation.json'
        self.path.write_text(json.dumps({'installationId': 'company-a'}))
        self.path.chmod(0o644)
        self.real_fstat = os.fstat

    def root_metadata(self, descriptor, uid=0):
        actual = self.real_fstat(descriptor)
        return SimpleNamespace(st_mode=actual.st_mode, st_uid=uid, st_nlink=actual.st_nlink)

    def test_accepts_root_owned_readable_operator_config(self):
        for mode in (0o440, 0o600, 0o640, 0o644):
            with self.subTest(mode=oct(mode)):
                self.path.chmod(mode)
                with patch.object(runner.os, 'fstat', side_effect=self.root_metadata):
                    self.assertEqual(runner.operator_installation_json(self.path), {'installationId': 'company-a'})

    def test_rejects_group_or_world_writable_config(self):
        for mode in (0o664, 0o646, 0o666):
            with self.subTest(mode=oct(mode)):
                self.path.chmod(mode)
                with patch.object(runner.os, 'fstat', side_effect=self.root_metadata):
                    with self.assertRaisesRegex(ValueError, 'GENERATION_INSTALLATION_CONFIG_UNSAFE'):
                        runner.operator_installation_json(self.path)

    def test_rejects_non_root_owner(self):
        with patch.object(runner.os, 'fstat', side_effect=lambda fd: self.root_metadata(fd, uid=1000)):
            with self.assertRaisesRegex(ValueError, 'GENERATION_INSTALLATION_CONFIG_UNSAFE'):
                runner.operator_installation_json(self.path)

    def test_rejects_symlink_and_multiple_links(self):
        link = self.path.with_name('link.json')
        link.symlink_to(self.path)
        with self.assertRaisesRegex(ValueError, 'GENERATION_INSTALLATION_CONFIG_UNSAFE'):
            runner.operator_installation_json(link)
        link.unlink()
        os.link(self.path, link)
        with patch.object(runner.os, 'fstat', side_effect=self.root_metadata):
            with self.assertRaisesRegex(ValueError, 'GENERATION_INSTALLATION_CONFIG_UNSAFE'):
                runner.operator_installation_json(self.path)

    def test_rejects_non_regular_file_without_blocking(self):
        self.path.unlink()
        os.mkfifo(self.path, 0o600)
        with patch.object(runner.os, 'fstat', side_effect=self.root_metadata):
            with self.assertRaisesRegex(ValueError, 'GENERATION_INSTALLATION_CONFIG_UNSAFE'):
                runner.operator_installation_json(self.path)

    def test_rejects_invalid_or_oversized_json(self):
        for text, error in (('not JSON', json.JSONDecodeError), (' ' * (1024 * 1024 + 1), ValueError)):
            with self.subTest(error=error):
                self.path.write_text(text)
                with patch.object(runner.os, 'fstat', side_effect=self.root_metadata):
                    with self.assertRaises(error):
                        runner.operator_installation_json(self.path)

    def test_real_readable_config_enforces_budget_and_installation_binding(self):
        real_reader = runner.operator_installation_json
        for value, expected in (
            ({'installationId': 'company-a'}, None),
            ({'installationId': 'company-b'}, 'GENERATION_INSTALLATION_MISMATCH'),
            ({'installationId': 'company-a', 'usageLimits': {'weeklyTokens': 7500000}},
             'GENERATION_WEEKLY_TOKEN_BUDGET_UNSUPPORTED'),
        ):
            with self.subTest(value=value):
                self.path.write_text(json.dumps(value))
                with patch.object(runner.os, 'fstat', side_effect=self.root_metadata), \
                     patch.object(runner, 'operator_installation_json', side_effect=lambda _: real_reader(self.path)) as read:
                    if expected:
                        with self.assertRaisesRegex(ValueError, expected):
                            runner.assert_no_weekly_token_budget({'installationId': 'company-a'})
                    else:
                        runner.assert_no_weekly_token_budget({'installationId': 'company-a'})
                    read.assert_called_once_with(Path('/etc/aibrain/company-a/installation.json'))


if __name__ == '__main__': unittest.main()
