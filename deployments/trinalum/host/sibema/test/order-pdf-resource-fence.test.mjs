import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SibemaStore} from '../lib/store.mjs';

test('independent connections cannot claim the same order and filename', () => {
  const dir=mkdtempSync(join(tmpdir(),'pdf-fence-')); let a,b;
  try {
    a=new SibemaStore(join(dir,'state.sqlite')); b=new SibemaStore(join(dir,'state.sqlite'));
    const first=a.claimOrderPdfResource(12,'invoice.pdf','action-a');
    assert.throws(()=>b.claimOrderPdfResource(12,'invoice.pdf','action-b'),/already fenced/);
    const other=b.claimOrderPdfResource(12,'other.pdf','action-b');
    assert.throws(()=>b.releaseOrderPdfResource(first,'action-b'),/changed/);
    b.releaseOrderPdfResource(other,'action-b');
    a.close(); a=null; // A crash or lost response must never silently unlock.
    assert.throws(()=>b.claimOrderPdfResource(12,'invoice.pdf','action-b'),/already fenced/);
    b.releaseOrderPdfResource(first,'action-a');
    assert.ok(b.claimOrderPdfResource(12,'invoice.pdf','action-b'));
  } finally {a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});

test('only a durable verified completed receipt may recover a stranded fence', () => {
  const dir=mkdtempSync(join(tmpdir(),'pdf-recovery-')); let a,b;
  try {
    a=new SibemaStore(join(dir,'state.sqlite'));b=new SibemaStore(join(dir,'state.sqlite'));
    const request={orderId:12,body:{filename:'invoice.pdf'}};
    a.db.prepare("INSERT INTO approved_actions(action_id,action_type,request_hash,request_json,status,requested_by,created_at) VALUES(?,?,?,?,?,?,?)").run('action-a','attach_order_pdf','x',JSON.stringify(request),'executing','Trini',new Date().toISOString());
    a.claimOrderPdfResource(12,'invoice.pdf','action-a');
    assert.throws(()=>b.claimOrderPdfResource(12,'invoice.pdf','action-b'),/already fenced/);
    a.db.prepare("UPDATE approved_actions SET status='uncertain' WHERE action_id='action-a'").run();
    assert.throws(()=>b.claimOrderPdfResource(12,'invoice.pdf','action-b'),/already fenced/);
    a.db.prepare("UPDATE approved_actions SET status='completed',readback_json=? WHERE action_id='action-a'").run(JSON.stringify({order_id:12,filename:'invoice.pdf',independent_readback:true,sha256:'invalid'}));
    assert.throws(()=>b.claimOrderPdfResource(12,'invoice.pdf','action-b'),/already fenced/);
    a.db.prepare("UPDATE approved_actions SET status='completed',readback_json=? WHERE action_id='action-a'").run(JSON.stringify({order_id:12,filename:'invoice.pdf',independent_readback:true,sha256:'a'.repeat(64)}));
    const recovered=b.claimOrderPdfResource(12,'invoice.pdf','action-b');
    assert.ok(recovered);assert.throws(()=>a.releaseOrderPdfResource(recovered,'action-a'),/changed/);
  } finally {a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});

test('order fence serializes attach and remove and recovers only proven-dead checking',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pdf-order-'));let a,b;const boot='11111111-1111-4111-8111-111111111111',ns='pid:[1]';
 try{
  a=new SibemaStore(join(dir,'state.sqlite'));b=new SibemaStore(join(dir,'state.sqlite'));let dead=false;
  a.pdfProcessIdentity=pid=>({boot,pid,ns,start:'100',gone:false});b.pdfProcessIdentity=pid=>pid===101?{boot,pid,ns,start:'100',gone:dead}:{boot,pid,ns,start:'200',gone:false};
  const first=a.claimOrderPdfOrder(12,'attach-a');a.db.prepare('UPDATE order_pdf_order_fences SET pid=101 WHERE order_id=12').run();
  assert.throws(()=>b.claimOrderPdfOrder(12,'remove-b'),/already fenced/);dead=true;
  const second=b.claimOrderPdfOrder(12,'remove-b');assert.equal(second.actionId,'remove-b');assert.equal(a.releaseOrderPdfChecking(first),false);
  b.dispatchOrderPdfOrder(second);assert.throws(()=>a.claimOrderPdfOrder(12,'attach-c'),/uncertain/);assert.equal(b.releaseOrderPdfChecking(second),false);
 }finally{a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});

test('checking recovery fails closed when process identity is unreadable, dispatch stays fenced, verified receipts recover',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pdf-phases-'));let a,b;const boot='11111111-1111-4111-8111-111111111111',ns='pid:[1]',content=Buffer.from('%PDF-synthetic').toString('base64');
 try{
  a=new SibemaStore(join(dir,'state.sqlite'));b=new SibemaStore(join(dir,'state.sqlite'));a.pdfProcessIdentity=pid=>({boot,pid,ns,start:'123',gone:false});
  b.pdfProcessIdentity=pid=>{if(pid===101)throw Error('unreadable');return {boot,pid,ns,start:'456',gone:false}};
  const req={orderId:12,body:{filename:'invoice.pdf',content_base64:content}};a.prepareApprovedAction({id:'attach-1',type:'attach_order_pdf',request:req,requestedBy:'Trini'});const first=a.claimOrderPdfOrder(12,'attach-1');a.db.prepare('UPDATE order_pdf_order_fences SET pid=101 WHERE order_id=12').run();
  assert.throws(()=>b.claimOrderPdfOrder(12,'remove-2'),/unreadable/);a.db.prepare('UPDATE order_pdf_order_fences SET pid=? WHERE order_id=12').run(process.pid);a.dispatchOrderPdfOrder(first);
  a.db.prepare("UPDATE approved_actions SET status='uncertain' WHERE action_id='attach-1'").run();assert.throws(()=>b.claimOrderPdfOrder(12,'remove-2'),/uncertain/);
  const hash=createHash('sha256').update(Buffer.from(content,'base64')).digest('hex');a.db.prepare("UPDATE approved_actions SET status='completed', result_json=?, readback_json=? WHERE action_id='attach-1'").run(JSON.stringify({created:true,file_id:7}),JSON.stringify({order_id:12,file_id:7,filename:'invoice.pdf',independent_readback:true,order_preserved:true,other_files_preserved:true,sha256:'0'.repeat(64)}));assert.throws(()=>b.claimOrderPdfOrder(12,'remove-2'),/uncertain/);
  a.db.prepare("UPDATE approved_actions SET readback_json=? WHERE action_id='attach-1'").run(JSON.stringify({order_id:12,file_id:7,filename:'invoice.pdf',independent_readback:true,order_preserved:true,other_files_preserved:true,sha256:hash}));assert.ok(b.claimOrderPdfOrder(12,'remove-2'));
 }finally{a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});

test('completed removal recovers only when order, file, byte hash and other files are proved',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pdf-remove-proof-'));let a,b;const boot='11111111-1111-4111-8111-111111111111',ns='pid:[1]',sha='a'.repeat(64);
 try{
  a=new SibemaStore(join(dir,'state.sqlite'));b=new SibemaStore(join(dir,'state.sqlite'));for(const s of [a,b])s.pdfProcessIdentity=pid=>({boot,pid,ns,start:'100',gone:false});
  const request={orderId:12,fileId:7,body:{expectedFilename:'invoice.pdf',expectedSha256:sha}};a.prepareApprovedAction({id:'remove-1',type:'remove_order_pdf',request,requestedBy:'Trini'});const claim=a.claimOrderPdfOrder(12,'remove-1');a.dispatchOrderPdfOrder(claim);
  const proof={order_id:12,file_id:7,removed:true,original_sha256:sha,independent_readback:true,order_preserved:true,other_files_preserved:true};const setProof=v=>a.db.prepare("UPDATE approved_actions SET status='completed',result_json=?,readback_json=? WHERE action_id='remove-1'").run(JSON.stringify({removed:true,file_id:7}),JSON.stringify(v));
  setProof({...proof,other_files_preserved:false});assert.throws(()=>b.claimOrderPdfOrder(12,'attach-2'),/uncertain/);setProof({...proof,file_id:8});assert.throws(()=>b.claimOrderPdfOrder(12,'attach-2'),/uncertain/);setProof(proof);assert.ok(b.claimOrderPdfOrder(12,'attach-2'));
 }finally{a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});

test('action claim and order fence commit atomically, abandoned checking can be retried',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pdf-atomic-'));let s;const boot='11111111-1111-4111-8111-111111111111',ns='pid:[1]';let dead=false;
 try{
  s=new SibemaStore(join(dir,'state.sqlite'));s.pdfProcessIdentity=pid=>pid===101?{boot,pid,ns,start:'100',gone:dead}:{boot,pid,ns,start:'200',gone:false};
  for(const id of ['action-one','action-two']){s.prepareApprovedAction({id,type:'attach_order_pdf',request:{orderId:12,body:{filename:'invoice.pdf',content_base64:'JVBERi0='}},requestedBy:'Trini'});s.approveAction(id,'Trini');}
  const first=s.claimOrderPdfOrder(12,'action-one',{claimApproved:true,approvedBy:'Trini'});assert.equal(s.approvedAction('action-one').status,'executing');s.db.prepare('UPDATE order_pdf_order_fences SET pid=101,start_ticks=100 WHERE order_id=12').run();
  assert.throws(()=>s.claimOrderPdfOrder(12,'action-two',{claimApproved:true,approvedBy:'Trini'}),/already fenced/);assert.equal(s.approvedAction('action-two').status,'approved');assert.equal(s.approvedAction('action-one').status,'executing');
  dead=true;const second=s.claimOrderPdfOrder(12,'action-two',{claimApproved:true,approvedBy:'Trini'});assert.equal(s.approvedAction('action-one').status,'failed');assert.equal(s.approvedAction('action-two').status,'executing');assert.equal(s.releaseOrderPdfChecking(first),false);assert.equal(s.releaseOrderPdfChecking(second),true);
 }finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});

test('legacy completed fence is reconciled only with exact durable independent proof',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pdf-legacy-proof-'));let s;const boot='11111111-1111-4111-8111-111111111111',ns='pid:[1]',content=Buffer.from('%PDF-synthetic').toString('base64'),sha=createHash('sha256').update(Buffer.from(content,'base64')).digest('hex');
 try{
  s=new SibemaStore(join(dir,'state.sqlite'));s.pdfProcessIdentity=pid=>({boot,pid,ns,start:'100',gone:false});const request={orderId:12,body:{filename:'invoice.pdf',content_base64:content}};s.prepareApprovedAction({id:'legacy-1',type:'attach_order_pdf',request,requestedBy:'Trini'});s.claimOrderPdfResource(12,'invoice.pdf','legacy-1');
  assert.throws(()=>s.claimOrderPdfOrder(12,'new-action'),/reconciliation/);s.db.prepare("UPDATE approved_actions SET status='completed',result_json=?,readback_json=? WHERE action_id='legacy-1'").run(JSON.stringify({created:true,file_id:7}),JSON.stringify({order_id:12,file_id:7,filename:'invoice.pdf',sha256:sha,independent_readback:true,order_preserved:true,other_files_preserved:true}));
  assert.ok(s.claimOrderPdfOrder(12,'new-action'));assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM order_pdf_resource_fences').get().n,0);
 }finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});

test('checking after reboot can recover, same-boot namespace mismatch cannot',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pdf-boot-'));let s;let boot='11111111-1111-4111-8111-111111111111',ns='pid:[1]';
 try{s=new SibemaStore(join(dir,'state.sqlite'));s.pdfProcessIdentity=pid=>({boot,pid,ns,start:'100',gone:false});s.claimOrderPdfOrder(12,'action-one');ns='pid:[2]';assert.throws(()=>s.claimOrderPdfOrder(12,'action-two'),/namespace/);boot='22222222-2222-4222-8222-222222222222';assert.ok(s.claimOrderPdfOrder(12,'action-two'));}
 finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});


test('same action recovers a dead checking owner atomically, but never a dispatch',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pdf-same-action-'));let s;const boot='11111111-1111-4111-8111-111111111111',ns='pid:[1]';let dead=false;
 try{
  s=new SibemaStore(join(dir,'state.sqlite'));s.pdfProcessIdentity=pid=>pid===101?{boot,pid,ns,start:'100',gone:dead}:{boot,pid,ns,start:'200',gone:false};
  s.prepareApprovedAction({id:'same-action',type:'attach_order_pdf',request:{orderId:12,body:{filename:'invoice.pdf',content_base64:'JVBERi0='}},requestedBy:'Trini'});
  const first=s.claimOrderPdfOrder(12,'same-action',{claimApproved:true,approvedBy:'Trini'});s.db.prepare('UPDATE order_pdf_order_fences SET pid=101,start_ticks=100 WHERE order_id=12').run();
  assert.throws(()=>s.claimOrderPdfOrder(12,'same-action',{claimApproved:true,approvedBy:'Trini'}),/already fenced/);assert.equal(s.approvedAction('same-action').status,'executing');
  dead=true;assert.throws(()=>s.claimOrderPdfOrder(12,'same-action',{claimApproved:true,approvedBy:'Miguel'}),/identity mismatch/);assert.equal(s.approvedAction('same-action').status,'executing');assert.equal(s.db.prepare('SELECT pid FROM order_pdf_order_fences WHERE order_id=12').get().pid,101);
  const recovered=s.claimOrderPdfOrder(12,'same-action',{claimApproved:true,approvedBy:'Trini'});assert.equal(s.approvedAction('same-action').status,'executing');const audit=s.db.prepare('SELECT old_action_id,new_action_id,old_phase,reason FROM order_pdf_fence_recoveries').get();assert.deepEqual({...audit},{old_action_id:'same-action',new_action_id:'same-action',old_phase:'checking',reason:'dead_before_dispatch'});assert.equal(s.releaseOrderPdfChecking({...first,pid:101,start:'100'}),false);s.dispatchOrderPdfOrder(recovered);
  assert.throws(()=>s.claimOrderPdfOrder(12,'same-action',{claimApproved:true,approvedBy:'Trini'}),/uncertain/);assert.equal(s.approvedAction('same-action').status,'executing');assert.equal(s.db.prepare('SELECT phase FROM order_pdf_order_fences WHERE order_id=12').get().phase,'dispatch');
 }finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});
