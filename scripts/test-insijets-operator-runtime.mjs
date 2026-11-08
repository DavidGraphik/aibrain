import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,statSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {DatabaseSync} from 'node:sqlite';
import {prepareOutreachBatch} from '../src/insijets/outreach-preparation.ts';import {OutreachOperatorStore} from '../src/insijets/operator-runtime.ts';import {handleOperatorRequest} from '../src/insijets/operator-http.ts';
const day=86400000;const now=Date.now();
const owner={actorId:'verified-local-owner',installationId:'insijets-demo',email:'operator@example.invalid',provider:'local',canManageWorkspace:true};
const config=root=>({enabled:true,installationId:'insijets-demo',storageRoot:root,approvedResearchOrigins:['https://example.test'],approvedVerificationProviders:['synthetic-verifier']});
async function lead(time=now,email='fixture@example.test'){
 const p={installationId:'insijets-demo',execution:'synthetic-fixture',sourceApproved:true,allowedCountries:['IT'],allowedPersonas:['tour-manager'],allowedSources:['fixture-source'],maxCredits:1,maxCalls:2,verificationCostCredits:0,suppressedEmailHashes:[],sendingAccountReference:'synthetic-account',allowedResearchOrigins:['https://example.test']};
 const result=await prepareOutreachBatch([{id:'fixture-account-'+email.split('@')[0],company:'Synthetic Company',country:'IT',persona:'tour-manager',sourceUrl:'https://example.test/team',signalDate:new Date(time-day).toISOString(),fitReviewed:true}],p,[{id:'fixture-source',costCredits:0,enrich:async()=>({email,firstName:'Fixture',persona:'tour-manager'})}],async()=>({status:'valid',provider:'synthetic-verifier',checkedAt:new Date(time).toISOString()}),time);return result.leads[0];
}
function fixture(){const root=mkdtempSync(join(tmpdir(),'insijets-operator-runtime-'));let clock=now;return{root,config:config(root),clock:()=>clock,tick:()=>clock+=8*day,clean:()=>rmSync(root,{recursive:true,force:true})};}
function request(input,method='POST',query=''){return new Request('https://brain.example.test/api/insijets/outreach'+query,{method,headers:{Origin:'https://brain.example.test','Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(input)}:{})});}

test('actual HTTP handler denies tenants, role, anonymous/demo, CSRF and disabled config before SQLite; bounded input and no dispatch action',async()=>{
 const f=fixture();let session={provider:'local',expiresAt:new Date(now+day).toISOString(),tenant:{id:'insijets-demo'},user:{id:owner.actorId,email:owner.email}},admin=true,sameOrigin=true,loads=0;
 const deps={session:async()=>session,admin:async()=>admin,sameOrigin:async()=>sameOrigin,configuration:async()=>{loads++;return f.config;},now:f.clock};
 try{
  for(const changed of [null,{...session,provider:'demo'},{...session,expiresAt:new Date(now-day).toISOString()},{...session,tenant:{id:'foreign'}},{...session,user:{id:owner.actorId,email:'other-admin@example.test'}}]){const old=session;session=changed;const r=await handleOperatorRequest(request({action:'record-reply'}),deps);assert.ok([401,403].includes(r.status));session=old;}
  admin=false;assert.equal((await handleOperatorRequest(request({action:'record-reply'}),deps)).status,403);admin=true;sameOrigin=false;assert.equal((await handleOperatorRequest(request({action:'record-reply'}),deps)).status,403);sameOrigin=true;assert.equal(loads,0);assert.equal(existsSync(join(f.root,'insijets-outreach-preparation')),false);
  f.config.enabled=false;assert.equal((await handleOperatorRequest(request(null,'GET'),deps)).status,404);f.config.enabled=true;
  let r=await handleOperatorRequest(request(null,'GET'),deps);assert.equal(r.status,200);assert.equal((await r.json()).catalog.mode,'preparation-only');assert.equal(existsSync(join(f.root,'insijets-outreach-preparation')),false);
  assert.equal((await handleOperatorRequest(request({action:'send-email'}),deps)).status,400);assert.equal((await handleOperatorRequest(request(null,'GET','?view=drafts&limit=101'),deps)).status,400);
  assert.equal((await handleOperatorRequest(new Request('https://brain.example.test/api/insijets/outreach',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(16385)}),deps)).status,413);assert.equal(existsSync(join(f.root,'insijets-outreach-preparation')),false);
  const draft=await lead();r=await handleOperatorRequest(request({action:'stage-draft',lead:draft}),deps);assert.equal(r.status,200);assert.equal(statSync(join(f.root,'insijets-outreach-preparation/queue.sqlite')).mode&0o777,0o600);
  r=await handleOperatorRequest(request(null,'GET','?view=drafts'),deps);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, no-store');const d=await r.json();assert.equal(d.items[0].confidence.rating,'high');assert.deepEqual(d.items[0].review.draft.draft.to,['fixture@example.test']);assert.equal(d.items[0].review.sendingAccountResolved,false);assert.equal(d.items[0].review.emailApprovalGranted,false);
  assert.equal((await handleOperatorRequest(request({action:'approve-prepared-handoff',draftId:draft.id,digest:draft.digest,confirmation:'SEND NOW'}),deps)).status,400);
  r=await handleOperatorRequest(request({action:'approve-prepared-handoff',draftId:draft.id,digest:draft.digest,confirmation:'APPROVE PREPARED HANDOFF ONLY'}),deps);assert.equal(r.status,200);assert.equal((await r.json()).emailSend,false);
 }finally{f.clean();}
});

test('metrics/content/replies persist across restart; ratios use known denominators and content stays exact unsent review draft',async()=>{
 const f=fixture();let s=new OutreachOperatorStore(f.config,owner,f.clock);const draft=await lead();
 try{
  s.execute({action:'stage-draft',lead:draft});
  const metrics={action:'record-metrics',id:'weekly-fixture',counts:{attempted:100,delivered:98,hardBounces:1,principalDelivered:80,principalPositiveReplies:2},periodStart:new Date(now-7*day).toISOString(),periodEnd:new Date(now).toISOString(),sourceKind:'synthetic-fixture',sourceReference:'fixture-counts'};
  assert.equal(s.execute(metrics).duplicate,false);assert.equal(s.execute(metrics).duplicate,true);assert.throws(()=>s.execute({...metrics,counts:{attempted:1,delivered:2}}),/INCONSISTENT/);
  s.execute({action:'stage-content',id:'newsletter-fixture',kind:'newsletter-review',dueAt:new Date(now).toISOString(),subject:'Draft subject',body:'Draft public content for review.',sourceReference:'fixture-editorial-source'});assert.equal(s.execute({action:'review-due-content'}).items.length,1);
  const reply={action:'record-reply',id:'reply-fixture',draftId:draft.id,kind:'positive',sourceReference:'fixture-reply-receipt'};const r=s.execute(reply);assert.equal(r.triage.stopFollowups,true);assert.equal(r.triage.providerStopAcknowledged,false);assert.equal(r.triage.notificationSent,false);
  assert.throws(()=>s.execute({action:'approve-prepared-handoff',draftId:draft.id,digest:draft.digest,confirmation:'APPROVE PREPARED HANDOFF ONLY'}),/hold/);
  s.close();s=new OutreachOperatorStore(f.config,owner,f.clock);assert.equal(s.execute(reply).duplicate,true);
  const report=s.snapshot('metrics').items[0].data;assert.equal(report.hardBounceRate,.01);assert.equal(report.gatekeeperPositiveReplyRate,null);assert.equal(report.sourceVerified,false);assert.equal(report.liveResultsVerified,false);assert.equal(report.counts.providerCost,null);
  const content=s.snapshot('content').items[0];assert.equal(content.data.envelope.sendingAccount,null);assert.equal(content.data.envelope.to,null);assert.equal(content.data.send,false);assert.equal(content.data.publish,false);assert.equal(s.snapshot('drafts').items[0].replyHeld,true);
  assert.throws(()=>s.execute({action:'record-reply',id:'reply-fixture',draftId:draft.id,kind:'negative',sourceReference:'fixture-reply-receipt'}),/IMMUTABLE/);
 }finally{s.close();f.clean();}
});

test('atomic opt-out erases body, suppresses contact/queue, is duplicate-safe and survives process restart',async()=>{
 const f=fixture();let s=new OutreachOperatorStore(f.config,owner,f.clock);const draft=await lead();
 try{
  s.execute({action:'stage-draft',lead:draft});s.execute({action:'queue-prepare',id:'call-fixture',draftId:draft.id,provider:'acefone'});assert.equal(s.execute({action:'queue-next'}).item.provider,'acefone');
  const reply={action:'record-reply',id:'optout-fixture',draftId:draft.id,kind:'opt-out',sourceReference:'fixture-optout'};const result=s.execute(reply);assert.equal(result.triage.suppressionRequired,true);assert.equal(result.triage.providerStopAcknowledged,false);
  assert.equal(s.snapshot('call-queue').items[0].state,'held');assert.equal(s.snapshot('drafts').items[0].review,null);
  s.close();s=new OutreachOperatorStore(f.config,owner,f.clock);assert.equal(s.execute(reply).duplicate,true);assert.equal(s.suppressionHashes(owner).length,1);assert.throws(()=>s.execute({action:'stage-draft',lead:draft}),/suppressed/);
  const db=new DatabaseSync(join(f.root,'insijets-outreach-preparation/queue.sqlite'));assert.equal(JSON.stringify(db.prepare('SELECT * FROM drafts').all()).includes('fixture@example.test'),false);db.close();
 }finally{s.close();f.clean();}
});

test('real persisted sequential review queue keeps provider routing, one active slot, wrap-up and pause across restart; zero call transport',async()=>{
 const f=fixture();let s=new OutreachOperatorStore(f.config,owner,f.clock);const a=await lead(),b=await lead(now,'second@example.test');
 try{
  for(const d of [a,b])s.execute({action:'stage-draft',lead:d});
  s.execute({action:'queue-prepare',id:'call-a',draftId:a.id,provider:'acefone'});s.execute({action:'queue-prepare',id:'call-b',draftId:b.id,provider:'zadarma'});
  const first=s.execute({action:'queue-next'});assert.equal(first.item.provider,'acefone');assert.equal(first.callPlaced,false);assert.equal(first.item.transportConfigured,false);assert.equal(s.execute({action:'queue-next'}).item,null);
  assert.throws(()=>s.execute({action:'queue-wrap',id:'call-a'}),/STATE/);
  s.execute({action:'queue-finish',id:'call-a',outcome:'no-answer',durationSeconds:0,sourceReference:'synthetic-observation'});s.close();s=new OutreachOperatorStore(f.config,owner,f.clock);assert.equal(s.execute({action:'queue-next'}).item,null);s.execute({action:'queue-wrap',id:'call-a'});
  s.execute({action:'queue-pause'});s.close();s=new OutreachOperatorStore(f.config,owner,f.clock);assert.equal(s.execute({action:'queue-next'}).item,null);s.execute({action:'queue-resume'});assert.equal(s.execute({action:'queue-next'}).item.provider,'zadarma');
 }finally{s.close();f.clean();}
});

test('seven-day erasure keeps minimal receipts, blocks stale approval and allows separately reverified replacement; tampering is denied',async()=>{
 const f=fixture();let s=new OutreachOperatorStore(f.config,owner,f.clock);const draft=await lead();
 try{
  s.execute({action:'stage-draft',lead:draft});s.execute({action:'approve-prepared-handoff',draftId:draft.id,digest:draft.digest,confirmation:'APPROVE PREPARED HANDOFF ONLY'});s.execute({action:'stage-content',id:'old-content',kind:'seo-review',dueAt:new Date(now).toISOString(),subject:'Old draft',body:'Private old draft marker',sourceReference:'fixture-source'});
  s.close();f.tick();s=new OutreachOperatorStore(f.config,owner,f.clock);const old=s.snapshot('drafts').items[0];assert.equal(old.status,'expired');assert.equal(old.review,null);assert.equal(s.snapshot('content').items[0].data,null);assert.throws(()=>s.execute({action:'approve-prepared-handoff',draftId:draft.id,digest:draft.digest,confirmation:'APPROVE PREPARED HANDOFF ONLY'}),/mismatch/);
  const fresh=await lead(f.clock());s.execute({action:'stage-draft',lead:fresh});assert.equal(s.receipt(draft.id,owner).status,'superseded');
  const db=new DatabaseSync(join(f.root,'insijets-outreach-preparation/queue.sqlite'));const changed=structuredClone(fresh);changed.draft.body='Tampered after review';db.prepare('UPDATE drafts SET payload=? WHERE id=?').run(JSON.stringify(changed),fresh.id);db.close();assert.throws(()=>s.execute({action:'approve-prepared-handoff',draftId:fresh.id,digest:fresh.digest,confirmation:'APPROVE PREPARED HANDOFF ONLY'}),/tampered/);
 }finally{s.close();f.clean();}
});

test('real loopback HTTP transport preserves approved immutable envelope and restart readback with zero provider effects',async()=>{
 const {createServer}=await import('node:http');const {once}=await import('node:events');const f=fixture();const draft=await lead();let server;
 const deps={session:async()=>({provider:'local',expiresAt:new Date(now+day).toISOString(),tenant:{id:'insijets-demo'},user:{id:owner.actorId,email:owner.email}}),admin:async()=>true,sameOrigin:async(req)=>req.headers.get('origin')==='https://brain.example.test',configuration:async()=>f.config,now:f.clock};
 const start=async()=>{server=createServer(async(req,res)=>{try{const parts=[];for await(const chunk of req)parts.push(chunk);const body=Buffer.concat(parts);const apiRequest=new Request('https://brain.example.test'+req.url,{method:req.method,headers:req.headers,...(body.length?{body}:{})});const result=await handleOperatorRequest(apiRequest,deps);res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));}catch{res.writeHead(500);res.end();}});server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port+'/api/insijets/outreach';};
 const close=()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 try{
  let base=await start();const call=input=>fetch(base,{method:'POST',headers:{Origin:'https://brain.example.test','Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.equal((await call({action:'stage-draft',lead:draft})).status,200);const reviewed=await(await call({action:'review-draft',draftId:draft.id,digest:draft.digest})).json();assert.equal(reviewed.draft.digest,draft.digest);assert.equal(reviewed.draft.draft.body,draft.draft.body);assert.equal(reviewed.emailSent,false);
  const first=await(await call({action:'approve-prepared-handoff',draftId:draft.id,digest:draft.digest,confirmation:'APPROVE PREPARED HANDOFF ONLY'})).json();await close();base=await start();
  const replay=await(await call({action:'approve-prepared-handoff',draftId:draft.id,digest:draft.digest,confirmation:'APPROVE PREPARED HANDOFF ONLY'})).json();assert.equal(replay.id,first.id);assert.equal(replay.providerDispatch,false);assert.equal(replay.emailSend,false);
  assert.equal((await call({action:'approve-prepared-handoff',draftId:draft.id,digest:'0'.repeat(64),confirmation:'APPROVE PREPARED HANDOFF ONLY'})).status,409);
  const list=await(await fetch(base+'?view=drafts')).json();assert.equal(list.items[0].review.draft.digest,draft.digest);assert.equal(list.summary.handoffs,1);
 }finally{if(server?.listening)await close();f.clean();}
});
