import importlib.util
from pathlib import Path
import unittest
import test_knowledge_derived as fixtures

spec=importlib.util.spec_from_file_location('summary',Path(__file__).resolve().parents[2]/'infra/hetzner/knowledge-summary.py')
summary=importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


class SummaryTests(unittest.TestCase):
    setUp=fixtures.DerivedTests.setUp
    tearDown=fixtures.DerivedTests.tearDown

    def engine(self):
        return summary.Summary(self.store)

    def claims(self,part):
        unit=next(u for u in part['units'] if u['content'].strip())
        return [{'text':'Propuesta de resumen de la sección.','citations':[{'unitId':unit['id'],'quote':unit['content'][:100]}]}]

    def test_every_part_is_required_and_progress_resumes(self):
        segments=[{'locator':f'line:{i}','content':f'Sección {i}. '+('Contenido ficticio. '*160)} for i in range(1,11)]
        self.store.index_document(self.document['source'],self.document['fingerprint'],'a'*64,segments,
                                 structured={'ok':True,'segments':segments,'tables':[],'warnings':[]})
        engine=self.engine()
        plan=engine.prepare(self.document['source'],4000)
        self.assertGreater(len(plan['parts']),3)
        self.assertEqual(''.join(u['content'] for p in plan['parts'] for u in p['units']),''.join(s['content'] for s in segments))
        first=plan['parts'][0]
        engine.save_part(plan['jobId'],first['id'],self.claims(first))
        with self.assertRaisesRegex(ValueError,'SUMMARY_PARTS_INCOMPLETE'):
            engine.finalize(plan['jobId'],[{'text':'Resumen ficticio.','references':[{'partId':'1','claimIndex':0}]}])
        engine=self.engine()
        self.assertEqual(len(engine.load(plan['jobId'])[2]),1)
        for part in plan['parts'][1:]:
            engine.save_part(plan['jobId'],part['id'],self.claims(part))
        result=engine.finalize(plan['jobId'],[{'text':'Resumen ficticio.','references':[{'partId':plan['parts'][-1]['id'],'claimIndex':0}]}])
        self.assertEqual(result['record']['status'],'proposed')
        self.assertEqual(result['coverage']['processedParts'],len(plan['parts']))
        self.assertEqual(result['record']['citations'][0]['locator'],'line:10')

    def test_tables_and_extraction_warnings_are_included(self):
        self.payload['warnings']=[{'code':'PAGE_WITHOUT_READABLE_TEXT','locator':'page:4'}]
        self.store.index_document(self.document['source'],self.document['fingerprint'],'a'*64,self.segments,structured=self.payload)
        plan=self.engine().prepare(self.document['source'])
        units=[u for p in plan['parts'] for u in p['units']]
        self.assertTrue(any(u['locator']=='csv:row:3:column:2' and u['content']=='2,50' for u in units))
        self.assertEqual(plan['warnings'],self.payload['warnings'])

    def test_fabricated_quotes_and_changed_part_replays_are_rejected(self):
        engine=self.engine();plan=engine.prepare(self.document['source'])
        claims=self.claims(plan['parts'][0])
        claims[0]['citations'][0]['quote']='Nonexistent evidence'
        with self.assertRaisesRegex(ValueError,'SUMMARY_QUOTE_OUTSIDE_PART'):
            engine.save_part(plan['jobId'],'1',claims)
        claims=self.claims(plan['parts'][0]);engine.save_part(plan['jobId'],'1',claims)
        engine.save_part(plan['jobId'],'1',claims)
        claims[0]['text']='Altered semantic draft'
        with self.assertRaisesRegex(ValueError,'SUMMARY_PART_ALREADY_SUBMITTED'):
            engine.save_part(plan['jobId'],'1',claims)

    def test_source_withdrawal_and_rejected_summary_do_not_revive(self):
        engine=self.engine();plan=engine.prepare(self.document['source'])
        engine.save_part(plan['jobId'],'1',self.claims(plan['parts'][0]))
        claims=[{'text':'Resumen ficticio.','references':[{'partId':'1','claimIndex':0}]}]
        result=engine.finalize(plan['jobId'],claims)
        self.memory.review(result['record']['id'],1,'reject',fixtures.ACTOR,lambda _:True)
        self.assertEqual(engine.finalize(plan['jobId'],claims)['record']['status'],'rejected')
        self.store.withdraw(self.document['source'],'ACCESS_REVOKED')
        with self.assertRaisesRegex(ValueError,'SUMMARY_SOURCE_UNAVAILABLE'):
            engine.load(plan['jobId'])

    def test_same_source_hash_with_revised_extraction_invalidates_old_plan(self):
        engine=self.engine();plan=engine.prepare(self.document['source'])
        payload={**self.payload,'warnings':[{'code':'NEW_EXTRACTION_WARNING'}]}
        self.store.index_document(self.document['source'],self.document['fingerprint'],'a'*64,self.segments,structured=payload)
        with self.assertRaisesRegex(ValueError,'SUMMARY_EXTRACTION_CHANGED'):
            engine.save_part(plan['jobId'],'1',self.claims(plan['parts'][0]))

    def test_cross_part_citation_is_denied_even_when_it_exists_in_document(self):
        segments=[{'locator':f'line:{i}','content':str(i)+' contenido. '*290} for i in range(1,4)]
        self.store.index_document(self.document['source'],self.document['fingerprint'],'a'*64,segments,
            structured={'ok':True,'segments':segments,'tables':[],'warnings':[]})
        engine=self.engine();plan=engine.prepare(self.document['source'],4000)
        claims=self.claims(plan['parts'][-1])
        with self.assertRaisesRegex(ValueError,'SUMMARY_QUOTE_OUTSIDE_PART'):
            engine.save_part(plan['jobId'],'1',claims)


if __name__=='__main__':
    unittest.main()
