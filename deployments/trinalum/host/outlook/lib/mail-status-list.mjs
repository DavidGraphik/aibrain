// LIST-STATUS is optional. Never allow ImapFlow to fall back to one STATUS per
// folder, nor to LSUB, while probing it. Invalid/missing status is not evidence.
export async function listWithOptionalStatus(imap){
 if(!imap.capabilities?.has?.('LIST-STATUS')||typeof imap.run!=='function')return {entries:await imap.list(),statusUsed:false};
 const run=imap.run,skipLsub=imap.skipLsub;let fallbackBlocked=0;
 imap.run=async function(command,...args){if(String(command).toUpperCase()==='STATUS'){fallbackBlocked++;throw Error('STATUS fallback disabled');}return run.call(this,command,...args);};imap.skipLsub=true;
 try{return {entries:await imap.list({statusQuery:{messages:true,uidNext:true,uidValidity:true}}),statusUsed:true,fallbackBlocked};}
 finally{imap.run=run;imap.skipLsub=skipLsub;}
}
export function validFolderStatus(status){
 if(!status||typeof status!=='object')return null;
 const number=(v,positive)=>{if(typeof v==='bigint')return v>=(positive?1n:0n)?String(v):null;if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=(positive?1:0))return String(v);return null;};
 const uidNext=number(status.uidNext,true),uidValidity=number(status.uidValidity,true),messages=number(status.messages,false);
 return uidNext&&uidValidity&&messages!==null?{uidNext,uidValidity,messages}:null;
}
