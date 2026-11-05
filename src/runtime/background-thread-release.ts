import { AppServerRequestTimeoutError, AppServerRpcResponseError } from './transport/app-server-rpc-router';
import type { AppServerRequest, AppServerTransport, JsonValue, TransportHealth } from './transport/contracts';

type ReleaseClient = {
  request(method:'thread/unsubscribe',params:{threadId:string},purpose:string,timeoutMs:number):Promise<JsonValue>;
  handle?: {installationId:string;userId:string;workerId:string;transport:AppServerTransport};
};
const RELEASE_RPC_MS=5_000;
const valid=(result:unknown):result is {status:string}=>Boolean(result&&typeof result==='object'&&'status'in result&&['unsubscribed','notLoaded','notSubscribed'].includes(String(result.status)));
const scoped=(health:TransportHealth|null):health is TransportHealth&{sessionId:string;connectionId:string}=>Boolean(health?.healthy&&health.state==='connected'&&health.sessionId&&health.connectionId);

/** Release once. A timed-out RPC is not resent: recover its exact durable ACK
 * only within another bounded read window and the caller's existing deadline. */
export async function releaseBackgroundThread(input:{client:ReleaseClient;threadId:string;purpose:string;signal:AbortSignal;onRecovered?:()=>void}) {
  const {client,threadId,purpose,signal}=input;
  const transport=client.handle?.transport;
  const identity=client.handle?[client.handle.installationId,client.handle.userId,client.handle.workerId]:null;
  const before=transport?await transport.health().catch(()=>null):null;
  let result:unknown;
  try { result=await client.request('thread/unsubscribe',{threadId},purpose,RELEASE_RPC_MS); }
  catch(error){
    if(!(error instanceof AppServerRequestTimeoutError)||error.method!=='thread/unsubscribe'||error.requestId!==purpose||
       !error.lateResponse||!transport?.recoverResponse||!scoped(before)||!identity)throw error;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const aborted=()=>signal.reason instanceof Error?signal.reason:Error('BACKGROUND_THREAD_RELEASE_ABORTED');
    let rejectAbort!:(reason:unknown)=>void;
    const deadline=new Promise<never>((_resolve,reject)=>{
      rejectAbort=reject;timer=setTimeout(()=>reject(error),RELEASE_RPC_MS);timer.unref?.();
    });
    const abort=()=>rejectAbort(aborted());signal.addEventListener('abort',abort,{once:true});
    const assertScope=async()=>{
      signal.throwIfAborted();const current=await transport.health();
      if(!scoped(current)||current.endpoint!==before.endpoint||current.sessionId!==before.sessionId||current.connectionId!==before.connectionId||
        client.handle?.transport!==transport||JSON.stringify(identity)!==JSON.stringify(client.handle?[client.handle.installationId,client.handle.userId,client.handle.workerId]:null))throw Error('BACKGROUND_THREAD_RELEASE_SCOPE_CHANGED');
    };
    try{
      result=await Promise.race([(async()=>{
        await assertScope();
        const late=await error.lateResponse;
        await assertScope();
        const request:AppServerRequest={clientRequestId:purpose,kind:'rpc-request',rpc:{method:'thread/unsubscribe',id:purpose,params:{threadId}}};
        // The user-local gateway ledger verifies the canonical request hash,
        // including the original thread. No new request or inference is sent.
        const receipt=await transport.recoverResponse!(request);
        await assertScope();
        if(!receipt||receipt.id!==purpose)throw Error('BACKGROUND_THREAD_RELEASE_RECEIPT_INVALID');
        if('error'in receipt)throw new AppServerRpcResponseError('thread/unsubscribe',receipt.id,receipt.error);
        if(!valid(receipt.result)||JSON.stringify(receipt.result)!==JSON.stringify(late))throw Error('BACKGROUND_THREAD_RELEASE_RECEIPT_INVALID');
        return receipt.result;
      })(),deadline]);
      input.onRecovered?.();
    }finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);}
  }
  if(!valid(result))throw Error('BACKGROUND_THREAD_RELEASE_UNCONFIRMED');
}
