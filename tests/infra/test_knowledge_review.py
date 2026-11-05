import importlib.util
from pathlib import Path
import unittest
import uuid
import os
import json
import socket
import threading
from unittest.mock import patch
import test_knowledge_retrieval as fixtures

spec=importlib.util.spec_from_file_location('review',Path(__file__).resolve().parents[2]/'infra/hetzner/knowledge-review.py')
review=importlib.util.module_from_spec(spec);spec.loader.exec_module(review)
ACTOR='10000000-0000-4000-8000-000000000001'


class ReviewTests(unittest.TestCase):
    setUp=fixtures.RetrievalTests.setUp
    tearDown=fixtures.RetrievalTests.tearDown

    def proposal(self,key='test'):
        store=review.retrieval.catalogue.Catalogue(self.root/'partitions'/review.publication.partition_id(fixtures.COMPANY),'test','company')
        try:
            return review.retrieval.derived.DerivedKnowledge(store).propose('fact',{'type':'project','key':key,'label':'Contrato'},'Estado','Condiciones vigentes',
                [{'source':'Y:\\report.txt','sha256':'a'*64,'locator':'page:2','quote':'Condiciones vigentes'}],key)
        finally:store.close()

    def request(self,operation='list',args=None,audience=None):
        return {'schemaVersion':1,'installationId':'test','connectionId':'arnall','requestId':str(uuid.uuid4()),'actorId':ACTOR,
                'audience':audience or fixtures.COMPANY,'operation':operation,'input':args or {'status':'proposed','cursor':0}}

    def execute(self,value):
        with patch.object(review.files.sync,'scope_directory',return_value=None):
            return review.execute(value,{'installationId':'test','connectionId':'arnall'},self.bindings,self.root)

    def test_confirmation_is_version_bound_and_audits_authenticated_actor(self):
        record=self.proposal()
        page=self.execute(self.request());self.assertEqual(page['records'][0]['id'],record['id'])
        args={'recordId':record['id'],'revision':1,'decision':'confirm'}
        result=self.execute(self.request('review',args))['record']
        self.assertEqual(result['status'],'confirmed');self.assertEqual(result['revision'],2)
        self.assertEqual(result['events'][0]['actor'],ACTOR)
        with self.assertRaisesRegex(ValueError,'RECORD_NOT_REVIEWABLE'):
            self.execute(self.request('review',args))
        with self.assertRaisesRegex(ValueError,'REVISION_CONFLICT'):
            self.execute(self.request('review',{**args,'decision':'delete'}))
        self.assertEqual(self.execute(self.request('review',{**args,'decision':'delete','revision':2}))['record']['status'],'deleted')

    def test_authenticated_correction_keeps_sources_and_exposes_its_previous_text(self):
        record=self.proposal()
        args={'recordId':record['id'],'revision':1,'content':'Condiciones vigentes según la fuente citada.','reason':'Precisar el alcance.'}
        result=self.execute(self.request('correct',args))['record']
        self.assertEqual(result['status'],'confirmed')
        self.assertEqual(result['correction'],{'previousRecordId':record['id'],'previousRevision':1,'previousContent':record['content'],'reason':args['reason']})
        self.assertEqual(result['citations'][0]['quote'],'Condiciones vigentes')
        self.assertEqual(result['events'][0]['actor'],ACTOR)
        self.assertFalse(review.valid(self.request('correct',{**args,'citations':[]}),{'installationId':'test','connectionId':'arnall'}))
        operator=review.retrieval.catalogue.Catalogue(self.root/'operator','test','operator')
        operator.withdraw('Y:\\report.txt','ACCESS_REVOKED');operator.close()
        with self.assertRaisesRegex(ValueError,'RECORD_SOURCE_UNAVAILABLE'):
            self.execute(self.request('correct',{**args,'recordId':result['id']}))

    def test_scope_denial_happens_before_store_access(self):
        with patch.object(review.retrieval,'Retrieval') as reader:
            with self.assertRaisesRegex(ValueError,'SCOPE_UNAVAILABLE'):
                self.execute(self.request(audience=fixtures.PRIVATE))
            reader.assert_not_called()

    def test_source_revocation_blocks_list_and_confirmation_before_publication(self):
        record=self.proposal()
        operator=review.retrieval.catalogue.Catalogue(self.root/'operator','test','operator')
        operator.withdraw('Y:\\report.txt','ACCESS_REVOKED');operator.close()
        self.assertEqual(self.execute(self.request())['records'],[])
        with self.assertRaisesRegex(ValueError,'RECORD_SOURCE_UNAVAILABLE'):
            self.execute(self.request('review',{'recordId':record['id'],'revision':1,'decision':'confirm'}))

    def test_pages_advance_and_arbitrary_actor_or_command_fields_are_rejected(self):
        for i in range(23):self.proposal(str(i))
        first=self.execute(self.request());self.assertEqual(len(first['records']),20)
        second=self.execute(self.request(args={'status':'proposed','cursor':first['nextCursor']}))
        self.assertEqual(len(second['records']),3);self.assertIsNone(second['nextCursor'])
        manifest={'installationId':'test','connectionId':'arnall'}
        self.assertFalse(review.valid({**self.request(),'reviewer':True},manifest))
        self.assertFalse(review.valid({**self.request(),'actorId':'model'},manifest))
        self.assertFalse(review.valid(self.request('shell',{'command':'anything'}),manifest))

    @unittest.skipUnless(hasattr(socket,'SO_PEERCRED'),'Linux peer credentials required')
    def test_real_review_handler_rejects_wrong_peer_before_execution(self):
        record=self.proposal()
        bindings=self.root/'bindings.json';bindings.write_text(json.dumps(self.bindings));bindings.chmod(0o600)
        address=self.root/'review.sock'
        manifest={'installationId':'test','connectionId':'arnall','appUid':os.geteuid()}
        # This test isolates kernel peer authentication and dispatch. Its private
        # binding is fictional and owned by the test runner, not a host operator.
        # Root-ownership denial is checked separately without mocking the guard.
        with patch.object(review.files.rdp,'private_file',return_value=bindings) as binding_reader,patch.object(review.files.sync,'scope_directory',return_value=None),patch.object(review,'execute',wraps=review.execute) as execution:
            server=review.Server(address,manifest,str(bindings),self.root)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                def ask(request=None,*,rejected_peer=False):
                    with socket.socket(socket.AF_UNIX) as client:
                        client.settimeout(2);client.connect(str(address))
                        try:
                            client.sendall(json.dumps(request or self.request(),ensure_ascii=False).encode()+b'\n')
                            return client.makefile('rb').readline()
                        except (BrokenPipeError,ConnectionResetError):
                            # A rejected peer can be closed before sendall or
                            # while reading. Authorized requests must still fail.
                            if not rejected_peer:raise
                            return b''
                self.assertEqual(json.loads(ask())['records'][0]['id'],record['id'])
                self.assertEqual(execution.call_count,1)
                correction=self.request('correct',{'recordId':record['id'],'revision':1,'content':'é'*5000,'reason':'Corrección Unicode de prueba.'})
                self.assertGreater(len(json.dumps(correction,ensure_ascii=False).encode()),8192)
                saved=json.loads(ask(correction))['record']
                self.assertEqual(saved['content'],correction['input']['content'])
                self.assertEqual(saved['status'],'confirmed')
                self.assertEqual(saved['correction']['previousRecordId'],record['id'])
                self.assertEqual(saved['events'][0]['actor'],ACTOR)
                self.assertEqual(execution.call_count,2)
                manifest['appUid']=os.geteuid()+1
                self.assertEqual(ask(correction,rejected_peer=True),b'');self.assertEqual(execution.call_count,2)
                self.assertEqual(binding_reader.call_count,2)
            finally:
                server.shutdown();server.server_close();thread.join(timeout=2)

    @unittest.skipIf(os.geteuid()==0,'This fixture exercises a real unprivileged owner')
    def test_unprivileged_binding_is_denied_by_unmodified_file_guard(self):
        bindings=self.root/'unprivileged-bindings.json'
        bindings.write_text(json.dumps(self.bindings));bindings.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'private, regular root-owned file'):
            review.files.rdp.private_file(bindings)


if __name__=='__main__':unittest.main()
