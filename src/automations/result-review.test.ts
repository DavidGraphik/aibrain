import { describe, expect, it } from 'vitest';
import { automationResultNeedsReview } from './result-review';
import { isGeneratedArtifact, type ChatMessage, type DocumentArtifact } from '@/lib/chat-contract';

const threadId='11111111-1111-4111-8111-111111111111';
const source:DocumentArtifact={id:'22222222-2222-4222-8222-222222222222',type:'document',name:'original.pdf',
 url:`/api/threads/${threadId}/connector-files/22222222-2222-4222-8222-222222222222`,kind:'pdf',mimeType:'application/pdf',size:100,
 status:'ready',pages:null,previewUrl:null,publicationStatus:null,publicationError:null,targetLabel:null,error:null,provenance:'source-read'};
const message=(artifact=source)=>({approvals:[],artifacts:[artifact],toolResults:[]} as unknown as ChatMessage);
describe('quiet review source copies',()=>{
 it('accepts persisted provenance but rejects unknown provenance contracts',()=>{
  expect(isGeneratedArtifact(source)).toBe(true);expect(isGeneratedArtifact({...source,provenance:'generated'})).toBe(false);
 });
 it('allows an unchanged original in its own thread only',()=>{
  expect(automationResultNeedsReview(message(),threadId)).toBe(false);
  expect(automationResultNeedsReview(message(),'33333333-3333-4333-8333-333333333333')).toBe(true);
 });
 it.each([
  {provenance:undefined}, // legacy/generated defaults
  {url:`/api/projects/${threadId}/documents/${source.id}`}, // modified/generated output
  {status:'processing' as const},{status:'error' as const},{error:'read failed'},
  {publicationStatus:'awaiting_confirmation' as const},{publicationStatus:'publishing' as const},
  {publicationStatus:'published' as const},{publicationStatus:'declined' as const},
  {publicationStatus:'conflict' as const},{publicationError:'conflict'},{targetLabel:'CRM document'},
 ])('keeps generated, modified, publication and error artifacts visible: %j',patch=>{
  expect(automationResultNeedsReview(message({...source,...patch}),threadId)).toBe(true);
 });
 it('preserves approval and incomplete work vetoes beside an original',()=>{
  expect(automationResultNeedsReview({...message(),approvals:[{}]} as ChatMessage,threadId)).toBe(true);
  for(const status of ['running','failed','stopped'])expect(automationResultNeedsReview({...message(),toolResults:[{status}]} as ChatMessage,threadId)).toBe(true);
 });
});
