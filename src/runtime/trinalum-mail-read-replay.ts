import type { DynamicToolCallResponse } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallResponse";

const denied = (error = "TURN_ACCESS_DENIED"): DynamicToolCallResponse => ({success:false,contentItems:[{type:"inputText",text:JSON.stringify({error})}]});
const object = (v:unknown):v is Record<string,unknown> => Boolean(v&&typeof v==='object'&&!Array.isArray(v));
type Entry = {pending:Promise<DynamicToolCallResponse>|null;snapshot?:string;completedAt?:string;validResult?:boolean;bytes:number;epoch:number};

/** Constructed inside one worker turn. No global state, disk, provider calls or cursor advancement. */
export class TrinalumMailReadTurnReplay {
  private scope:string|null=null;
  private readonly entries=new Map<string,Entry>();
  private bytes=0;
  private epoch=0;
  private blocked=false;
  invalidate(){this.entries.clear();this.bytes=0;this.epoch++;}

  async run(scope:string,key:string,kind:'search'|'folders',read:()=>Promise<DynamicToolCallResponse>,authorizeReplay:()=>Promise<boolean>):Promise<DynamicToolCallResponse>{
    if(this.blocked||!scope||this.scope!==null&&this.scope!==scope)return denied();
    this.scope=scope;
    const previous=this.entries.get(key);
    if(previous){
      const result=previous.pending?await previous.pending:JSON.parse(previous.snapshot!) as DynamicToolCallResponse;
      if(previous.epoch!==this.epoch)return denied('MAIL_READ_REPLAY_INVALIDATED');
      let allowed=false;try{allowed=await authorizeReplay();}catch{/* Missing current authority fails closed. */}
      if(!allowed){this.blocked=true;this.invalidate();return denied();}
      if(previous.epoch!==this.epoch)return denied('MAIL_READ_REPLAY_INVALIDATED');
      // Coalesced failures/partial errors are shared as the original result,
      // never described as a valid reused page and never retained for later reads.
      if(!previous.validResult)return structuredClone(result);
      // Return the same page/listing, never the next cursor or a claim of a fresh provider read.
      const copy=structuredClone(result);
      const text=copy.contentItems.length===1&&copy.contentItems[0].type==='inputText'?copy.contentItems[0]:null;
      if(text){
        const body=JSON.parse(text.text) as Record<string,unknown>;
        const warning=kind==='search'
          ? 'Repeated identical search in this same authenticated turn. This is the SAME previously returned page, not a fresh provider read. Keep the literal query and use the cursor from the latest page you have already examined; do not restart. No cursor was advanced or result omitted.'
          : 'Repeated identical folder listing in this same authenticated turn. This is the same previously returned listing, not a fresh provider read. Use its known folder IDs or the exact saved draft messageId; do not list every folder again.';
        // Put this notice before a potentially large folder listing so output
        // truncation cannot hide that no fresh provider read occurred. All
        // original data, including warnings/coverage/cursor, remains unchanged.
        const original=Object.fromEntries(Object.entries(body).filter(([key])=>!['mailReadReplay','replayInstruction'].includes(key)));
        text.text=JSON.stringify({mailReadReplay:{sameAuthenticatedTurn:true,providerReadPerformed:false,originalReadCompletedAt:previous.completedAt,coverageUnchanged:true,cursorUnchanged:true,kind},replayInstruction:warning,...original});
      }
      return copy;
    }
    // These are memory admission bounds, never new request/provider limits.
    if(this.entries.size>=16)return read();
    const entry:Entry={pending:null,bytes:0,epoch:this.epoch};
    const pending=Promise.resolve().then(read).then(result=>{
      entry.completedAt=new Date().toISOString();
      const snapshot=cacheableSnapshot(result,kind),size=snapshot?Buffer.byteLength(snapshot):0;
      entry.validResult=snapshot!==null;
      if(entry.epoch===this.epoch&&snapshot&&size<=512*1024&&this.bytes+size<=2*1024*1024){entry.snapshot=snapshot;entry.bytes=size;this.bytes+=size;}
      else if(this.entries.get(key)===entry)this.entries.delete(key);
      entry.pending=null;
      return result;
    },error=>{if(this.entries.get(key)===entry)this.entries.delete(key);entry.pending=null;throw error;});
    entry.pending=pending;this.entries.set(key,entry);
    return pending;
  }
}

function cacheableSnapshot(result:DynamicToolCallResponse,kind:'search'|'folders'){
  if(!result.success||result.contentItems.length!==1||result.contentItems[0].type!=='inputText')return null;
  try{
    const body:unknown=JSON.parse(result.contentItems[0].text);
    if(!object(body)||body.error)return null;
    const data=object(body.data)?body.data:body;
    if(data.error||body.success===false||data.success===false||body.status==='error'||data.status==='error'||Array.isArray(data.errors)&&data.errors.length||object(data.coverage)&&Array.isArray(data.coverage.errors)&&data.coverage.errors.length)return null;
    if(kind==='folders')return Array.isArray(data.folders)?JSON.stringify(result):null;
    if(!Array.isArray(data.messages)||typeof data.complete!=='boolean'||!(data.cursor===null||typeof data.cursor==='string')||!object(data.coverage)||!Array.isArray(data.coverage.errors)||data.coverage.errors.length)return null;
    return JSON.stringify(result);
  }catch{return null;}
}
