import test from 'node:test';
import assert from 'node:assert/strict';
import {orderedFolderPairs} from '../lib/mail-parallel-folders.mjs';

function fixture(spec){
 let active=0,max=0,aborted=0;
 const probe=({index,signal})=>new Promise((resolve,reject)=>{
  active++;max=Math.max(max,active);let done=false;
  const end=(fn,value)=>{if(done)return;done=true;active--;signal.removeEventListener('abort',cancel);fn(value);};
  const cancel=()=>{aborted++;clearTimeout(id);end(reject,Error('aborted'));};
  const item=spec[index],id=setTimeout(()=>item.error?end(reject,Error('provider')):end(resolve,{messages:item.messages??[],exhausted:item.exhausted??true,validity:'99'}),item.delay);
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
 });
 return {probe,get active(){return active},get max(){return max},get aborted(){return aborted}};
}
test('two connections process in catalog order even if later folder finishes first',async()=>{
 const f=fixture([{delay:40,messages:['first']},{delay:1,messages:['second']}]);
 const r=await orderedFolderPairs({folders:['a','b'],probe:f.probe,timeoutMs:500});
 assert.equal(f.max,2);assert.equal(r.pages[0].messages[0],'first');assert.equal(r.nextIndex,1);assert.equal(r.complete,false);assert.equal(r.stopped,'matches_found');
});
test('advances only contiguous exhausted folders; later page cannot skip a partial earlier folder',async()=>{
 const f=fixture([{delay:20,exhausted:false},{delay:1,messages:['later']}]);
 const r=await orderedFolderPairs({folders:['a','b'],probe:f.probe,timeoutMs:500});
 assert.equal(r.nextIndex,0);assert.equal(r.pages.length,1);assert.equal(r.stopped,'partial_folder');
});
test('provider failure and deadline preserve incomplete coverage and cancel pending work',async()=>{
 const fail=fixture([{delay:5,error:true},{delay:100,messages:['later']}]);
 const a=await orderedFolderPairs({folders:['a','b'],probe:fail.probe,timeoutMs:500});
 assert.equal(a.nextIndex,0);assert.equal(a.complete,false);assert.equal(a.stopped,'folder_error');assert.equal(fail.active,0);assert.equal(fail.aborted,1);
 const hung=fixture([{delay:1000},{delay:1000}]);const begin=performance.now();
 const b=await orderedFolderPairs({folders:['a','b'],probe:hung.probe,timeoutMs:40});
 assert.equal(b.nextIndex,0);assert.equal(b.complete,false);assert.equal(b.stopped,'time_budget');assert.ok(performance.now()-begin<300);assert.equal(hung.active,0);assert.equal(hung.aborted,2);
});
test('same contents produce same committed pages across reversed completion timings',async()=>{
 const a=fixture([{delay:30},{delay:1},{delay:5,messages:['hit']},{delay:1}]);
 const b=fixture([{delay:1},{delay:30},{delay:1,messages:['hit']},{delay:5}]);
 const input={folders:['a','b','c','d'],timeoutMs:500};
 const [x,y]=await Promise.all([orderedFolderPairs({...input,probe:a.probe}),orderedFolderPairs({...input,probe:b.probe})]);
 assert.deepEqual(x.pages,y.pages);assert.equal(x.nextIndex,3);assert.equal(y.nextIndex,3);
});
