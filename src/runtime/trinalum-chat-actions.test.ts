import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectorFingerprint } from '@/connectors/canonical';
import { TrinalumChatActions, requiresExactEmailReview, type ChatAction } from './trinalum-chat-actions';

const userId='11111111-1111-4111-8111-111111111111';
const identity={installationId:'trinalum-production',userId,threadId:'thread'};
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'trinalum-chat-actions-'));roots.push(root);const userRoot=path.join(root,userId);await mkdir(userRoot);return {root,userRoot,store:new TrinalumChatActions(userRoot,identity)};}
function proposal(patch:Partial<ChatAction>={}):ChatAction {
 const operation='mail_action';const input={type:'send_mail',request:{message:{subject:'QA',body:'Exact final body'}}};
 const permissionFingerprint='a'.repeat(64),bindingHash='b'.repeat(64),sourceMessageId='message-1',turnId='runtime-turn';
 const fingerprint=connectorFingerprint({...identity,turnId,sourceMessageId,tool:operation,input,permissionFingerprint,bindingHash});const id=`web-${fingerprint}`;
 return {version:1,id,...identity,sourceTurnId:'assistant-source',sourceMessageId,operation,input,locator:{...identity,turnId,itemId:id,approvalId:id},fingerprint,bindingHash,permissionFingerprint,prepared:{sender:'qa@example.test',body:'Exact final body'},preview:'Exact immutable email preview',displayedAt:null,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),...patch};
}
const recordPath=(userRoot:string,id:string)=>path.join(userRoot,'trinalum-chat-actions',createHash('sha256').update(identity.threadId).digest('hex'),`${id}.json`);

describe('server-owned Trinalum chat proposals',()=>{
 it('durably freezes a proposal and makes preparation idempotent',async()=>{
  const f=await fixture();const record=proposal();await f.store.prepare(record);const restarted=new TrinalumChatActions(f.userRoot,identity);expect(await restarted.read(record.id)).toEqual(record);
  expect(await restarted.prepare({...record,preview:'Replacement preview must not replace original'})).toEqual(record);expect((await restarted.read(record.id))?.preview).toBe(record.preview);
 });
 it('does not expose an unshown proposal as an approved/displayed preview',async()=>{
  const f=await fixture();const record=proposal();await f.store.prepare(record);expect(await f.store.previewsForTurn(record.sourceTurnId)).toEqual([]);
  await f.store.displayed(record.id);const displayed=await f.store.previewsForTurn(record.sourceTurnId);expect(displayed).toHaveLength(1);expect(displayed[0].displayedAt).toEqual(expect.any(String));expect(await f.store.previewsForTurn('another-turn')).toEqual([]);
 });
 it('rejects record payload, actor, thread, binding or permission tampering',async()=>{
  for(const mutate of [(r:ChatAction)=>{r.input={type:'send_mail',request:{message:{subject:'tampered'}}};},(r:ChatAction)=>{r.userId='22222222-2222-4222-8222-222222222222';},(r:ChatAction)=>{r.threadId='other-thread';},(r:ChatAction)=>{r.bindingHash='c'.repeat(64);},(r:ChatAction)=>{r.permissionFingerprint='d'.repeat(64);}]){
   const f=await fixture();const record=proposal();await f.store.prepare(record);const altered=structuredClone(record);mutate(altered);await writeFile(recordPath(f.userRoot,record.id),JSON.stringify(altered));await expect(f.store.read(record.id)).rejects.toThrow('CHAT_ACTION_RECORD_INVALID');
  }
 });
 it('never reads a proposal through another employee/thread or a caller-provided path',async()=>{
  const f=await fixture();const record=proposal();await f.store.prepare(record);
  await expect(new TrinalumChatActions(f.userRoot,{...identity,userId:'22222222-2222-4222-8222-222222222222'}).read(record.id)).rejects.toThrow();
  expect(await new TrinalumChatActions(f.userRoot,{...identity,threadId:'another-thread'}).read(record.id)).toBeNull();
  await expect(f.store.read('../../private')).rejects.toThrow('CHAT_ACTION_ID_INVALID');
  expect(()=>new TrinalumChatActions(f.userRoot,{...identity,installationId:'arnall'})).toThrow('CHAT_ACTION_IDENTITY_INVALID');
 });
 it('rejects linked private proposal directories and preserves the outside target',async()=>{
  const f=await fixture();const outside=await mkdtemp(path.join(tmpdir(),'trinalum-chat-outside-'));roots.push(outside);await symlink(outside,path.join(f.userRoot,'trinalum-chat-actions'));
  await expect(f.store.prepare(proposal())).rejects.toThrow('CHAT_ACTION_PATH_UNSAFE');
 });
 it('concurrent preparations preserve one exact source and one proposal',async()=>{
  const f=await fixture();const record=proposal();const results=await Promise.all([f.store.prepare(record),f.store.prepare(record)]);expect(results[0]).toEqual(results[1]);expect(JSON.parse(await readFile(recordPath(f.userRoot,record.id),'utf8')).fingerprint).toBe(record.fingerprint);
 });
});

describe('server-bound exact email review boundary',()=>{
 it('allows the three verified employees to send from their own native account',()=>{
  for(const actor of ['manager@example.invalid','sales@example.invalid','administration@example.invalid']){
   const action=proposal({prepared:{data:{preview:{from:actor,mailbox:actor}}}});
   expect(requiresExactEmailReview(action,actor)).toBe(false);
   expect(requiresExactEmailReview(action,' '+actor.toUpperCase()+' ')).toBe(false);
  }
 });
 it('preserves exact review for David, absent identity or a mismatched native sender',()=>{
  const actor='manager@example.invalid';const action=proposal({prepared:{data:{preview:{from:actor,mailbox:actor}}}});
  for(const identity of [undefined,'david@example.test','sales@example.invalid'])expect(requiresExactEmailReview(action,identity)).toBe(true);
  for(const preview of [{from:actor},{mailbox:actor},{from:'david@example.test',mailbox:actor}])expect(requiresExactEmailReview({...action,prepared:{data:{preview}}},actor)).toBe(true);
 });
 it('applies the account boundary to every outgoing operation, never ordinary mailbox/CRM/ERP actions',()=>{
  for(const type of ['send_mail','reply','reply_all','forward','send_draft'])expect(requiresExactEmailReview(proposal({input:{type}}))).toBe(true);
  for(const type of ['create_draft','update_draft','move_message','delete_message','add_attachment'])expect(requiresExactEmailReview(proposal({input:{type}}))).toBe(false);
  for(const operation of ['attio_action','sibema_action','mail_draft'])expect(requiresExactEmailReview(proposal({operation,input:{type:'create_draft'}}))).toBe(false);
 });
});
