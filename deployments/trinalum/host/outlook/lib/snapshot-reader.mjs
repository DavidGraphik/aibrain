import {constants} from 'node:fs';
import {open,readdir} from 'node:fs/promises';
import {basename,join} from 'node:path';

// Compatibility reader for owner-filtered historical hints. These are not live
// originals, and this reader never executes a background review or emits mail.
export async function* iterateSnapshots(directory){
 let names;try{names=await readdir(directory);}catch(error){if(error.code==='ENOENT')return;throw error;}
 const addresses=value=>{const list=Array.isArray(value)?value:Array.isArray(value?.value)?value.value:[];return list.slice(0,50).map(item=>({name:String(item?.name??'').slice(0,200),address:String(item?.address??item?.emailAddress?.address??'').toLowerCase().slice(0,320)}));};
 for(const name of names.filter(name=>/^[A-Za-z0-9_-]+\.json$/.test(name))){
  let file;try{
   file=await open(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW);const info=await file.stat();
   if(!info.isFile()||info.size>8*1024*1024)continue;
   const snapshot=JSON.parse(await file.readFile('utf8'));if(!['Inbox','SentItems'].includes(snapshot.folder))continue;
   const data=snapshot.data??{},date=new Date(data.sentDateTime??data.receivedDateTime??snapshot.fetched_at);if(!Number.isFinite(date.getTime()))continue;
   const mailbox=String(snapshot.mailbox??'').toLowerCase(),domain=mailbox.split('@')[1];
   yield {snapshotId:basename(name,'.json'),mailbox,folder:snapshot.folder,date,data,from:addresses(data.from),externalRecipients:addresses(data.toRecipients).filter(item=>item.address&&item.address.split('@')[1]!==domain),internetMessageId:String(data.internetMessageId??'')};
  }catch{/* Invalid hints cannot replace or disclose live provider content. */}finally{await file?.close();}
 }
}
