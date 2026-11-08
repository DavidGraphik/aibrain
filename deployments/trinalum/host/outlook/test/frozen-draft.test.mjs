import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,chmod,symlink,realpath} from 'node:fs/promises';
import {tmpdir as nativeTmpdir} from 'node:os';
import {realpathSync as canonicalTmpPath} from 'node:fs';
const tmpdir=()=>canonicalTmpPath(nativeTmpdir());
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {freezeComposedDraft,draftReview} from '../lib/frozen-draft.mjs';
const source=()=>({id:'qa-draft-001',type:'create_draft',mailbox:'owner@example.com',requestedBy:'Nerea',request:{message:{subject:'QA - NO ENVIAR',body:{contentType:'Text',content:'Texto completo'},toRecipients:[{emailAddress:{address:'owner@example.com'}}]}}});
const fixture=async()=>{const root=await realpath(await mkdtemp(join(tmpdir(),'frozen-draft-')));return {root,output:join(root,'frozen.json')};};
test('approval preview includes the final signature and original attachment hash; repeat does not reread or change them',async()=>{
 const {root,output}=await fixture();try{
  const input=source(),before=structuredClone(input),bytes=Buffer.from('original PDF bytes');let calls=0;
  const frozen=await freezeComposedDraft(input,output,async a=>{calls++;a.request.message.body.content+='\nFirma verificada';a.request.message.attachments=[{name:'original.pdf',contentBytes:bytes.toString('base64')}];return a;});
  assert.deepEqual(input,before);
  const preview=draftReview(frozen);assert.equal(preview.request.message.body.content,'Texto completo\nFirma verificada');
  assert.deepEqual(preview.request.message.attachments[0].contentBytes,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  const repeated=await freezeComposedDraft(input,output,async()=>{throw Error('Must not reread signature or attachments');});assert.deepEqual(repeated,frozen);assert.equal(calls,1);
  await assert.rejects(freezeComposedDraft({...input,mailbox:'foreign@example.com'},output,async a=>a),{code:'FROZEN_DRAFT_MISMATCH'});
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')),frozen);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('changed prepared content, symlinks and public files fail closed before execution',async()=>{
 const {root,output}=await fixture();try{
  const frozen=await freezeComposedDraft(source(),output,async a=>a);
  const changed=structuredClone(frozen);changed.request.message.body.content='Changed after approval';await writeFile(output,JSON.stringify(changed),{mode:0o600});
  await assert.rejects(freezeComposedDraft(source(),output,async a=>a),{code:'FROZEN_DRAFT_MISMATCH'});
  await writeFile(output,JSON.stringify(frozen));await chmod(output,0o644);
  await assert.rejects(freezeComposedDraft(source(),output,async a=>a),{code:'FROZEN_DRAFT_MISMATCH'});
  await chmod(output,0o600);const link=join(root,'linked.json');await symlink(output,link);
  await assert.rejects(freezeComposedDraft(source(),link,async a=>a),{code:'FROZEN_DRAFT_MISMATCH'});
 }finally{await rm(root,{recursive:true,force:true});}
});
