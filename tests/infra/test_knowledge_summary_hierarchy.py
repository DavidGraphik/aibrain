import json
import unittest
import test_knowledge_summary_worker as fixtures

worker = fixtures.worker


class HierarchyTests(unittest.TestCase):
    tearDown = fixtures.WorkerTests.tearDown
    new_worker = fixtures.WorkerTests.new_worker

    def setUp(self):
        fixtures.WorkerTests.setUp(self)
        segments = [{'locator': f'line:{i}', 'content': f'Exception {i}: approval remains required. ' + 'Fictional evidence. ' * 130}
                    for i in range(1, 71)]
        self.store.index_document(self.document['source'], self.document['fingerprint'], 'a' * 64, segments,
                                  structured={'ok': True, 'segments': segments, 'tables': [], 'warnings': []})
        self.plan = self.engine.engine.prepare(self.document['source'], 4000)
        self.job = self.plan['jobId']
        self.assertEqual(len(self.plan['parts']), 70)
        for part in self.plan['parts']:
            unit = part['units'][0]
            self.engine.engine.save_part(self.job, part['id'], [
                {'text': f'Qualification {i}: ' + 'A fictional qualification. ' * 48,
                 'citations': [{'unitId': unit['id'], 'quote': unit['content'][:38]}]} for i in range(4)])
        self.engine.enqueue(self.job)
        self.calls = []
        def generate(request, key, timeout):
            self.calls.append((request, key))
            last = request['data']['groups'][-1]['claims'][-1]
            return {'claims': [{'text': 'The last cited exception still requires approval.', 'references': last['references']}]}
        self.adapter.generate = generate

    def test_large_summary_reduces_multiple_levels_resumes_and_keeps_original_citation(self):
        self.assertGreater(len(json.dumps(self.engine.engine.load(self.job)[2]).encode()), 256 * 1024)
        for _ in range(20):
            self.engine = self.new_worker()
            result = self.engine.step(self.job, self.adapter)
            if result['state'] == 'complete':
                break
            self.assertEqual(result['state'], 'ready')
        self.assertEqual(result['state'], 'complete')
        self.assertEqual(len(self.calls), 11)
        self.assertEqual(len({key for _, key in self.calls}), len(self.calls))
        self.assertTrue(any(request['stage'].startswith('reduce:2:') for request, _ in self.calls))
        self.assertTrue(all(len(json.dumps(request).encode()) <= 256 * 1024 for request, _ in self.calls))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM summary_reductions WHERE job=?', (self.job,)).fetchone()[0], 10)
        record = self.store.db.execute('SELECT status FROM knowledge_records').fetchone()
        self.assertEqual(record['status'], 'proposed')
        citation = self.store.db.execute('SELECT locator FROM knowledge_dependencies').fetchone()
        self.assertEqual(citation['locator'], 'line:70')
        coverage = json.loads(self.store.db.execute('SELECT coverage FROM summary_jobs WHERE id=?', (self.job,)).fetchone()[0])
        self.assertEqual(coverage['processedParts'], 70)
        self.assertIn('Hierarchical synthesis', coverage['boundary'])
        self.engine.step(self.job, self.adapter)
        self.assertEqual(len(self.calls), 11)

    def test_reference_to_a_part_outside_the_reduction_group_is_rejected(self):
        self.adapter.generate = lambda *args: {'claims': [{'text': 'Unsupported selection.', 'references': [{'partId': '70', 'claimIndex': 0}]}]}
        result = self.engine.step(self.job, self.adapter)
        self.assertEqual(result['state'], 'blocked')
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM summary_reductions').fetchone()[0], 0)

    def test_reduction_and_checkpoint_are_atomic(self):
        self.store.db.execute("CREATE TRIGGER fail_reduction_checkpoint BEFORE UPDATE ON summary_execution WHEN NEW.state='ready' BEGIN SELECT RAISE(ABORT,'fixture'); END")
        self.assertEqual(self.engine.step(self.job, self.adapter)['state'], 'blocked')
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM summary_reductions').fetchone()[0], 0)

    def test_changed_reduction_inputs_block_before_another_dispatch(self):
        self.engine.step(self.job, self.adapter)
        self.store.db.execute("UPDATE summary_reductions SET input_hash='corrupt'")
        with self.assertRaisesRegex(ValueError, 'REDUCTION_INPUT_CHANGED'):
            self.engine.step(self.job, self.adapter)
        self.assertEqual(len(self.calls), 1)

    def test_revocation_during_reduction_does_not_save_a_checkpoint(self):
        generate = self.adapter.generate
        def revoke(*args):
            result = generate(*args)
            self.permitted = False
            return result
        self.adapter.generate = revoke
        self.assertEqual(self.engine.step(self.job, self.adapter)['state'], 'blocked')
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM summary_reductions').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
