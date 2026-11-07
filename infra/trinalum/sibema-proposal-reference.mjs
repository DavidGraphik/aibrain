import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import path from 'node:path';

export function sibemaProposalReference(value){
  return typeof value==='string'&&/^\/proposals\/SIBEMA-[A-F0-9]{10}$/.test(value)?value.slice('/proposals/'.length):null;
}

export async function resolveSibemaProposal(directory,owner,reference){
  if(!['trini','miguel','nerea'].includes(owner)||!/^SIBEMA-[A-F0-9]{10}$/.test(reference))throw Error('ACCESS_DENIED');
  const root=await realpath(directory);
  const file=path.join(root,reference+'.json');
  let handle;
  try{
    handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    const meta=await handle.stat();
    if(!meta.isFile()||meta.size>131072||await realpath(file)!==file)throw Error('SIBEMA_REFERENCE_UNAVAILABLE');
    const proposal=JSON.parse(await handle.readFile('utf8'));
    if(proposal.reference!==reference||proposal.owner!==owner)throw Error('ACCESS_DENIED');
    const route=/^(order|offer)\.(created|updated)$/.exec(proposal.event_type??'');
    const id=String(proposal.object_id??'');
    if(!route||!/^\d{1,12}$/.test(id)||Number(id)<1)throw Error('SIBEMA_REFERENCE_UNAVAILABLE');
    return {reference,owner,historical_notification:true,created_at:proposal.created_at??null,
      lookup_path:`/${route[1]==='order'?'orders':'offers'}/${id}`,
      hint:'This is a historical notification locator, not an order ID or proof of current status. Read the native object and verify its contract/reference and line against the original document before preparing any action.'};
  }catch(error){
    if(error.message==='ACCESS_DENIED')throw error;
    throw Error('SIBEMA_REFERENCE_UNAVAILABLE');
  }finally{await handle?.close();}
}
