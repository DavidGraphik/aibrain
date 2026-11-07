// Reproducible phase-one rehearsal. Synthetic inputs, loopback only, zero providers.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {QUALIFICATION_VERSION,PERSONA_SIGNAL_GROUPS,prepareQualifiedOutreachBatch} from '../src/insijets/outreach-qualified-pipeline.ts';
import {handleOperatorRequest} from '../src/insijets/operator-http.ts';
import {handleOutreachSystemRequest} from '../src/insijets/outreach-system-http.ts';
const out=path.resolve(process.argv[2]??'../output/2026-10-15/outreach-system/phase1-final-tech');mkdirSync(out,{recursive:true});
const root=mkdtempSync(path.join(tmpdir(),'insijets-phase1-synthetic-')),now=Date.now(),iso=new Date(now).toISOString(),sourceOrigin='https://fixture.example.test';
const audit={mode:'synthetic-rehearsal-not-live-acceptance',candidateSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTreeDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,sourceHashes:Object.fromEntries(['src/insijets/outreach-qualified-pipeline.ts','src/insijets/outreach-preparation.ts','scripts/demo-insijets-phase1.mjs'].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')])),startedAt:iso,sourceCredentialsUsed:false,providerCreditsConsumed:0,externalNetworkRequests:0,sourceHookCalls:{primary:0,fallback:0,never:0,verifier:0},steps:[],serverModified:false,crmWrite:false,emailsSent:0,schedulerActivated:false};
function q(accountId,persona){return{accountId,persona,frameworkVersion:QUALIFICATION_VERSION,common:Object.entries({economicFit:20,travelRelevance:20,fboPracticality:10,roleAuthority:10,sourceFreshness:10,contactQuality:10}).map(([group,points])=>({group,points,evidence:{factId:accountId+'-common-'+group,sourceUrl:sourceOrigin+'/source/'+accountId,checkedAt:iso,kind:'signal'}})),signals:PERSONA_SIGNAL_GROUPS[persona].map((group,i)=>({group,points:i<3?40:20,evidence:{factId:accountId+'-persona-'+i,sourceUrl:sourceOrigin+'/source/'+accountId,checkedAt:iso,kind:'signal'}})),exclusions:[],eligibility:'client-attested-eligible'};}
function row(id,persona,company){return{account:{id,persona,company,country:'IT',sourceUrl:sourceOrigin+'/source/'+id,signalDate:iso,fitReviewed:true},qualification:q(id,persona)};}
const pa=row('synthetic-pa','pa-ea','Synthetic Office Ltd');pa.copyVariables={verified_relevant_context:{text:'SYNTHETIC FIXTURE: the reviewed role includes itinerary coordination.',factIds:['synthetic-pa-persona-0']}};
const owner=row('synthetic-owner','business-owners','Synthetic Regional Ltd');owner.copyVariables={verified_business_context:{text:'synthetic regional operations',factIds:['synthetic-owner-persona-1']},verified_signal_sentence:{text:'SYNTHETIC FIXTURE: a dated site visit and its transfer requirement were reviewed.',factIds:['synthetic-owner-persona-2']}};
const excluded=row('synthetic-excluded','business-owners','Synthetic Excluded Ltd');excluded.qualification.exclusions=['opt-out'];
const historical=row('synthetic-historical','business-owners','Synthetic Historical Ltd');historical.historicalRelationshipAttested=true;
const policy={installationId:'insijets-demo',execution:'synthetic-fixture',sourceApproved:true,allowedCountries:['IT'],allowedPersonas:['pa-ea','business-owners'],allowedSources:['synthetic-primary','synthetic-fallback','synthetic-never'],maxCredits:0,maxCalls:12,verificationCostCredits:0,suppressedEmailHashes:[],sendingAccountReference:'unassigned-synthetic-no-send',allowedResearchOrigins:[sourceOrigin]};
const imported=JSON.parse(readFileSync(path.join(out,'phase1-config.json'),'utf8'));
assert.equal(imported.parity.allIdentical,true);assert.equal(imported.parity.messages,54);
const configuration=imported.pipelines.newAcquisition,historicalConfig=imported.pipelines.historical;
audit.editorialSourceSha256=imported.sourceSha256;audit.editorialMessageParity=imported.parity.messages;
delete pa.copyVariables;delete owner.copyVariables;
const sources=[{id:'synthetic-primary',costCredits:0,enrich:async()=>{audit.sourceHookCalls.primary++;return null;}},{id:'synthetic-fallback',costCredits:0,enrich:async account=>{audit.sourceHookCalls.fallback++;return{email:account.id+'@fixture.example.test',firstName:'Synthetic',persona:account.persona};}},{id:'synthetic-never',costCredits:0,enrich:async()=>{audit.sourceHookCalls.never++;throw Error('Waterfall failed to terminate');}}];
const verify=async()=>{audit.sourceHookCalls.verifier++;return{status:'valid',provider:'synthetic-verifier',checkedAt:iso};};
const storeConfig={enabled:true,installationId:'insijets-demo',storageRoot:root,approvedResearchOrigins:[sourceOrigin],approvedVerificationProviders:['synthetic-verifier']};
const session={provider:'local',expiresAt:new Date(now+86400000).toISOString(),tenant:{id:'insijets-demo'},user:{id:'synthetic-phase1-operator',email:'operator@example.invalid'}};
let origin,server;const originalFetch=globalThis.fetch;
try{
 server=createServer(async(req,res)=>{try{const chunks=[];for await(const part of req)chunks.push(part);const request=new Request(origin+req.url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});const deps={session:async()=>req.headers['x-synthetic-anonymous']==='true'?null:session,admin:async()=>true,sameOrigin:async r=>r.headers.get('Origin')===origin,configuration:async()=>storeConfig,now:()=>now};const response=await(req.url==='/api/insijets/outreach/system'?handleOutreachSystemRequest:handleOperatorRequest)(request,deps);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end('Synthetic handler failure');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 globalThis.fetch=async(input,init)=>{const url=new URL(input instanceof Request?input.url:input);if(url.origin!==origin){audit.externalNetworkRequests++;throw Error('EXTERNAL_NETWORK_DENIED_IN_REHEARSAL');}return originalFetch(input,init);};
 const request=async(action,input,system=false)=>{const response=await fetch(origin+'/api/insijets/outreach'+(system?'/system':''),{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(system?{action,input}:{action,...input})});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
 const newBatch=await prepareQualifiedOutreachBatch([pa,owner,excluded],configuration,policy,sources,verify,now),historicalBatch=await prepareQualifiedOutreachBatch([historical],historicalConfig,policy,sources,verify,now);
 assert.equal(newBatch.leads.length,2);assert.equal(newBatch.held.length,1);assert.equal(historicalBatch.leads.length,1);assert.equal(audit.sourceHookCalls.never,0);
 audit.steps.push({step:'configuration-and-waterfall',passed:true,newQualified:2,historicalQualified:1,excludedBeforeLookup:1,frameworkVersion:QUALIFICATION_VERSION,configurationVersion:configuration.version,legacyGenericPriorityUsed:false,realSourceBinding:false});
 for(const lead of [...newBatch.leads,...historicalBatch.leads]){assert.equal(lead.score,80);assert.doesNotMatch(lead.draft.body,/{{/);const campaign=(lead.accountId==='synthetic-historical'?historicalConfig:configuration).campaigns.find(c=>c.id===(lead.accountId==='synthetic-historical'?'historical-current-en':lead.persona==='pa-ea'?'c3':'f4'));assert.equal(lead.draft.body,campaign.steps[0].body.replaceAll('{{firstName}}','Synthetic'));assert.equal(lead.draft.subject,campaign.subject);await request('stage-draft',{lead});const reviewed=await request('review-draft',{draftId:lead.id,digest:lead.digest});assert.equal(reviewed.draft.draft.body,lead.draft.body);assert.equal(reviewed.emailApprovalGranted,false);}
 audit.steps.push({step:'exact-api-draft-store-readback',passed:true,preparedDrafts:3,sourceTemplates:['c3','f4','historical-current-en'],sourceSequenceIds:['pa_ea','business_owners','H1_EN'],exactSourceBodyParityAfterFirstNameSubstitution:true,weightedScores:[80,80,80],actualServerSession:false});
 const ownerLead=newBatch.leads.find(x=>x.accountId===owner.account.id),paLead=newBatch.leads.find(x=>x.accountId===pa.account.id);
 const handoff=await request('approve-prepared-handoff',{draftId:ownerLead.id,digest:ownerLead.digest,confirmation:'APPROVE PREPARED HANDOFF ONLY'}),duplicate=await request('approve-prepared-handoff',{draftId:ownerLead.id,digest:ownerLead.digest,confirmation:'APPROVE PREPARED HANDOFF ONLY'});assert.equal(handoff.id,duplicate.id);assert.equal(handoff.emailSend,false);
 await request('tier1-stage',{draftId:paLead.id,digest:paLead.digest,reason:'SYNTHETIC reviewed travel responsibility and current role',evidenceUrl:paLead.sourceUrl,evidenceCheckedAt:iso,linkedinUrl:'https://www.linkedin.com/in/synthetic-fixture-no-real-person'},true);
 const tier1=(await request('tier1-prepare',{limit:5},true)).result;assert.equal(tier1.items.length,1);assert.equal(tier1.notificationSent,false);
 await request('record-reply',{id:'synthetic-optout',draftId:paLead.id,kind:'opt-out',sourceReference:'synthetic-controlled-reply'});
 const snapshot=await(await fetch(origin+'/api/insijets/outreach/system')).json();assert.equal(snapshot.tier1.items.length,0);assert.equal(snapshot.readiness.crmConnected,false);
 const db=new DatabaseSync(path.join(root,'insijets-outreach-preparation','queue.sqlite'),{readOnly:true});try{const erased=db.prepare('SELECT reason,evidence_url,linkedin_url FROM outreach_tier1_candidates WHERE draft_id=?').get(paLead.id);assert.deepEqual({...erased},{reason:'',evidence_url:'',linkedin_url:''});assert.equal(db.prepare('SELECT count(*) AS n FROM handoffs').get().n,1);}finally{db.close();}
 const denied=await fetch(origin+'/api/insijets/outreach/system',{headers:{'X-Synthetic-Anonymous':'true'}});assert.equal(denied.status,401);
 audit.steps.push({step:'handoff-tier1-optout-and-isolation',passed:true,duplicateHandoffPrevented:true,manualTier1Selected:1,optoutPurgedImmediately:true,anonymousDenied:401,providerStopReceiptVerified:false});
 writeFileSync(path.join(out,'synthetic-input-and-config.json'),JSON.stringify({warning:'All records/facts/eligibility are synthetic, not InsiJets client data or actual lead research',inputs:{new:[pa,owner,excluded],historical:[historical]},configurations:[configuration,historicalConfig],policy},null,2)+'\n');
 writeFileSync(path.join(out,'synthetic-pipeline-result.json'),JSON.stringify({newBatch,historicalBatch,handoff},null,2)+'\n');
 audit.completed=true;
}finally{
 globalThis.fetch=originalFetch;if(server?.listening)await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});audit.syntheticServerClosed=true;audit.syntheticStoreRemoved=true;audit.finishedAt=new Date().toISOString();writeFileSync(path.join(out,'walkthrough-receipt.json'),JSON.stringify(audit,null,2)+'\n');
}
console.log(JSON.stringify(audit,null,2));
