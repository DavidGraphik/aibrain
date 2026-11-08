export class ColdThreadRecoveryTimeoutError extends Error {
 readonly code = "COLD_THREAD_RECOVERY_TIMEOUT";
 constructor() { super("No se ha podido recuperar la conversación dentro del tiempo seguro. No se ha enviado esta petición a la IA; el historial y los adjuntos se conservan. Puedes volver a intentarlo."); }
}
/** Cold metadata callbacks and late RPC responses must share one wall-clock
 * bound. This does not authorize a new thread or a duplicate model request. */
export async function withColdThreadRecoveryDeadline<T>(operation:()=>Promise<T>,onExpired:()=>void,timeoutMs=90_000,signal?:AbortSignal):Promise<T> {
 let timer:ReturnType<typeof setTimeout>|undefined;
 let abort=()=>{};
 const deadline=new Promise<never>((_resolve,reject)=>{
  abort=()=>{onExpired();reject(signal?.reason ?? new DOMException("Conversation recovery cancelled.","AbortError"));};
  if(signal?.aborted){abort();return;}
  signal?.addEventListener("abort",abort,{once:true});
  timer=setTimeout(()=>{onExpired();reject(new ColdThreadRecoveryTimeoutError());},timeoutMs);timer.unref?.();
 });
 try{return await Promise.race([Promise.resolve().then(()=>{signal?.throwIfAborted();return operation();}),deadline]);}
 finally{if(timer)clearTimeout(timer);signal?.removeEventListener("abort",abort);}
}
