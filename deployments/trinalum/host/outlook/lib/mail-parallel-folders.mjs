// Internal bounded scheduler for separately authenticated IMAP connections.
// A speculative later folder is never committed ahead of an earlier one.
// Probe must close its connection on abort; it never returns cached messages.
export async function orderedFolderPairs({folders,start=0,probe,timeoutMs,maxFolders=30,continueOnMatches=false,maxMessages=Infinity,canContinue=()=>true}){
 if(!Array.isArray(folders)||!Number.isSafeInteger(start)||start<0||start>folders.length||typeof probe!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<=0||!Number.isSafeInteger(maxFolders)||maxFolders<1||typeof canContinue!=='function'||!(maxMessages===Infinity||Number.isSafeInteger(maxMessages)&&maxMessages>0))throw Error('Invalid parallel search plan');
 const end=Math.min(folders.length,start+maxFolders),controller=new AbortController(),result={pages:[],nextIndex:start,complete:false,stopped:null,attempted:0},begin=performance.now();
 let timer;const timeout=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({timeout:true});},timeoutMs);});
 const run=(index,slot)=>{result.attempted++;return Promise.resolve().then(()=>probe({folder:folders[index],index,slot,signal:controller.signal})).then(value=>({value}),error=>({error}));};
 try{
  while(result.nextIndex<end){
   const i=result.nextIndex,first=run(i,0),second=i+1<end?run(i+1,1):null;
   const a=await Promise.race([first,timeout]);
   if(a.timeout){result.stopped='time_budget';break;}
   if(a.error){result.stopped='folder_error';result.errorIndex=i;result.errorCode=a.error?.code;break;}
   if(!a.value||!Array.isArray(a.value.messages)||typeof a.value.exhausted!=='boolean')throw Error('Invalid parallel page');
   result.pages.push({index:i,...a.value});if(a.value.exhausted)result.nextIndex=i+1;
   if(!a.value.exhausted||a.value.messages.length&&!continueOnMatches||result.pages.reduce((sum,p)=>sum+p.messages.length,0)>=maxMessages||!canContinue()){result.stopped=a.value.messages.length?'matches_found':!a.value.exhausted?'partial_folder':'work_budget';break;}
   if(!second)continue;
   const b=await Promise.race([second,timeout]);
   if(b.timeout){result.stopped='time_budget';break;}
   if(b.error){result.stopped='folder_error';result.errorIndex=i+1;result.errorCode=b.error?.code;break;}
   if(!b.value||!Array.isArray(b.value.messages)||typeof b.value.exhausted!=='boolean')throw Error('Invalid parallel page');
   result.pages.push({index:i+1,...b.value});if(b.value.exhausted)result.nextIndex=i+2;
   if(!b.value.exhausted||b.value.messages.length&&!continueOnMatches||result.pages.reduce((sum,p)=>sum+p.messages.length,0)>=maxMessages||!canContinue()){result.stopped=b.value.messages.length?'matches_found':!b.value.exhausted?'partial_folder':'work_budget';break;}
  }
  result.complete=result.nextIndex===folders.length&&!result.stopped;
  if(!result.complete&&!result.stopped)result.stopped='work_budget';
  return {...result,elapsedMs:Math.round(performance.now()-begin)};
 }finally{clearTimeout(timer);controller.abort();}
}
