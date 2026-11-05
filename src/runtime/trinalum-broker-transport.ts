import {request} from 'node:http';
/** The host broker is reached over a mounted Unix socket, without exposing a port. */
export function unixBrokerFetch(socketPath:string,url:URL,init:RequestInit,options:{timeoutMs?:number;maximumBytes?:number}={}):Promise<Response> {
  const timeoutMs=options.timeoutMs??50_000;
  const maximumBytes=options.maximumBytes??2*1024*1024;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>330_000)return Promise.reject(new Error("CONNECTOR_TIMEOUT_INVALID"));
  if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>48*1024*1024)return Promise.reject(new Error("CONNECTOR_SIZE_INVALID"));
  return new Promise((resolve,reject)=>{
    const req=request({socketPath,path:url.pathname,method:init.method??'POST',headers:init.headers as Record<string,string>,timeout:timeoutMs},res=>{
      const chunks:Buffer[]=[];let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>maximumBytes){req.destroy(new Error('CONNECTOR_RESULT_TOO_LARGE'));return;}chunks.push(chunk);});
      res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode??502,headers:{'Content-Type':'application/json'}})));
      res.on('error',reject);
    });
    const abort=()=>req.destroy(new Error('CONNECTOR_ABORTED'));
    init.signal?.addEventListener('abort',abort,{once:true});
    req.on('close',()=>init.signal?.removeEventListener('abort',abort));
    req.on('timeout',()=>req.destroy(new Error('CONNECTOR_TIMEOUT')));req.on('error',reject);
    if(init.signal?.aborted){abort();return;}
    req.end(init.body);
  });
}
