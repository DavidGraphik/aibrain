import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {prepareOutreachWorkflow,type WorkflowInput,type WorkflowPorts,type TemporaryReviewDocuments} from '../../src/insijets/outreach-workflow';
import {DOCUMENTED_ICP_MIX} from '../../src/insijets/outreach-month-plan';
import {planOutreachSteadyCapacity} from '../../src/insijets/outreach-workflow-capacity';
import {PERSONA_SIGNAL_GROUPS} from '../../src/insijets/outreach-qualified-pipeline';
import {createSyntheticOutreachRow} from '../../src/insijets/outreach-synthetic-acceptance';
import {OUTREACH_FINAL_CONTENT} from '../../src/insijets/outreach-final-content';
import {importPhase1EditorialPack} from '../../src/insijets/outreach-editorial-import';
const now=Date.parse('2026-10-16T12:00:00.000Z'),at=new Date(now).toISOString(),sha=(x:string)=>createHash('sha256').update(x).digest('hex');
const editorial=importPhase1EditorialPack(JSON.stringify(OUTREACH_FINAL_CONTENT));
function row(n:number,persona:keyof typeof PERSONA_SIGNAL_GROUPS='pa-ea'){return createSyntheticOutreachRow(persona,n,now);}
function input(n=1):WorkflowInput{return {runId:'synthetic-run',tier:'standard',rows:Array.from({length:n},(_,i)=>row(i)),configuration:editorial.pipelines.newAcquisition,policy:{installationId:'insijets-demo',execution:'synthetic-fixture',sourceApproved:true,allowedCountries:['UK'],allowedPersonas:Object.keys(PERSONA_SIGNAL_GROUPS),allowedSources:['apollo-fixture','prospeo-fixture','clay-fixture'],maxCredits:30000,maxCalls:30000,verificationCostCredits:1,suppressedEmailHashes:[],sendingAccountReference:'synthetic-sender-only',allowedResearchOrigins:['https://official.example.invalid']},actor:{actorId:'synthetic-owner',installationId:'insijets-demo',email:'operator@example.invalid',provider:'local',canManageWorkspace:true},operator:{enabled:true,installationId:'insijets-demo',storageRoot:'/synthetic-unused',approvedResearchOrigins:['https://official.example.invalid'],approvedVerificationProviders:['independent-fixture']},sourceExecutionApproved:true,maxRetries:0,crmContract:'pending',eligibilityRef:'synthetic-client-attestation'};}
function ports(){
 const documents=new Map<string,{body:string;expiresAt:string}>(),counts={apollo:0,prospeo:0,clay:0,verify:0};
 const adapter:TemporaryReviewDocuments={kind:'private-brain-documents',create:async(k,b,e)=>{if(documents.has(k))return false;documents.set(k,{body:b,expiresAt:e});return true;},read:async k=>documents.get(k)??null,replace:async(k,old,b,e)=>{if(documents.get(k)?.body!==old)return false;documents.set(k,{body:b,expiresAt:e});return true;}};
 const source=(family:'apollo'|'prospeo'|'clay'):WorkflowPorts['sources'][number]=>({id:`${family}-fixture`,family,binding:'synthetic-fixture',costCredits:1,enrich:async a=>{counts[family]++;return family==='apollo'?null:{email:`${a.id}@example.invalid`,firstName:'Synthetic',persona:a.persona};}});
 const p:WorkflowPorts={documents:adapter,sources:[source('apollo'),source('clay'),source('prospeo')],verify:{id:'independent-fixture',binding:'synthetic-fixture',run:async()=>{counts.verify++;return {provider:'independent-fixture',status:'valid',checkedAt:at};}},stopState:async()=> 'clear'};
 return {p,counts,documents};
}
describe('InsiJets bounded private-review workflow',()=>{
 it('runs company-first qualification, fallback, independent verification, canonical persona copy and exact persisted readback',async()=>{
  const {p,counts,documents}=ports(),request=input(3),result=await prepareOutreachWorkflow(request,p,now);
  expect(result.leads).toHaveLength(3);expect(result.budget.calls).toBe(9);expect(result.budget.credits).toBe(9);expect(counts).toEqual({apollo:3,prospeo:3,clay:0,verify:3});
  expect(result.leads[0].draft.body).toContain('Synthetic principalFullName 0');expect((result.preparedSequences[0].steps as {body:string}[])[0].body).toBe(result.leads[0].draft.body);expect((result.preparedSequences[0].steps as {body:string}[]).every(step=>step.body.startsWith('Hello,'))).toBe(true);expect(result.leads[0].score).toBe(100);expect(result.qualificationReceipts).toHaveLength(3);expect(result.preparedSequences).toHaveLength(3);expect((result.preparedSequences[0].steps as {body:string}[])).toHaveLength(3);expect(JSON.stringify(result.preparedSequences)).not.toContain('{{');
  expect(result.crmPayloads[0]).toMatchObject({action:'create-contact',contractStatus:'written-operation-and-existing-record-policy-required',existingRecord:'hold-for-client-review-never-overwrite',dispatch:false});
  expect(JSON.parse(documents.get('insijets-demo:outreach-review:synthetic-run')!.body).result).toEqual({...result,duplicate:undefined});
  const replay=await prepareOutreachWorkflow(request,p,now);expect(replay.duplicate).toBe(true);expect(counts.verify).toBe(3);
  await expect(prepareOutreachWorkflow({...request,tier:'tier1'},p,now)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  expect(result).toMatchObject({crmWrite:false,emailSent:false,campaignActivated:false,productionReady:false});
 });
 it('permits Clay only for Tier1 and holds historical work without relationship evidence',async()=>{
  const a=ports();const result=await prepareOutreachWorkflow({...input(),tier:'tier1'},a.p,now);expect(result.leads).toHaveLength(1);expect(a.counts.clay).toBe(1);expect(a.counts.prospeo).toBe(0);
  const b=ports();const held=await prepareOutreachWorkflow({...input(),configuration:editorial.pipelines.historical},b.p,now);expect(held.leads).toHaveLength(0);expect(b.counts.verify).toBe(0);expect(held.held[0].reason).toContain('historical');
 });
 it('does no source work for missing/stale evidence, parked personas, exclusions and unconfirmed eligibility',async()=>{
  for(const modify of [(r:ReturnType<typeof row>)=>{r.qualification.common=[];r.qualification.signals=[];},(r:ReturnType<typeof row>)=>{r.qualification.common[0].evidence!.checkedAt='2020-01-01T00:00:00.000Z';},(r:ReturnType<typeof row>)=>{r.qualification.exclusions=['opt-out'] as never[];},(r:ReturnType<typeof row>)=>{r.qualification.eligibility='unknown' as never;}]){
   const fixture=ports(),request=input();modify(request.rows[0] as ReturnType<typeof row>);const result=await prepareOutreachWorkflow(request,fixture.p,now);expect(result.leads).toHaveLength(0);expect(fixture.counts.apollo).toBe(0);
  }
  const fixture=ports();const result=await prepareOutreachWorkflow({...input(),rows:[row(1,'art')]},fixture.p,now);expect(result.leads).toHaveLength(0);expect(fixture.counts.verify).toBe(0);
 });
 it('enforces owner, tenant, source approval, independent verifier and server binding before any calls',async()=>{
  const {p,counts}=ports();const request=input();
  for(const bad of [{...request,sourceExecutionApproved:false},{...request,actor:{...request.actor,installationId:'other'}},{...request,actor:{...request.actor,canManageWorkspace:false}}])await expect(prepareOutreachWorkflow(bad,p,now)).rejects.toThrow();
  await expect(prepareOutreachWorkflow(request,{...p,verify:{...p.verify,id:'apollo-fixture'}},now)).rejects.toThrow();
  await expect(prepareOutreachWorkflow({...request,policy:{...request.policy,execution:'prepared'}},p,now)).rejects.toThrow('INDEPENDENT');expect(counts.apollo).toBe(0);
 });
 it('requires a distinct known server verifier family for real preparation, including renamed supplier adapters',async()=>{
  for(const family of [undefined,'unknown','other','prospeo','apollo']){
   const fixture=ports(),request=input();request.policy.execution='prepared';
   fixture.p.sources=fixture.p.sources.map(source=>({...source,binding:'server-verified'}));
   fixture.p.verify={...fixture.p.verify,binding:'server-verified',family};
   await expect(prepareOutreachWorkflow(request,fixture.p,now)).rejects.toThrow('INDEPENDENT_PROVIDER_FAMILY_REQUIRED');expect(fixture.counts).toEqual({apollo:0,prospeo:0,clay:0,verify:0});
  }
  const fixture=ports(),request=input();request.policy.execution='prepared';fixture.p.sources=fixture.p.sources.map(source=>({...source,binding:'server-verified'}));fixture.p.verify={...fixture.p.verify,binding:'server-verified',family:'independent-fixture-provider'};
  const result=await prepareOutreachWorkflow(request,fixture.p,now);expect(result.leads).toHaveLength(1);expect(result.productionReady).toBe(false);
 });
 it('handles suppressed, replied, unknown, duplicate and newly opted-out contacts without creating a handoff',async()=>{
  for(const status of ['replied','opted-out','unknown'] as const){const {p,counts}=ports();p.stopState=async()=>status;const result=await prepareOutreachWorkflow(input(),p,now);expect(result.leads).toHaveLength(0);expect(counts.verify).toBe(0);}
  const duplicate=ports();const first=await prepareOutreachWorkflow(input(),duplicate.p,now);expect(first.leads).toHaveLength(1);const second=await prepareOutreachWorkflow({...input(),runId:'second-run'},duplicate.p,now);expect(second.leads).toHaveLength(0);
  const suppressed=ports(),request=input();request.policy.suppressedEmailHashes=[sha('synthetic-0@example.invalid')];expect((await prepareOutreachWorkflow(request,suppressed.p,now)).leads).toHaveLength(0);
  const changed=ports();let calls=0;changed.p.stopState=async()=>++calls===1?'clear':'opted-out';const result=await prepareOutreachWorkflow(input(),changed.p,now);expect(result.leads).toHaveLength(0);expect(result.crmPayloads).toHaveLength(0);
 });
 it('rechecks reply and opt-out state on idempotent review reads and removes stale contact payloads',async()=>{
  const fixture=ports();await prepareOutreachWorkflow(input(),fixture.p,now);fixture.p.stopState=async()=> 'opted-out';await expect(prepareOutreachWorkflow(input(),fixture.p,now)).rejects.toThrow('REVIEW_STOP_CHANGED');expect(fixture.documents.get('insijets-demo:outreach-review:synthetic-run')!.body).not.toContain('@example.invalid');
 });
 it('does not duplicate provider work for concurrent requests with the same immutable run identity',async()=>{
  const fixture=ports();const results=await Promise.allSettled([prepareOutreachWorkflow(input(),fixture.p,now),prepareOutreachWorkflow(input(),fixture.p,now)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect(fixture.counts.verify).toBe(1);
 });
 it('accounts every failed retry and stops at the aggregate credit/call ceiling',async()=>{
  const {p,counts}=ports();p.sources[0].enrich=async()=>{counts.apollo++;throw Error('temporary synthetic outage');};const request={...input(10),maxRetries:1};request.policy.maxCalls=5;request.policy.maxCredits=5;
  const result=await prepareOutreachWorkflow(request,p,now);expect(result.budget.calls).toBe(5);expect(result.budget.credits).toBe(5);expect(result.attempts.some(a=>a.outcome==='failed-retry')).toBe(true);expect(result.leads.length).toBeLessThan(10);expect(counts.apollo+counts.prospeo+counts.verify).toBe(5);
 });
 it('rejects fresh-but-same-provider and stale verification',async()=>{
  for(const mode of ['same','stale']){const fixture=ports();fixture.p.verify.run=async()=>({provider:mode==='same'?'prospeo-fixture':'independent-fixture',status:'valid',checkedAt:mode==='same'?at:'2020-01-01T00:00:00.000Z'});const result=await prepareOutreachWorkflow(input(),fixture.p,now);expect(result.leads).toHaveLength(0);}
 });
 it('fails closed on persisted readback mismatch, retaining an explicit reconciliation state',async()=>{
  const fixture=ports(),read=fixture.p.documents.read;fixture.p.documents.read=async key=>{const doc=await read(key);return doc?{...doc,body:doc.body+' '}:null;};await expect(prepareOutreachWorkflow(input(),fixture.p,now)).rejects.toThrow('EXACT_PERSISTED');
 });
 it('persists an exact private temporary review document and can reopen it without provider calls',async()=>{
  const fixture=ports(),dir=mkdtempSync(path.join(tmpdir(),'outreach-private-document-'));
  try{const file=(key:string)=>path.join(dir,sha(key)+'.json');fixture.p.documents={kind:'private-brain-documents',create:async(k,body,expiresAt)=>{try{writeFileSync(file(k),JSON.stringify({body,expiresAt}),{flag:'wx',mode:0o600});return true;}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}},read:async k=>{try{return JSON.parse(readFileSync(file(k),'utf8'));}catch{return null;}},replace:async(k,expected,body,expiresAt)=>{const old=JSON.parse(readFileSync(file(k),'utf8'));if(old.body!==expected)return false;writeFileSync(file(k),JSON.stringify({body,expiresAt}),{mode:0o600});return true;}};
   const result=await prepareOutreachWorkflow(input(),fixture.p,now);expect(statSync(file('insijets-demo:outreach-review:synthetic-run')).mode&0o777).toBe(0o600);const reopened=await prepareOutreachWorkflow(input(),fixture.p,now);expect(reopened.leads).toEqual(result.leads);expect(reopened.duplicate).toBe(true);expect(fixture.counts.verify).toBe(1);
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('deduplicates identical account inputs and rejects conflicting account content before calls',async()=>{
  const fixture=ports(),request=input();request.rows.push(structuredClone(request.rows[0]));const result=await prepareOutreachWorkflow(request,fixture.p,now);expect(result.leads).toHaveLength(1);expect(fixture.counts.verify).toBe(1);const conflict=ports();request.rows[1].account.company='Conflicting company';await expect(prepareOutreachWorkflow(request,conflict.p,now)).rejects.toThrow('ACCOUNT_CONTENT_CONFLICT');expect(conflict.counts.apollo).toBe(0);
 });
 it('processes 2,000 synthetic companies in bounded chunks and deduplicates across chunks',async()=>{
  const fixture=ports(),request=input(2000);let counter=0;request.rows=DOCUMENTED_ICP_MIX.flatMap(p=>Array.from({length:20*p.percent},()=>row(counter++,p.id as keyof typeof PERSONA_SIGNAL_GROUPS)));const result=await prepareOutreachWorkflow(request,fixture.p,now);expect(result.leads).toHaveLength(2000);expect(result.crmPayloads).toHaveLength(2000);expect(result.budget.calls).toBe(6000);expect(new Set(result.leads.map(l=>l.contact.email)).size).toBe(2000);expect(new Set(result.leads.map(l=>l.persona)).size).toBe(10);expect(result.productionReady).toBe(false);
  const reviewKey='insijets-demo:outreach-review:synthetic-run',document=fixture.documents.get(reviewKey)!;
  const envelope={schemaVersion:1,installationId:'insijets-demo',actorId:request.actor.actorId,key:reviewKey,body:document.body,bodySha256:sha(document.body),createdAt:at,expiresAt:document.expiresAt};
  const storage={fixtureCompanies:2000,reviewBodyBytes:Buffer.byteLength(document.body),reviewBodyLimitBytes:16*1024*1024,serializedEnvelopeBytes:Buffer.byteLength(JSON.stringify(envelope)),serializedEnvelopeLimitBytes:32*1024*1024,contactClaimDocuments:2000,method:'Actual canonical workflow Map output serialized into the exact private-document envelope; no claim that all 2000 filesystem writes were performed'};
  expect(storage.reviewBodyBytes).toBeLessThan(storage.reviewBodyLimitBytes);expect(storage.serializedEnvelopeBytes).toBeLessThan(storage.serializedEnvelopeLimitBytes);
  if(process.env.INSIJETS_WORKFLOW_MEASURE)writeFileSync(process.env.INSIJETS_WORKFLOW_MEASURE,JSON.stringify(storage,null,2)+'\n');
 });
});
describe('steady-state email accounting distinct from ramp-up',()=>{
 it('models the signed 5,760 email portfolio capacity including followups, not 5,760 contacts',()=>{
  const result=planOutreachSteadyCapacity({mailboxes:Array.from({length:24},(_,i)=>({id:`synthetic-mailbox-${i}`,dailyEmailCap:20,ready:true})),sendWeekdays:[2,3,4],initialDemandPerDay:480,priorCohorts:[{firstDay:-7,contacts:100}]});
  expect(result.totals.capacity).toBe(5760);expect(result.totals.emails).toBe(5760);expect(result.totals.firstContacts).toBeLessThan(5760);expect(result.totals.followups).toBeGreaterThan(0);expect(result.totals.futureFollowups).toBeGreaterThan(0);expect(result.rampIncluded).toBe(false);expect(result.days.every(d=>d.emails<=d.capacity)).toBe(true);
  expect(result.totals.emails).toBe(result.totals.firstContacts+result.totals.followups);
 });
 it('does not count unready mailboxes or borrow nonexistent capacity',()=>{const result=planOutreachSteadyCapacity({mailboxes:[{id:'not-ready',dailyEmailCap:20,ready:false}],sendWeekdays:[2,3,4],initialDemandPerDay:1000});expect(result.totals.capacity).toBe(0);expect(result.totals.emails).toBe(0);expect(result.baselineCapacitySupported).toBe(false);});
});
