export function validateRoutedAnalysis(job,input,text){
 if(!['email-event-router','sibema-event-router'].includes(job))return;
 const marker=job==='email-event-router'?'MAIL_BATCH_JSON':'SIBEMA_BATCH_JSON';
 const index=input.lastIndexOf('\n'+marker+'\n');if(index<0)throw Error('AUTOMATION_SOURCE_BATCH_MISSING');
 const batch=JSON.parse(input.slice(index+marker.length+2).trim());
 const ids=(batch.messages??batch.events??[]).map(x=>x.snapshot_id).sort();
 let result;for(const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)){try{const x=JSON.parse(m[1]);if(Array.isArray(x.results)){result=x;break;}}catch{}}
 if(!result){try{result=JSON.parse(text);}catch{}}
 const returned=result?.results?.map(x=>x.snapshot_id).sort(),processed=result?.processed_snapshot_ids?.toSorted();
 if(!ids.length||JSON.stringify(returned)!==JSON.stringify(ids)||JSON.stringify(processed)!==JSON.stringify(ids)||result.processed_count!==ids.length||result.external_action_executed!==false)throw Error('AUTOMATION_SOURCE_COVERAGE_MISMATCH');
 for(const r of result.results){if(typeof r.notify_now!=='boolean')throw Error('AUTOMATION_NOTIFICATION_DECISION_MISSING');if(job==='email-event-router'&&(!Array.isArray(r.activated_workflows)||!Array.isArray(r.routed_tasks)||!Array.isArray(r.alerts)))throw Error('AUTOMATION_MAIL_CONTRACT_MISSING');}
}
