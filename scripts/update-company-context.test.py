import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name('update-company-context.py')

class ContextPublicationTests(unittest.TestCase):
    def test_plan_conflict_preservation_idempotence_and_rollback(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=pathlib.Path(temporary).resolve()
            root, source, revisions=[base / p for p in ['context','bundle','revisions']]
            for p in [root,source,revisions]: p.mkdir(mode=0o700)
            (root/'PERMISSIONS.md').write_text('policy-unchanged')
            (root/'20_COMPANY.md').write_text('old-company')
            (source/'20_COMPANY.md').write_text('new-company')
            (source/'knowledge').mkdir()
            (source/'knowledge'/'APP.md').write_text('shared-app-guide')
            command=[sys.executable,str(SCRIPT),'--root',str(root),'--source',str(source),'--revisions',str(revisions)]
            def run(*args): return subprocess.run(command+list(args),capture_output=True,text=True)
            plan=json.loads(run().stdout)
            failed=run('--apply','--expected','wrong')
            self.assertNotEqual(failed.returncode,0)
            self.assertEqual((root/'20_COMPANY.md').read_text(),'old-company')
            applied=run('--apply','--expected',plan['fingerprint'])
            self.assertEqual(applied.returncode,0,applied.stderr)
            receipt=json.loads(applied.stdout)
            self.assertTrue(receipt['verified'])
            self.assertEqual((root/'PERMISSIONS.md').read_text(),'policy-unchanged')
            self.assertEqual(json.loads(run().stdout)['changes'],[])
            backup=revisions/receipt['revision']/'before'/'20_COMPANY.md'
            backup.write_text('corrupted')
            self.assertNotEqual(run('--rollback',receipt['revision'],'--apply').returncode,0)
            self.assertEqual((root/'20_COMPANY.md').read_text(),'new-company')
            backup.write_text('old-company')
            (root/'20_COMPANY.md').write_text('concurrent-edit')
            self.assertNotEqual(run('--rollback',receipt['revision'],'--apply').returncode,0)
            (root/'20_COMPANY.md').write_text('new-company')
            restored=run('--rollback',receipt['revision'],'--apply')
            self.assertEqual(restored.returncode,0,restored.stderr)
            self.assertEqual((root/'20_COMPANY.md').read_text(),'old-company')
            self.assertFalse((root/'knowledge'/'APP.md').exists())
            (source/'PERMISSIONS.md').write_text('must-never-publish')
            self.assertNotEqual(run().returncode,0)
            (source/'PERMISSIONS.md').unlink()
            (source/'alias.md').symlink_to(root/'20_COMPANY.md')
            self.assertNotEqual(run().returncode,0)

if __name__ == '__main__': unittest.main()
