import test from 'node:test';
import assert from 'node:assert/strict';
import {operationFor, verifyTaskTargets, readBack, taskTargetsMatch} from '../bin/attio-action.mjs';
const member='11111111-1111-4111-8111-111111111111';
const record='22222222-2222-4222-8222-222222222222';
const base={content:'Synthetic administrative task',deadlineAt:'2026-11-08T12:00:00+01:00'};
const operation=request=>operationFor({type:'create_task',request});
test('unassigned unlinked native task preserves explicit empty targets',async()=>{
  const request={...base,assignees:[],linked_records:[]};
  assert.deepEqual(operation(request).body.data,{content:base.content,format:'plaintext',deadline_at:base.deadlineAt,is_completed:false,assignees:[],linked_records:[]});
  const calls=[];await verifyTaskTargets({get:async path=>{calls.push(path);return {data:[]};}},request);
  assert.deepEqual(calls,['/tasks?limit=1']);
});
test('legacy selectors retain exact payload and provider verification',async()=>{
  const request={...base,parentObject:'companies',recordId:record,assigneeId:member};const calls=[];
  const data=operation(request).body.data;
  assert.deepEqual(data.linked_records,[{target_object:'companies',target_record_id:record}]);
  assert.deepEqual(data.assignees,[{referenced_actor_type:'workspace-member',referenced_actor_id:member}]);
  await verifyTaskTargets({get:async path=>{calls.push(path);return {data:[{id:{workspace_member_id:member}}]};}},request);
  assert.deepEqual(calls,['/tasks?limit=1','/workspace_members','/objects/companies/records/'+record]);
});
test('native targets receive member and linked record verification',async()=>{
  const request={...base,assignees:[{referenced_actor_type:'workspace-member',referenced_actor_id:member}],linked_records:[{target_object:'people',target_record_id:record}]};
  const calls=[];await verifyTaskTargets({get:async path=>{calls.push(path);return {data:[{id:{workspace_member_id:member}}]};}},request);
  assert.equal(calls.at(-1),'/objects/people/records/'+record);
  await assert.rejects(verifyTaskTargets({get:async()=>({data:[]})},request),/not a verified/);
  await assert.rejects(verifyTaskTargets({get:async path=>{if(path.startsWith('/objects/'))throw Error('record inaccessible');return {data:[{id:{workspace_member_id:member}}]};}},request),/record inaccessible/);
});
test('mixed selectors, invalid targets and invalid deadlines fail before preparation',()=>{
  for(const patch of [{recordId:record,linked_records:[]},{assigneeId:member,assignees:[]},{recordId:record,assignees:[]},{parentObject:'companies'},{linked_records:null},{assignees:null},{linked_records:[{target_object:'foreign',target_record_id:record}]},{linked_records:[{target_object:'companies',target_record_id:'../x'}]},{assignees:[{referenced_actor_type:'user',referenced_actor_id:member}]},{assignees:[{referenced_actor_type:'workspace-member',referenced_actor_id:'../x'}]},{deadlineAt:'2026-11-08'}])assert.throws(()=>operation({...base,...patch}));
});

test('native empty-target readback accepts exact state and rejects unintended targets',async()=>{
  const request={...base,assignees:[],linked_records:[]};
  const task={id:{task_id:record},content_plaintext:base.content,deadline_at:base.deadlineAt,assignees:[],linked_records:[]};
  const client={get:async()=>({data:task})};
  assert.equal(await readBack(client,{action_type:'create_task',request},{data:task}),task);
  assert.equal(taskTargetsMatch(request,task),true);
  task.assignees=[{referenced_actor_type:'workspace-member',referenced_actor_id:member}];
  assert.equal(taskTargetsMatch(request,task),false);
  await assert.rejects(readBack(client,{action_type:'create_task',request},{data:task}),/readback does not match/);
  task.assignees=[];task.linked_records=[{target_record_id:record}];
  await assert.rejects(readBack(client,{action_type:'create_task',request},{data:task}),/readback does not match/);
});

test('omitted or null deadline remains undated through provider payload and readback',async()=>{
  for(const deadline of [{},{deadlineAt:null}]){
    const request={content:base.content,...deadline,assignees:[],linked_records:[]};
    assert.equal(operation(request).body.data.deadline_at,null);
    const task={id:{task_id:record},content_plaintext:base.content,deadline_at:null,assignees:[],linked_records:[]};
    assert.equal(await readBack({get:async()=>({data:task})},{action_type:'create_task',request},{data:task}),task);
    task.deadline_at=base.deadlineAt;
    await assert.rejects(readBack({get:async()=>({data:task})},{action_type:'create_task',request},{data:task}),/readback does not match/);
  }
});

test('legacy dated readback retains existing linked record and owner checks',async()=>{
 const request={...base,recordId:record,assigneeId:member};
 const task={id:{task_id:record},content_plaintext:base.content,deadline_at:base.deadlineAt,assignees:[{referenced_actor_id:member}],linked_records:[{target_record_id:record}]};
 const client={get:async()=>({data:task})};
 assert.equal(await readBack(client,{action_type:'create_task',request},{data:task}),task);
 task.assignees=[];
 await assert.rejects(readBack(client,{action_type:'create_task',request},{data:task}),/readback does not match/);
});
