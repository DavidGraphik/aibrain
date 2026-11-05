import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {SibemaStore} from '../lib/store.mjs';

test('Linux processes: a killed check can recover; killed dispatch cannot replay',{skip:process.platform!=='linux'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sibema-pdf-linux-')),database=join(dir,'synthetic.sqlite');let store,child;
 const source=`import {SibemaStore} from ${JSON.stringify(new URL('../lib/store.mjs',import.meta.url).href)};const s=new SibemaStore(process.argv[1]);const c=s.claimOrderPdfOrder(12,process.argv[2]);if(process.argv[3]==='dispatch')s.dispatchOrderPdfOrder(c);console.log('READY');setInterval(()=>{},1000);`;
 const run=async(action,phase)=>{const proc=spawn(process.execPath,['--experimental-sqlite','--input-type=module','-e',source,database,action,phase],{stdio:['ignore','pipe','pipe']});const [data]=await once(proc.stdout,'data');assert.match(String(data),/READY/);return proc;};
 const kill=async proc=>{const done=once(proc,'exit');proc.kill('SIGKILL');await done;};
 try{
  store=new SibemaStore(database);child=await run('synthetic-a','checking');assert.throws(()=>store.claimOrderPdfOrder(12,'synthetic-b'),/already fenced/);await kill(child);child=null;
  const c=store.claimOrderPdfOrder(12,'synthetic-b');assert.equal(store.releaseOrderPdfChecking(c),true);
  child=await run('synthetic-c','dispatch');await kill(child);child=null;assert.throws(()=>store.claimOrderPdfOrder(12,'synthetic-d'),/uncertain/);
 }finally{if(child)await kill(child);store?.close();rmSync(dir,{recursive:true,force:true});}
});


test('Linux hidden /proc entry never counts as dead if signal-zero succeeds or is denied',{skip:process.platform!=='linux'},()=>{
 const dir=mkdtempSync(join(tmpdir(),'sibema-pdf-probe-'));let s;const real=process.kill;
 try{s=new SibemaStore(join(dir,'synthetic.sqlite'));process.kill=()=>true;assert.throws(()=>s.pdfProcessIdentity(999999999),/hidden/);process.kill=()=>{throw Object.assign(Error('denied'),{code:'EPERM'})};assert.throws(()=>s.pdfProcessIdentity(999999999),/denied/);}
 finally{process.kill=real;s?.close();rmSync(dir,{recursive:true,force:true});}
});

test('Linux same action ID recovers after checking crash but not after dispatch',{skip:process.platform!=='linux'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sibema-pdf-same-')),database=join(dir,'synthetic.sqlite');let store,child;
 const moduleUrl=new URL('../lib/store.mjs',import.meta.url).href;
 const source=`import {SibemaStore} from ${JSON.stringify(moduleUrl)};const s=new SibemaStore(process.argv[1]);s.prepareApprovedAction({id:'same-action',type:'attach_order_pdf',request:{orderId:12,body:{filename:'fixture.pdf',content_base64:'JVBERi0='}},requestedBy:'Trini'});const c=s.claimOrderPdfOrder(12,'same-action',{claimApproved:true,approvedBy:'Trini'});console.log('READY');setInterval(()=>{},1000);`;
 try{
  child=spawn(process.execPath,['--experimental-sqlite','--input-type=module','-e',source,database],{stdio:['ignore','pipe','pipe']});const [data]=await once(child.stdout,'data');assert.match(String(data),/READY/);store=new SibemaStore(database);assert.throws(()=>store.claimOrderPdfOrder(12,'same-action',{claimApproved:true,approvedBy:'Trini'}),/already fenced/);
  const done=once(child,'exit');child.kill('SIGKILL');await done;child=null;const claim=store.claimOrderPdfOrder(12,'same-action',{claimApproved:true,approvedBy:'Trini'});assert.equal(store.approvedAction('same-action').status,'executing');assert.equal(store.db.prepare('SELECT reason FROM order_pdf_fence_recoveries').get().reason,'dead_before_dispatch');store.dispatchOrderPdfOrder(claim);assert.throws(()=>store.claimOrderPdfOrder(12,'same-action',{claimApproved:true,approvedBy:'Trini'}),/uncertain/);
 }finally{if(child){const done=once(child,'exit');child.kill('SIGKILL');await done;}store?.close();rmSync(dir,{recursive:true,force:true});}
});
