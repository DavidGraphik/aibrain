import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SibemaStore } from "../lib/store.mjs";
import { createHash } from 'node:crypto';

const event = {
  eventId: "evt-1",
  eventType: "offer.created",
  occurredAt: "2026-07-23T15:00:00.000Z",
  objectType: "offer",
  objectId: "12",
  related: {},
  changedFields: [],
  payload: { event_id: "evt-1" },
};

test("deduplicates events and creates review tasks atomically", () => {
  const directory = mkdtempSync(join(tmpdir(), "trinalum-sibema-"));
  const store = new SibemaStore(join(directory, "test.sqlite"));
  assert.equal(store.enqueue(event), true);
  assert.equal(store.enqueue(event), false);
  assert.equal(store.claim("evt-1"), true);
  store.complete("evt-1", {
    resource: "offers",
    objectId: "12",
    snapshotPath: "/tmp/snapshot.json",
    workflow: "competitor-detection",
  });
  assert.equal(store.stats().events.processed, 1);
  assert.equal(store.stats().tasks.ready, 1);
  store.close();
});

test("failed review tasks can be previewed and requeued after credentials recover", () => {
  const directory = mkdtempSync(join(tmpdir(), "sibema-store-requeue-"));
  const store = new SibemaStore(join(directory, "test.sqlite"));
  const retryEvent = {
    ...event,
    eventId: "event-requeue",
    objectId: "745",
    payload: { event_id: "event-requeue" },
  };
  store.enqueue(retryEvent);
  store.claim(retryEvent.eventId);
  store.complete(retryEvent.eventId, {
    resource: "orders",
    objectId: retryEvent.objectId,
    snapshotPath: "/private/snapshot.json",
    workflow: "accepted-budget-intake",
  });
  const task = store.nextReviewTask();
  store.claimReviewTask(task.task_id);
  store.failReviewTask(task.task_id, new Error("provider quota exhausted"));
  assert.equal(store.failedReviewTasks().length, 1);
  assert.equal(store.requeueFailedReviewTasks(1), 1);
  assert.equal(store.nextReviewTask().task_id, task.task_id);
  store.close();
});

test("approved SIBEMA actions preserve exact content and execute once", () => {
  const directory = mkdtempSync(join(tmpdir(), "trinalum-sibema-actions-"));
  const store = new SibemaStore(join(directory, "test.sqlite"));
  const action = {
    id: "sibema-action-001",
    type: "update_order_status",
    requestedBy: "Miguel",
    request: {
      orderId: 745,
      body: { status_id: 2 },
    },
  };
  assert.equal(store.prepareApprovedAction(action).status, "prepared");
  assert.equal(store.prepareApprovedAction({
    ...action,
    request: { body: { status_id: 2 }, orderId: 745 },
  }).status, "prepared");
  assert.throws(
    () => store.prepareApprovedAction({
      ...action,
      request: { orderId: 745, body: { status_id: 3 } },
    }),
    /different exact content/,
  );
  assert.equal(store.approveAction(action.id, "Miguel").status, "approved");
  assert.equal(store.claimApprovedAction(action.id), true);
  assert.equal(store.claimApprovedAction(action.id), false);
  store.completeApprovedAction(
    action.id,
    { order_id: 745 },
    { order_id: 745, status: { id: 2 } },
  );
  assert.equal(store.approvedAction(action.id).status, "completed");
  assert.equal(store.claimApprovedAction(action.id), false);
  store.close();
});

test('definitively rejected deletes and uncertain deletes cannot be approved or dispatched again',()=>{
 for(const flags of [{definitiveRejection:true},{outcomeUncertain:true}]){
  const directory=mkdtempSync(join(tmpdir(),'trinalum-delete-store-')),store=new SibemaStore(join(directory,'test.sqlite'));
  const action={id:'synthetic-delete-once',type:'delete_offer',requestedBy:'Nerea',request:{offerId:17,customerId:42,body:{proof:'synthetic-test-only'}}};
  store.prepareApprovedAction(action);store.approveAction(action.id,'Nerea');assert.equal(store.claimApprovedAction(action.id),true);store.failApprovedAction(action.id,Object.assign(Error('provider result'),flags));
  assert.equal(store.approvedAction(action.id).status,flags.definitiveRejection?'rejected':'uncertain');assert.throws(()=>store.approveAction(action.id,'Nerea'),/not ready/);assert.equal(store.claimApprovedAction(action.id),false);store.close();
 }
});

test('semantic deletion resource fence survives reopen and ignores new action/proof/actor for every disposition',()=>{
 const directory=mkdtempSync(join(tmpdir(),'trinalum-resource-fence-')),path=join(directory,'test.sqlite');
 const resource={integration:'a'.repeat(64),kind:'tariff',customerId:42,targetId:7};
 for(const status of ['dispatch','completed','rejected','uncertain']){
  let store=new SibemaStore(path);const target={...resource,targetId:7+['dispatch','completed','rejected','uncertain'].indexOf(status)};
  assert.equal(store.claimDeletionResource({...target,actionId:'first-action',actor:'Nerea',snapshotSha256:'b'.repeat(64)}),true);
  if(status!=='dispatch')store.finishDeletionResource(target,'first-action',status);store.close();store=new SibemaStore(path);
  assert.equal(store.deletionResource(target).status,status);
  assert.equal(store.claimDeletionResource({...target,actionId:'entirely-new-action',actor:'Miguel',snapshotSha256:'c'.repeat(64)}),false);
  assert.equal(store.deletionResource(target).action_id,'first-action');assert.throws(()=>store.finishDeletionResource(target,'different-action','completed'),/could not/);store.close();
 }
});

test('two concurrent processes claim the same semantic resource exactly once',async()=>{
 const {writeFileSync,rmSync}=await import('node:fs'),{fork}=await import('node:child_process');
 const directory=mkdtempSync(join(tmpdir(),'trinalum-fence-race-')),path=join(directory,'test.sqlite'),script=join(directory,'claim.mjs');let store=new SibemaStore(path);store.close();
 const resource={integration:'d'.repeat(64),kind:'offer',customerId:42,targetId:7};
 writeFileSync(script,`import {SibemaStore} from ${JSON.stringify(new URL('../lib/store.mjs',import.meta.url).href)};const s=new SibemaStore(process.argv[2]);process.on('message',()=>{const claimed=s.claimDeletionResource({...JSON.parse(process.argv[3]),actionId:process.argv[4],actor:'Nerea',snapshotSha256:'e'.repeat(64)});s.close();process.send({claimed},()=>process.exit(0));});process.send({ready:true});`);
 const children=[0,1].map(i=>fork(script,[path,JSON.stringify(resource),'parallel-action-'+i],{execArgv:[],silent:true}));
 try{
  await Promise.all(children.map(c=>new Promise((resolve,reject)=>{c.once('error',reject);c.once('exit',code=>reject(Error('claim child exited before ready: '+code)));c.once('message',m=>m.ready?resolve():reject(Error('missing ready')));})));const results=children.map(c=>new Promise((resolve,reject)=>{c.once('error',reject);c.once('message',m=>resolve(m.claimed));}));children.forEach(c=>c.send('claim'));
  assert.deepEqual((await Promise.all(results)).sort(),[false,true]);await Promise.all(children.map(c=>new Promise(resolve=>c.exitCode!==null?resolve():c.once('exit',resolve))));
  store=new SibemaStore(path);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM deletion_resource_fences').get().n,1);assert.equal(store.deletionResource(resource).status,'dispatch');store.close();
 }finally{children.forEach(c=>{if(c.exitCode===null)c.kill();});rmSync(directory,{recursive:true,force:true});}
});

const rowHash=row=>createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(k=>[k,row[k]])))).digest('hex');
function recoveryFixture(){
 const directory=mkdtempSync(join(tmpdir(),'trinalum-reviewed-recovery-')),path=join(directory,'test.sqlite'),store=new SibemaStore(path);
 const resource={integration:'a'.repeat(64),kind:'offer',customerId:42,targetId:7},snapshotSha256='b'.repeat(64),moduleSha256='c'.repeat(64),actor='Nerea';
 const request={customerId:42,offerId:7,body:{proof:'synthetic-only',expectedSnapshotSha256:snapshotSha256}};
 const oldActionId='old-uncertain-action',newActionId='new-reviewed-action';
 store.prepareApprovedAction({id:oldActionId,type:'delete_offer',requestedBy:actor,request});store.approveAction(oldActionId,actor);store.claimApprovedAction(oldActionId);store.failApprovedAction(oldActionId,Object.assign(Error('original500'),{outcomeUncertain:true}));
 store.claimDeletionResource({...resource,actionId:oldActionId,actor,snapshotSha256});store.finishDeletionResource(resource,oldActionId,'uncertain');
 const next=store.prepareApprovedAction({id:newActionId,type:'delete_offer',requestedBy:actor,request});const now=Date.now();
 const review={...resource,grantId:'reviewed-recovery-grant',oldActionId,newActionId,actor,snapshotSha256,moduleSha256,newRequestHash:next.request_hash,oldFenceSha256:rowHash(store.deletionResource(resource)),oldActionSha256:rowHash(store.approvedAction(oldActionId)),createdAtMs:now,expiresAtMs:now+120000,readbacks:[0,1].map(()=>({atMs:now,snapshotSha256,moduleSha256})),reason:'Operator reviewed official wire correction; one explicit new UI action only'};
 const claim={...resource,actionId:newActionId,actor,snapshotSha256,requestHash:next.request_hash,moduleSha256};
 return {directory,path,store,resource,review,claim,oldActionId,newActionId};
}
test('reviewed one-use recovery atomically audits original rows and never rewrites old uncertain action',()=>{
 const f=recoveryFixture(),s=f.store,old=s.approvedAction(f.oldActionId),fence=s.deletionResource(f.resource);
 try{
  s.authorizeDeletionRecovery(f.review);assert.deepEqual(s.approvedAction(f.oldActionId),old);assert.deepEqual(s.deletionResource(f.resource),fence);
  assert.equal(s.claimDeletionResource(f.claim),false); // Only an approved/executing new action may dispatch.
  s.approveAction(f.newActionId,'Nerea');s.claimApprovedAction(f.newActionId);assert.equal(s.claimDeletionResource(f.claim),true);assert.equal(s.claimDeletionResource(f.claim),false);
  const audit=s.db.prepare('SELECT * FROM deletion_resource_recovery_audit').get();assert.deepEqual(JSON.parse(audit.previous_fence_json),JSON.parse(JSON.stringify(fence)));assert.deepEqual(JSON.parse(audit.previous_action_json),JSON.parse(JSON.stringify(old)));assert.deepEqual(s.approvedAction(f.oldActionId),old);
  assert.throws(()=>s.db.prepare("UPDATE deletion_resource_recovery_audit SET review_json='{}'").run(),/immutable/);assert.throws(()=>s.db.prepare('DELETE FROM deletion_resource_recovery_audit').run(),/immutable/);
  s.finishDeletionResource(f.resource,f.newActionId,'uncertain');assert.equal(s.claimDeletionResource({...f.claim,actionId:'another-new-id'}),false);assert.equal(s.claimDeletionResource({...f.claim,actionId:f.oldActionId}),false);assert.equal(s.db.prepare('SELECT state FROM deletion_recovery_grants').get().state,'consumed');
 }finally{s.close();}
});
test('recovery expiry, actor, ID, request, installed module and snapshot mismatches never consume the grant',()=>{
 for(const patch of [{actor:'Miguel'},{actionId:'unreviewed-action'},{requestHash:'d'.repeat(64)},{moduleSha256:'e'.repeat(64)},{snapshotSha256:'f'.repeat(64)}]){
  const f=recoveryFixture();try{f.store.authorizeDeletionRecovery(f.review);f.store.approveAction(f.newActionId,'Nerea');f.store.claimApprovedAction(f.newActionId);assert.equal(f.store.claimDeletionResource({...f.claim,...patch}),false);assert.equal(f.store.db.prepare('SELECT state FROM deletion_recovery_grants').get().state,'available');assert.equal(f.store.deletionResource(f.resource).action_id,f.oldActionId);}finally{f.store.close();}
 }
 const f=recoveryFixture(),now=Date.now;try{f.store.authorizeDeletionRecovery(f.review);f.store.approveAction(f.newActionId,'Nerea');f.store.claimApprovedAction(f.newActionId);Date.now=()=>f.review.expiresAtMs;assert.equal(f.store.claimDeletionResource(f.claim),false);assert.equal(f.store.db.prepare('SELECT state FROM deletion_recovery_grants').get().state,'available');}finally{Date.now=now;f.store.close();}
});
test('grant authorization requires two fresh exact reads; original row drift blocks transfer without consumption',()=>{
 for(const change of [r=>r.readbacks.pop(),r=>r.readbacks[0].snapshotSha256='f'.repeat(64),r=>r.readbacks[0].atMs-=31000,r=>r.expiresAtMs+=1]){
  const f=recoveryFixture();try{const bad=structuredClone(f.review);change(bad);assert.throws(()=>f.store.authorizeDeletionRecovery(bad),/evidence/);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM deletion_recovery_grants').get().n,0);}finally{f.store.close();}
 }
 const f=recoveryFixture();try{f.store.authorizeDeletionRecovery(f.review);f.store.approveAction(f.newActionId,'Nerea');f.store.claimApprovedAction(f.newActionId);f.store.db.prepare("UPDATE approved_actions SET last_error='new independently observed information' WHERE action_id=?").run(f.oldActionId);assert.equal(f.store.claimDeletionResource(f.claim),false);assert.equal(f.store.db.prepare('SELECT state FROM deletion_recovery_grants').get().state,'available');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM deletion_resource_recovery_audit').get().n,0);}finally{f.store.close();}
});
test('reviewed grant and immutable audit survive restart, with one winner across concurrent processes',async()=>{
 const {writeFileSync,rmSync}=await import('node:fs'),{fork}=await import('node:child_process'),f=recoveryFixture();f.store.authorizeDeletionRecovery(f.review);f.store.approveAction(f.newActionId,'Nerea');f.store.claimApprovedAction(f.newActionId);f.store.close();
 const script=join(f.directory,'reviewed-claim.mjs');writeFileSync(script,`import {SibemaStore} from ${JSON.stringify(new URL('../lib/store.mjs',import.meta.url).href)};const s=new SibemaStore(process.argv[2]);process.on('message',()=>{const claimed=s.claimDeletionResource(JSON.parse(process.argv[3]));s.close();process.send({claimed},()=>process.exit(0));});process.send({ready:true});`);
 const children=[0,1].map(()=>fork(script,[f.path,JSON.stringify(f.claim)],{execArgv:[],silent:true}));
 try{
  await Promise.all(children.map(c=>new Promise((resolve,reject)=>{c.once('error',reject);c.once('exit',code=>{if(code)reject(Error('claim child failed'));});c.once('message',m=>m.ready?resolve():reject(Error('missing ready')));})));const results=children.map(c=>new Promise((resolve,reject)=>{c.once('error',reject);c.once('message',m=>resolve(m.claimed));}));children.forEach(c=>c.send('claim'));assert.deepEqual((await Promise.all(results)).sort(),[false,true]);
  await Promise.all(children.map(c=>new Promise(resolve=>c.exitCode!==null?resolve():c.once('exit',resolve))));const s=new SibemaStore(f.path);try{assert.equal(s.db.prepare('SELECT COUNT(*) n FROM deletion_resource_recovery_audit').get().n,1);assert.equal(s.db.prepare('SELECT state FROM deletion_recovery_grants').get().state,'consumed');assert.equal(s.approvedAction(f.oldActionId).status,'uncertain');}finally{s.close();}
 }finally{children.forEach(c=>{if(c.exitCode===null)c.kill();});rmSync(f.directory,{recursive:true,force:true});}
});
