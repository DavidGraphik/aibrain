import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Agent, createServer as httpsServer } from "node:https";
import { createServer as httpServer } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSageServerFetch } from "./g03-sage-transport";
const token="server-channel-"+"s".repeat(40);
const env={AIBRAIN_EGRESS_PROXY_URL:"http://egress-gateway:8080",AIBRAIN_EGRESS_SERVER_TOKEN:token,AIBRAIN_EGRESS_WORKER_TOKEN:"unused-worker",AIBRAIN_EGRESS_BROWSER_TOKEN:"unused-browser"};
let temp:string,cert:Buffer,proxyPort:number,securePort:number;
let upstream:ReturnType<typeof httpsServer>,proxy:ReturnType<typeof httpServer>;
const sockets=new Set<Socket>();
let tunnels:{authority:string;authorization:string;method:string}[]=[];
let requests:{authorization:string|undefined;proxyAuthorization:string|undefined;body:string}[]=[];
let mode:"ok"|"deny"|"large"|"redirect"|"hang"="ok";
function port(server:ReturnType<typeof httpServer>){const a=server.address();if(!a||typeof a==='string')throw Error('no port');return a.port;}
function track(socket:Socket){sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));}
beforeAll(async()=>{
 temp=await mkdtemp(path.join(tmpdir(),"sage-proxy-test-"));
 execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",path.join(temp,"key.pem"),"-out",path.join(temp,"cert.pem"),"-subj","/CN=sage.example.test","-addext","subjectAltName=DNS:sage.example.test","-days","1"],{stdio:"ignore"});
 cert=await readFile(path.join(temp,"cert.pem"));const key=await readFile(path.join(temp,"key.pem"));
 upstream=httpsServer({key,cert},(req,res)=>{let body="";req.on('data',c=>body+=c);req.on('end',()=>{
  requests.push({authorization:req.headers.authorization,proxyAuthorization:req.headers['proxy-authorization'] as string|undefined,body});
  if(mode==='large'){res.setHeader('content-length',1048577);res.end('x'.repeat(1048577));}
  else if(mode==='redirect'){res.writeHead(302,{location:'https://outside.example.test/secret'});res.end();}
  else{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true}));}
 });});upstream.on('connection',track);upstream.on('tlsClientError',()=>{});
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));securePort=port(upstream);
 proxy=httpServer((_req,res)=>{res.writeHead(403);res.end();});proxy.on('connection',track);
 proxy.on('connect',(req,client,head)=>{
  tunnels.push({authority:req.url??'',authorization:String(req.headers['proxy-authorization']??''),method:req.method??''});
  if(mode==='deny'){client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');return;}
  if(mode==='hang')return;
  const destination=connect({host:'127.0.0.1',port:securePort},()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)destination.write(head);client.pipe(destination);destination.pipe(client);});
  track(destination);client.once('close',()=>destination.destroy());destination.once('close',()=>client.destroy());
 });await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));proxyPort=port(proxy);
});
beforeEach(()=>{mode='ok';tunnels=[];requests=[];});
afterAll(async()=>{for(const socket of sockets)socket.destroy();await Promise.all([new Promise<void>(resolve=>proxy.close(()=>resolve())),new Promise<void>(resolve=>upstream.close(()=>resolve()))]);await rm(temp,{recursive:true,force:true});});
function transport(trust=true){return createSageServerFetch(env,options=>{
 expect(options).toMatchObject({rejectUnauthorized:true,minVersion:'TLSv1.2',maxCachedSessions:0});
 expect(options.proxyEnv?.HTTPS_PROXY).toBe(`http://aibrain:${token}@egress-gateway:8080/`);
 const url=`http://aibrain:${token}@127.0.0.1:${proxyPort}`;
 return new Agent({...options,...(trust?{ca:cert}:{}),proxyEnv:{NODE_ENV:"test",HTTPS_PROXY:url,https_proxy:url,NO_PROXY:'',no_proxy:''}});
});}
const target='https://sage.example.test/api/auth/Login';
const init={method:'POST',redirect:'error' as const,headers:{'Content-Type':'application/json',Authorization:'Bearer private-provider-token'},body:JSON.stringify({password:'private-provider-password'})};
it('uses authenticated CONNECT without local target DNS and keeps provider secrets inside verified TLS',async()=>{
 const response=await transport()(target,init);expect(await response.json()).toEqual({ok:true});
 expect(tunnels).toEqual([{authority:'sage.example.test:443',method:'CONNECT',authorization:'Basic '+Buffer.from('aibrain:'+token).toString('base64')}]);
 expect(JSON.stringify(tunnels)).not.toMatch(/private-provider|unused-worker|unused-browser/);
 expect(requests).toEqual([{authorization:'Bearer private-provider-token',proxyAuthorization:undefined,body:init.body}]);
});
it('retains certificate and hostname verification',async()=>{
 await expect(transport(false)(target,init)).rejects.toThrow('SAGE_EGRESS_UNAVAILABLE');expect(requests).toHaveLength(0);
 await expect(transport()('https://wrong.example.test/api/auth/Login',init)).rejects.toThrow('SAGE_EGRESS_UNAVAILABLE');expect(requests).toHaveLength(0);
});
it('fails closed on proxy denial with no direct fallback',async()=>{
 mode='deny';await expect(transport()(target,init)).rejects.toThrow('SAGE_EGRESS_UNAVAILABLE');expect(tunnels).toHaveLength(1);expect(requests).toHaveLength(0);
});
it('bounds response bytes and never follows redirects',async()=>{
 mode='large';await expect(transport()(target,init)).rejects.toThrow('SAGE_EGRESS_UNAVAILABLE');
 mode='redirect';expect((await transport()(target,init)).status).toBe(302);expect(requests).toHaveLength(2);
});
it('aborts a pending tunnel',async()=>{
 mode='hang';const controller=new AbortController();const pending=transport()(target,{...init,signal:controller.signal});setTimeout(()=>controller.abort(),30);await expect(pending).rejects.toThrow('SAGE_EGRESS_UNAVAILABLE');expect(requests).toHaveLength(0);
});
it.each([
 {...env,AIBRAIN_EGRESS_SERVER_TOKEN:''},{...env,AIBRAIN_EGRESS_PROXY_URL:'http://127.0.0.1:8080'},
 {...env,AIBRAIN_EGRESS_PROXY_URL:'http://aibrain:secret@egress-gateway:8080'},
 {...env,AIBRAIN_EGRESS_PROXY_URL:'http://egress-gateway:8080/?bypass=1'},
])('requires the existing backend-only channel, never worker/browser tokens',async invalid=>{
 const factory=vi.fn(()=>new Agent());await expect(createSageServerFetch(invalid,factory)(target,init)).rejects.toThrow('SAGE_EGRESS_UNAVAILABLE');expect(factory).not.toHaveBeenCalled();
});
it.each([
 ['http://sage.example.test/api/auth/Login',init],['https://sage.example.test:8443/api/auth/Login',init],
 ['https://sage.example.test/api/PutData',init],[target,{...init,method:'GET'}],
 [target,{...init,headers:{...init.headers,'Proxy-Authorization':'private'}}],
])('rejects transport/routing overrides before opening a tunnel',async(url,options)=>{
 const factory=vi.fn(()=>new Agent());await expect(createSageServerFetch(env,factory)(url,options)).rejects.toThrow('SAGE_EGRESS_UNAVAILABLE');expect(factory).not.toHaveBeenCalled();
});

 it('keeps IME dispatch alive past the read deadline but still aborts it once at sixty seconds',async()=>{
 mode='hang';vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 try {
  let readTimedOut=false,writeTimedOut=false;
  const read=transport()(target,init).catch(error=>{expect(error.message).toBe('SAGE_EGRESS_UNAVAILABLE');readTimedOut=true;});
  const write=transport()('https://sage.example.test/api/PutData/InsertData',init).catch(error=>{expect(error.message).toBe('SAGE_EGRESS_UNAVAILABLE');writeTimedOut=true;});
  await vi.advanceTimersByTimeAsync(15_000);expect(readTimedOut).toBe(true);expect(writeTimedOut).toBe(false);
  await vi.advanceTimersByTimeAsync(45_000);expect(writeTimedOut).toBe(true);await Promise.all([read,write]);
  expect(requests).toHaveLength(0);
 } finally {vi.useRealTimers();}
 });
